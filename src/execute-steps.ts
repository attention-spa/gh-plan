import { bindPlanRequest, validatePlanStepReferences } from "./plan-bindings.ts";
import type { BoundPlanRequest } from "./plan-bindings.ts";
import type { GithubPlan, PlanBindings, PlanStep } from "./types.ts";

/**
 * Internal M8 execution primitive. Deliberately not exported from the package
 * entrypoint until postcondition reads, recovery and failure reporting land.
 * The caller supplies a transport that rejects unsuccessful HTTP responses.
 */
export type PlanStepDispatcher = (
  request: BoundPlanRequest, step: Readonly<PlanStep>,
) => Promise<unknown>;

export interface PlanStepExecution {
  completedStepIds: string[];
  /** Only public resource IDs from successful create responses; never credentials. */
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
 * Execute every planned request in deterministic dependency order. Before the
 * first write, validate the *entire* DAG and its late-binding producer edges.
 * After a successful create, capture its identity for dependent requests.
 * This is a staging primitive, NOT the public idempotent applyPlan(): it does
 * not reread postconditions, recover interrupted creates, or verify writes.
 */
export async function executePlanSteps(
  plan: GithubPlan, dispatch: PlanStepDispatcher,
): Promise<PlanStepExecution> {
  const steps = orderedSteps(plan);
  const bindings: PlanBindings = Object.create(null) as PlanBindings;
  const completedStepIds: string[] = [];
  for (const step of steps) {
    const request = bindPlanRequest(step.request!, bindings);
    const response = await dispatch(request, step);
    if (PRODUCERS.has(step.kind)) {
      bindings[step.logicalId] = createdIdentity(step.kind, response);
    }
    completedStepIds.push(step.id);
  }
  return { completedStepIds, bindings: { ...bindings } };
}
