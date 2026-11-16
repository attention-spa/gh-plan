import { preflightApplyPlan } from "./apply-preflight.ts";
import { bindPlanRequest } from "./plan-bindings.ts";
import { acquireGithubCasLock, createGithubCasHttpBackend } from "./github-cas-lock.ts";
import { createRestIssuePostconditionReader, IssueReadError } from "./apply-issue-reader.ts";
import { createRestMilestonePostconditionReader } from "./apply-milestone-reader.ts";
import { createGithubReferenceHttp, GithubReferenceError } from "./github-reference-http.ts";
import { GITHUB_REST_API_VERSION } from "./rest.ts";
import type { ApplyPlanOptions, ApplyLogSink, ApplyPostconditionRead } from "./apply-contract.ts";
import type { ApplyPostconditionSpec } from "./apply-preflight.ts";
import type { GithubCasLockHandle } from "./github-cas-lock.ts";
import type { IssueBeforeRead } from "./apply-issue-reader.ts";
import type { MilestoneBeforeRead } from "./apply-milestone-reader.ts";
import type { ReferenceHttpOptions } from "./github-reference-http.ts";
import type { BoundPlanRequest } from "./plan-bindings.ts";
import type { GithubPlan, PlanBindings, PlanStep } from "./types.ts";

/**
 * INTERNAL, separately selected GitHub reference callbacks (#189).
 * Factory produces the C2 options for #188's internal executor; NO public
 * applyPlan() export, implicit write transport, auto-recovery or production
 * authorization is created by importing the module.
 *
 * The real A1 CAS owner and authoritative B1 readers are reused; all network
 * requests share a fixed-origin allowlisted, throttled transport. One instance
 * must not be shared across unrelated concurrent apply runs.
 */
export interface GithubReferenceApplyConfig {
  plan: GithubPlan;
  /** Runtime bearer, ideally a short-lived GitHub App installation token. */
  auth: string;
  /** Must persist every C2 audit event before resolving, not just print it. */
  onLog: ApplyLogSink;
  /** Deterministic testing hooks only, not public package entrypoint options. */
  fetch?: ReferenceHttpOptions["fetch"];
  now?: ReferenceHttpOptions["now"];
  sleep?: ReferenceHttpOptions["sleep"];
  signal?: AbortSignal;
}
const BASE = "https://api.github.com";
const POSITIVE = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reject(): never { throw new GithubReferenceError("UNSAFE_REQUEST"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value)) return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function identity(raw: unknown): { number: number; id: number; nodeId: string } {
  if (!record(raw) || !POSITIVE(raw.number) || !POSITIVE(raw.id) ||
      typeof raw.node_id !== "string" || !raw.node_id)
    return reject();
  return { number: raw.number, id: raw.id, nodeId: raw.node_id };
}
function resultOf(
  read: { status: "satisfied" | "unsatisfied";
    snapshot?: { number: number; id: number; nodeId: string } },
): ApplyPostconditionRead {
  if (read.status === "unsatisfied") return { status: "unsatisfied" };
  if (!read.snapshot) reject();
  return { status: "satisfied", identity: {
    number: read.snapshot.number, id: read.snapshot.id, nodeId: read.snapshot.nodeId,
  } };
}
function cloned<T>(value: T): T {
  try { return structuredClone(value) as T; }
  catch { return reject(); }
}
function needPush(plan: GithubPlan): boolean {
  return plan.steps.some((step) => step.kind === "issue.create" &&
    step.request?.protocol === "rest" && record(step.request.body) &&
    Object.hasOwn(step.request.body, "milestone"));
}
function strictSupersession(plan: GithubPlan,
  spec: ApplyPostconditionSpec): ApplyPostconditionSpec | undefined {
  if (spec.kind !== "issue.create" ||
      !spec.predicates.some((p) => p.field === "state" &&
        p.comparison === "exact" && p.expected === "open"))
    return undefined;
  const dependents = plan.steps.filter((step) =>
    step.kind === "issue.update" && step.logicalId ===
      plan.steps.find((entry) => entry.id === spec.stepId)?.logicalId &&
    step.dependsOn.includes(spec.stepId) &&
    step.request?.protocol === "rest" &&
    record(step.request.body) &&
    (step.request.body as Record<string, unknown>).state === "closed");
  if (dependents.length !== 1) return undefined;
  return { ...spec, predicates: spec.predicates.map((p) =>
    p.field === "state" && p.comparison === "exact" && p.expected === "open"
      ? { ...p, expected: "closed" } : { ...p }) };
}
type Before =
  | { kind: "issue"; spec: ApplyPostconditionSpec; result: IssueBeforeRead }
  | { kind: "milestone"; spec: ApplyPostconditionSpec; result: MilestoneBeforeRead };

