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

export interface PlanStepExecution {
  /** All resolved steps, including those already satisfied and skipped. */
  completedStepIds: string[];
  /** Steps for which the fresh postcondition read confirmed no write was needed. */
  skippedStepIds: string[];
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
 * Execute planned requests in deterministic dependency order. Validate the
 * entire DAG before the first write, then reread every step's postconditions
 * immediately before dispatch. A verified satisfied step is skipped; skipped
 * creates contribute observed identities so dependent requests can still bind.
 *
 * The required postcondition reader must check current state. When the plan
 * creates an issue, a second exhaustive marker catalog read guards against
 * repeating a create after an interruption, including when its desired state
 * has subsequently drifted. Existing marker + unsatisfied state is a conflict,
 * not permission to create again. No write is performed on ambiguity.
 *
 * This is NOT public applyPlan(): it cannot guarantee global concurrency-safe
 * exactly-once creation, postwrite verification or durable apply logs.
 */
export async function executePlanSteps(
  plan: GithubPlan, dispatch: PlanStepDispatcher,
  readPostcondition: PlanStepPostconditionReader,
  readIssueCatalog?: PlanIssueCatalogReader,
): Promise<PlanStepExecution> {
  if (typeof dispatch !== "function" || typeof readPostcondition !== "function") {
    throw new Error("Execution requires a dispatcher and fresh postcondition reader.");
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
  for (const step of steps) {
    // Bind after prerequisite creates (including skipped, observed creates).
    const request = bindPlanRequest(step.request!, bindings);
    const identitySnapshot: PlanBindings = Object.fromEntries(
      Object.entries(bindings).map(([id, identity]) => [id, { ...identity }]),
    );
    const checked: unknown = await readPostcondition(step, request, identitySnapshot);
    if (!isRecord(checked)) {
      throw new Error("Postcondition reader returned no conclusive result.");
    }
    // M8.1.3: identify an interrupted issue create by its unique durable
    // marker. The second read cannot be replaced with a stale plan snapshot.
    // A marker match with changed properties is a conflict, never a new POST.
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
        // Do not skip a producer without a verified, usable binding. Otherwise
        // dependent steps might bind guessed or missing resource identities.
        bindings[step.logicalId] = recovered
          ? createdIdentity(step.kind, recovered) : createdIdentity(step.kind, checked.identity);
      } else if (Object.hasOwn(checked, "identity")) {
        throw new Error("Non-create postcondition included an unexpected identity.");
      }
      skippedStepIds.push(step.id);
    } else if (checked.status === "unsatisfied" && !Object.hasOwn(checked, "identity")) {
      // Rebind after the read to avoid dispatching an object mutated by a
      // caller-supplied reader. A write must not occur for unknown read states.
      const response = await dispatch(bindPlanRequest(step.request!, bindings), step);
      if (PRODUCERS.has(step.kind)) {
        bindings[step.logicalId] = createdIdentity(step.kind, response);
      }
    } else {
      throw new Error("Postcondition reader returned no conclusive result.");
    }
    completedStepIds.push(step.id);
  }
  return { completedStepIds, skippedStepIds, bindings: { ...bindings } };
}
