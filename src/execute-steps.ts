import { bindPlanRequest, validatePlanStepReferences } from "./plan-bindings.ts";
import { matchesMarker } from "./identity.ts";
import type { BoundPlanRequest } from "./plan-bindings.ts";
import type { GithubPlan, ObservedIssue, PlanBindings, PlanStep } from "./types.ts";

/**
 * Internal M8 execution primitive. Deliberately not exported from the package
 * entrypoint until recovery, verification and failure reporting land.
 * The caller supplies a dispatcher and fresh read transport that reject failed
 * responses. The planner itself remains strictly read-only.
 */
export type PlanStepDispatcher = (
  request: BoundPlanRequest, step: Readonly<PlanStep>,
) => Promise<unknown>;

/**
 * A fresh, authoritative postcondition read immediately before each step.
 * "satisfied" means *all* postconditions for this step were independently
 * observed on GitHub. Skipped producer steps must include the observed
 * resource identity (number/id/nodeId) for later late binding.
 *
 * The injected reader must NOT rely on the planner's original snapshot.
 * A failed or uncertain read must throw rather than return "unsatisfied".
 */
export type PlanStepPostcondition =
  | { status: "satisfied"; identity?: unknown }
  | { status: "unsatisfied" };

export type PlanStepPostconditionReader = (
  step: Readonly<PlanStep>,
  request: Readonly<BoundPlanRequest>,
  bindings: Readonly<PlanBindings>,
) => Promise<PlanStepPostcondition>;

/**
 * Must reread the complete, paginated catalog of open AND closed repository
 * issues, excluding pull requests, on EVERY planned issue.create. Use
 * createRestIssueCatalogReader() for the reference GET implementation.
 * Partial catalogs, caches, stale planning snapshots or title-only matches
 * are unsafe. This callback may throw on a failed/incomplete read.
 */
export type PlanIssueCatalogReader = (
  repositoryFullName: string,
) => Promise<readonly ObservedIssue[]>;

/** Stable, allowlisted phases; the log never contains HTTP data or error text. */
export type PlanExecutionPhase =
  | "binding" | "precondition" | "recovery" | "dispatch" | "verification" | "logging";

/**
 * Secret-free apply record. The 0-based position identifies the step in
 * dependency order; no request bodies, paths, resource names, token-bearing
 * errors, or other caller-controlled strings appear in the log.
 */
export interface PlanApplyLogEntry {
  stepIndex: number;
  outcome: "skipped" | "applied" | "failed";
  phase: PlanExecutionPhase;
}

/** Optional async append-only sink; called after each resolved step or failure. */
export type PlanApplyLogSink = (entry: Readonly<PlanApplyLogEntry>) => void | Promise<void>;

/**
 * Sanitized failure: deliberately discards arbitrary transport/error messages
 * and response payloads. A caller can inspect the partial safe log and stage.
 */
export class PlanExecutionError extends Error {
  readonly code = "PLAN_STEP_FAILED" as const;
  readonly stepIndex: number;
  readonly phase: PlanExecutionPhase;
  readonly log: PlanApplyLogEntry[];

  constructor(stepIndex: number, phase: PlanExecutionPhase, log: readonly PlanApplyLogEntry[]) {
    super("Plan execution failed; no further steps were dispatched.");
    this.name = "PlanExecutionError";
    this.stepIndex = stepIndex;
    this.phase = phase;
    this.log = log.map((entry) => ({ ...entry }));
  }
}

export interface PlanStepExecution {
  /** All resolved steps, including those already satisfied and skipped. */
  completedStepIds: string[];
  /** Steps for which the fresh postcondition read confirmed no write was needed. */
  skippedStepIds: string[];
  /** Verified, secret-free apply decisions in dependency order. */
  log: PlanApplyLogEntry[];
  /** Only public resource IDs from create responses or verified reads. */
  bindings: PlanBindings;
}

const PRODUCERS = new Set<PlanStep["kind"]>([
  "issue.create", "milestone.create", "pull_request.create", "project.item.add",
]);