export function createGithubReferenceApplyOptions(config: GithubReferenceApplyConfig):
  ApplyPlanOptions {
  if (!config || typeof config.auth !== "string" || !config.auth.trim() ||
      typeof config.onLog !== "function")
    throw new GithubReferenceError("INVALID_CONFIG");
  const plan = cloned(config.plan);
  const preflight = preflightApplyPlan(plan);
  if (!preflight.ok) throw new GithubReferenceError("INVALID_CONFIG");
  const fixed = cloned(plan);
  const specs = new Map(preflight.postconditions.map((spec) => [spec.stepId, spec]));
  const steps = new Map(fixed.steps.map((step) => [step.id, step]));
  const transport = createGithubReferenceHttp({
    repository: fixed.repository, auth: config.auth,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
    // Intentionally NO signal here: abort during an in-flight mutation must
    // still allow definitive GitHub readback and conditional lock release.
  });
  const backend = createGithubCasHttpBackend({ auth: config.auth, fetch: transport.fetch });
  const issues = createRestIssuePostconditionReader({
    auth: config.auth, fetch: transport.fetch,
  });
  const milestones = createRestMilestonePostconditionReader({
    auth: config.auth, fetch: transport.fetch,
  });
  const readBefore = new Map<string, Before>();
  const seenBefore = new Map<string, { request: string; bindings: PlanBindings;
    unsatisfied: boolean }>();
  const dispatched = new Set<string>();
  let handle: GithubCasLockHandle | undefined;
  let attemptedOwner = false;
  let active = false;
  const repo = fixed.repository.fullName;
  function checkedStep(step: Readonly<PlanStep>,
    request: Readonly<BoundPlanRequest>, spec: Readonly<ApplyPostconditionSpec>): void {
    const original = steps.get(step.id);
    if (!original || !specs.has(step.id) ||
        canonical(original) !== canonical(step) ||
        canonical(specs.get(step.id)) !== canonical(spec) ||
        request.protocol !== "rest" || step.request?.protocol !== "rest")
      reject();
  }

  const ownership: ApplyPlanOptions["ownership"] = {
    async acquire(repository) {
      if (repository !== repo || active || attemptedOwner) reject();
      attemptedOwner = true; // Lost CAS reply cannot authorize another try.
      await transport.assertRepository(needPush(fixed));
      const acquired = await acquireGithubCasLock({
        repository: fixed.repository,
        runId: crypto.randomUUID(),
        backend,
        // No AbortSignal: #188 separately handles abort; readback after an
        // in-flight request cannot be abandoned safely by transport abort.
      });
      handle = acquired;
      active = true;
      return { ownerId: acquired.ownerOid };
    },
    async assertOwned(repository, ownerId) {
      if (!active || !handle || repository !== repo ||
          handle.ownerOid !== ownerId) return false;
      await handle.assertOwned();
      return true;
    },
    async release(repository, ownerId) {
      if (!active || !handle || repository !== repo ||
          handle.ownerOid !== ownerId) reject();
      await handle.release();
      active = false;
      handle = undefined;
    },
  };

  const readPostcondition: ApplyPlanOptions["readPostcondition"] =
    async (context) => {
      const step = context.step;
      const spec = context.spec;
      const original = specs.get(step.id);
      if (!original) reject();
      checkedStep(step, context.request, original);
      const variant = strictSupersession(fixed, original);
      const isAlternate = variant !== undefined &&
        canonical(variant) === canonical(spec);
      if (canonical(original) !== canonical(spec) && !isAlternate) reject();
      if (!active || !handle) reject();
      // Check before every independent postcondition read, including replays.
      await handle.assertOwned();
      if (context.phase === "before") {
        const bound = bindPlanRequest(step.request!, context.bindings);
        if (canonical(bound) !== canonical(context.request)) reject();
        let value: ApplyPostconditionRead;
        if (spec.kind.startsWith("issue")) {
          try {
            const found = await issues.readBefore(spec, { bindings: context.bindings });
            value = resultOf(found);
            if (!isAlternate) readBefore.set(step.id, {
              kind: "issue", spec: original, result: found,
            });
          } catch (error) {
            if (!(error instanceof IssueReadError) ||
                error.code !== "POSTCONDITION_MISMATCH" ||
                !variant || isAlternate) throw error;
            // Special create→close replay: the core must independently rerun
            // an exact "closed" spec before accepting a verified skip.
            value = { status: "unsatisfied" };
          }
        } else {
          const found = await milestones.readBefore(spec);
          value = resultOf(found);
          if (!isAlternate) readBefore.set(step.id, {
            kind: "milestone", spec: original, result: found,
          });
        }
        if (!isAlternate) seenBefore.set(step.id, {
          request: canonical(context.request), bindings: cloned(context.bindings),
          unsatisfied: value.status === "unsatisfied",
        });
        return value;
      }
      if (context.phase !== "after" || isAlternate) reject();
      const prior = readBefore.get(step.id);
      const pinned = seenBefore.get(step.id);
      if (!prior || !pinned || !pinned.unsatisfied ||
          pinned.request !== canonical(context.request) ||
          canonical(pinned.bindings) !== canonical(context.bindings) ||
          !dispatched.has(step.id)) reject();
      if (prior.kind === "issue") {
        const verified = await issues.readAfter(spec, prior.result,
          context.responseIdentity);
        return { status: "satisfied", identity: verified.identity };
      }
      const verified = await milestones.readAfter(spec, prior.result,
        context.responseIdentity);
      return { status: "satisfied", identity: verified.identity };
    };
  const dispatch: ApplyPlanOptions["dispatch"] = async (request, step) => {
    const spec = specs.get(step.id);
    if (!spec) reject();
    checkedStep(step, request, spec);
    const before = seenBefore.get(step.id);
    if (!active || !handle || !before || !before.unsatisfied ||
        before.request !== canonical(request) || dispatched.has(step.id))
      reject();
    const expected = bindPlanRequest(step.request!, before.bindings);
    if (canonical(request) !== canonical(expected) || request.protocol !== "rest" ||
        request.method !== spec.method ||
        request.method !== (step.kind.endsWith(".create") ? "POST" : "PATCH"))
      reject();
    const base = "/repos/" + repo;
    const collection = step.kind.startsWith("issue") ? "issues" : "milestones";
    const path = base + "/" + collection;
    if (step.kind.endsWith(".create") ? request.path !== path :
        !request.path.startsWith(path + "/") ||
        !/^[1-9]\d*$/.test(request.path.slice((path + "/").length)))
      reject();
    if (!record(request.body) ||
        Object.keys(request.body).some((key) =>
          !(collection === "issues" ?
            ["title", "body", "state", "milestone"] :
            ["title", "description", "state", "due_on"]).includes(key)))
      reject();
    dispatched.add(step.id); // Mark BEFORE dispatch, including lost responses.
    const body = JSON.stringify(request.body);
    const url = BASE + request.path;
    return handle.guardResourceMutation(async () => {
      const response = await transport.fetch(url, {
        method: request.method, redirect: "error",
        headers: {
          Authorization: "Bearer " + config.auth,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
          "Content-Type": "application/json",
        },
        body,
      });
      let raw: unknown;
      try { raw = await response.json(); }
      catch { return reject(); }
      const found = identity(raw);
      if (step.kind.endsWith(".update") &&
          found.number !== Number(request.path.slice((path + "/").length)))
        reject();
      return step.kind.endsWith(".create")
        ? { number: found.number, id: found.id, node_id: found.nodeId }
        : {};
    });
  };

  return Object.freeze({
    plan: fixed, dispatch, readPostcondition,
    readIssueCatalog: async (name: string) => {
      if (name !== repo || !active || !handle) reject();
      await handle.assertOwned();
      return transport.issuesCatalog();
    },
    readMilestoneCatalog: async (name: string) => {
      if (name !== repo || !active || !handle) reject();
      await handle.assertOwned();
      return transport.milestonesCatalog();
    },
    ownership, acknowledgeCallbackTrust: true as const,
    onLog: config.onLog,
    ...(config.signal === undefined ? {} : { signal: config.signal }),
  });
}