function orderedSteps(plan: GithubPlan): PlanStep[] {
  if (plan.readiness === "blocked" || plan.blockers.some((item) => item.blocking)) {
    throw new Error("Cannot execute a blocked plan.");
  }
  const byId = new Map<string, PlanStep>();
  for (const step of plan.steps) {
    if (byId.has(step.id)) throw new Error("Duplicate plan step: " + step.id);
    if (step.status !== "planned" || !step.request) {
      throw new Error("Incomplete planned request at " + step.id + ".");
    }
    byId.set(step.id, step);
  }
  if (validatePlanStepReferences(plan.steps).length) {
    throw new Error("Plan contains unresolved or invalid request references.");
  }
  const ordered: PlanStep[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) throw new Error("Missing plan dependency: " + id);
    if (visiting.has(id)) throw new Error("Cyclic plan dependency: " + id);
    visiting.add(id);
    for (const dependency of [...step.dependsOn].sort()) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(step);
  }
  for (const id of [...byId.keys()].sort()) visit(id);
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Verify compiled create marker before any write, including earlier steps. */
function createMarker(plan: GithubPlan, step: PlanStep): { marker: string; custom: boolean } {
  const request = step.request;
  const canonical = "<!-- gh-plan:" + step.logicalId + " -->";
  const identity = plan.resolutions.find((r) =>
    r.kind === "issue" && r.logicalId === step.logicalId)?.identity;
  const marker = identity?.marker ?? canonical;
  const custom = marker !== canonical;
  if (request?.protocol !== "rest" || request.method !== "POST" ||
      !request.path || typeof request.path !== "string" ||
      !request.path.endsWith("/issues") || !isRecord(request.body) ||
      !matchesMarker((request.body as Record<string, unknown>)["body"] as string | undefined, marker, custom)) {
    throw new Error("Issue create lacks a valid identity marker.");
  }
  return { marker, custom };
}

/** A single marker match is recoverable; a conflict must never create again. */
function matchingIssue(
  catalog: unknown,
  marker: string,
  custom: boolean,
): ObservedIssue | undefined {
  if (!Array.isArray(catalog) || !catalog.every((candidate: unknown) =>
    isRecord(candidate) && candidate.kind === "issue" &&
    positiveInteger(candidate.id) && positiveInteger(candidate.number) &&
    (candidate.body === undefined || candidate.body === null ||
      typeof candidate.body === "string"))) {
    throw new Error("Issue recovery catalog is not authoritative.");
  }
  const matches = (catalog as ObservedIssue[]).filter((issue) =>
    matchesMarker(issue.body, marker, custom));
  if (matches.length > 1) {
    throw new Error("Issue create marker is ambiguous; refusing duplicate create.");
  }
  return matches[0];
}

function checkRecoveredIdentity(observed: ObservedIssue, asserted: unknown): void {
  const claim = createdIdentity("issue.create", asserted);
  if (claim.number !== observed.number ||
      (claim.id !== undefined && claim.id !== observed.id) ||
      (claim.nodeId !== undefined && claim.nodeId !== observed.nodeId)) {
    throw new Error("Issue marker recovery contradicts postcondition identity.");
  }
}

/** Verification must affirm the identity returned by the preceding create. */
function assertCreatedIdentity(
  kind: PlanStep["kind"], dispatched: PlanBindings[string], checked: unknown,
): void {
  const observed = createdIdentity(kind, checked);
  for (const key of ["number", "id", "nodeId"] as const) {
    if (dispatched[key] !== undefined && observed[key] !== undefined &&
        dispatched[key] !== observed[key]) {
      throw new Error("Post-write verification contradicted the create identity.");
    }
  }
  // At least one stable identity must be independently observed and equal.
  const key = kind === "project.item.add" ? "id" : "number";
  if (observed[key] !== dispatched[key]) {
    throw new Error("Post-write verification did not confirm create identity.");
  }
}

/** Collect trusted shape/field types, not arbitrary error messages or response bodies. */
function createdIdentity(kind: PlanStep["kind"], response: unknown): PlanBindings[string] {
  if (!isRecord(response)) throw new Error("Create response lacks a resource identity.");
  const { id, number } = response;
  const nodeId = response.node_id ?? response.nodeId;
  const needsNumber = kind !== "project.item.add";
  if ((needsNumber && !positiveInteger(number)) ||
      (kind === "project.item.add" && !positiveInteger(id))) {
    throw new Error("Create response lacks a valid resource identity.");
  }
  return {
    ...(positiveInteger(id) ? { id } : {}),
    ...(positiveInteger(number) ? { number } : {}),
    ...(typeof nodeId === "string" && nodeId.length ? { nodeId } : {}),
  };
}

/**
 * Internal, sequential execution staging. The entire plan is validated before
 * any writes. Each step is freshly read before dispatch; each actual write is
 * independently read again and must verify all postconditions. No failed step
 * permits a following dispatch, and exceptions expose only an allowlisted phase
 * and ordinal, never caller error messages, credentials or HTTP data.
 *
 * The optional sink can persist each sanitized log entry as it is produced.
 * Still not a public applyPlan(): postconditions require a caller-supplied
 * authoritative reader and concurrent writers are not transactionally locked.
 */
export async function executePlanSteps(
  plan: GithubPlan, dispatch: PlanStepDispatcher,
  readPostcondition: PlanStepPostconditionReader,
  readIssueCatalog?: PlanIssueCatalogReader,
  onLog?: PlanApplyLogSink,
): Promise<PlanStepExecution> {
  if (typeof dispatch !== "function" || typeof readPostcondition !== "function" ||
      (onLog !== undefined && typeof onLog !== "function")) {
    throw new Error("Execution requires valid dispatcher, postcondition reader and log sink.");
  }
  const steps = orderedSteps(plan);
  const markers = new Map<string, { marker: string; custom: boolean }>();
  for (const step of steps) {
    if (step.kind !== "issue.create") continue;
    if (typeof readIssueCatalog !== "function") {
      throw new Error("Issue create recovery requires a fresh full-catalog reader.");
    }
    markers.set(step.id, createMarker(plan, step));
  }
  const bindings: PlanBindings = Object.create(null) as PlanBindings;
  const completedStepIds: string[] = [];
  const skippedStepIds: string[] = [];
  const log: PlanApplyLogEntry[] = [];

  async function record(entry: PlanApplyLogEntry): Promise<void> {
    log.push(entry);
    if (onLog) await onLog({ ...entry });
  }
  for (const [stepIndex, step] of steps.entries()) {
    let phase: PlanExecutionPhase = "binding";
    try {
      // Bind only after prior creates have been independently verified.
      const request = bindPlanRequest(step.request!, bindings);
      const snapshot = (): PlanBindings => Object.fromEntries(
        Object.entries(bindings).map(([id, identity]) => [id, { ...identity }]),
      );
      phase = "precondition";
      const checked: unknown = await readPostcondition(step, request, snapshot());
      if (!isRecord(checked)) {
        throw new Error("Postcondition reader returned no conclusive result.");
      }

      // The full marker catalog is independent of the postcondition reader.
      phase = "recovery";
      const marker = markers.get(step.id);
      let recovered: ObservedIssue | undefined;
      if (marker) {
        recovered = matchingIssue(
          await readIssueCatalog!(plan.repository.fullName), marker.marker, marker.custom);
        if (recovered && checked.status !== "satisfied") {
          throw new Error("Existing marked issue differs from create postconditions; replan.");
        }
        if (!recovered && checked.status === "satisfied") {
          throw new Error("Postcondition claims an issue exists without its marker.");
        }
        if (recovered) checkRecoveredIdentity(recovered, checked.identity);
      }

      if (checked.status === "satisfied") {
        if (PRODUCERS.has(step.kind)) {
          bindings[step.logicalId] = recovered
            ? createdIdentity(step.kind, recovered) : createdIdentity(step.kind, checked.identity);
        } else if (Object.hasOwn(checked, "identity")) {
          throw new Error("Non-create postcondition included an unexpected identity.");
        }
        skippedStepIds.push(step.id);
        phase = "logging";
        await record({ stepIndex, outcome: "skipped", phase: "precondition" });
      } else if (checked.status === "unsatisfied" && !Object.hasOwn(checked, "identity")) {
        phase = "dispatch";
        // Rebind after the read so a malicious/mutating reader cannot alter
        // the outgoing request object before dispatch.
        const response = await dispatch(bindPlanRequest(step.request!, bindings), step);
        const produced = PRODUCERS.has(step.kind)
          ? createdIdentity(step.kind, response) : undefined;

        phase = "verification";
        const afterBindings = snapshot();
        if (produced) afterBindings[step.logicalId] = { ...produced };
        const verified: unknown = await readPostcondition(step, request, afterBindings);
        if (!isRecord(verified) || verified.status !== "satisfied") {
          throw new Error("Post-write verification did not confirm the intended state.");
        }
        if (produced) {
          assertCreatedIdentity(step.kind, produced, verified.identity);
        } else if (Object.hasOwn(verified, "identity")) {
          throw new Error("Non-create verification included an unexpected identity.");
        }

        // Check issue marker uniqueness after the write as well: a successful
        // create response alone does not prove which issue now owns the marker.
        if (marker) {
          const observed = matchingIssue(
            await readIssueCatalog!(plan.repository.fullName), marker.marker, marker.custom);
          if (!observed) throw new Error("Created issue marker not found after write.");
          checkRecoveredIdentity(observed, response);
          checkRecoveredIdentity(observed, verified.identity);
        }
        if (produced) bindings[step.logicalId] = produced;
        phase = "logging";
        await record({ stepIndex, outcome: "applied", phase: "verification" });
      } else {
        throw new Error("Postcondition reader returned no conclusive result.");
      }
      completedStepIds.push(step.id);
    } catch {
      // Intentionally drop the caught error and all raw request/response data.
      // The caller can safely store this allowlisted record on failures.
      const failure = { stepIndex, outcome: "failed" as const, phase };
      log.push(failure);
      if (onLog && phase !== "logging") {
        try { await onLog({ ...failure }); } catch { /* preserve original failure phase */ }
      }
      throw new PlanExecutionError(stepIndex, phase, log);
    }
  }
  return {
    completedStepIds, skippedStepIds, log: log.map((entry) => ({ ...entry })),
    bindings: { ...bindings },
  };
}
