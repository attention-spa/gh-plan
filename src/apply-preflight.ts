import { matchesMarker } from "./identity.ts";
import { validatePlanStepReferences } from "./plan-bindings.ts";
import { GITHUB_PLAN_VERSION } from "./plan.ts";
import type {
  GithubPlan, NormalizedDesiredStateGraph, PlanJsonValue,
  PlanOperationKind, PlanStep, PlanValueRef, ResourceResolution,
} from "./types.ts";

/** Opaque, JSON-safe evidence of normalized managed intent; never a substitute for fresh reads. */
export interface ApplyIntentManifest {
  version: 1;
  repository: string;
  resourceCount: number;
  relationshipCount: number;
  managed: Array<{
    logicalId: string;
    kind: "issue" | "milestone";
    fields: string[];
    removes: string[];
    desiredState?: "open" | "closed";
  }>;
  unsupported: string[];
}

export type ApplyCapabilityErrorCode =
  | "INVALID_PLAN" | "UNSUPPORTED_OPERATION" | "UNSUPPORTED_INTENT"
  | "UNSAFE_REQUEST" | "UNSAFE_IDENTITY" | "INVALID_REFERENCE"
  | "STALE_NOOP" | "CONFLICT";

export interface ApplyCapabilityError {
  code: ApplyCapabilityErrorCode;
  stepIndex?: number;
}

/** Descriptors are versioned, typed, and scoped to one repository; prose is never parsed. */
export interface ApplyFieldPredicate {
  field: "title" | "body" | "state" | "milestone" | "description" | "due_on";
  comparison: "exact" | "utc_day" | "null";
  expected: string | number | null | PlanValueRef;
}
export type ApplyPostconditionIdentity =
  | { strategy: "unique_milestone_title"; title: string }
  | { strategy: "milestone_number"; number: number }
  | { strategy: "unique_issue_marker"; marker: string }
  | { strategy: "issue_number"; number: number | PlanValueRef; marker: string };
export interface ApplyPostconditionSpec {
  version: 1;
  stepId: string;
  kind: "milestone.create" | "milestone.update" | "issue.create" | "issue.update";
  repository: string;
  method: "POST" | "PATCH";
  path: string | Array<string | PlanValueRef>;
  identity: ApplyPostconditionIdentity;
  predicates: ApplyFieldPredicate[];
  reads: readonly ("milestones.catalog" | "milestones.byNumber" |
    "issues.catalog" | "issues.byNumber")[];
}
export type ApplyCapabilityPreflight =
  | { ok: true; postconditions: ApplyPostconditionSpec[] }
  | { ok: false; errors: ApplyCapabilityError[] };

const ALLOWED = new Set<PlanOperationKind>([
  "milestone.create", "milestone.update", "issue.create", "issue.update",
]);
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/;
const NUM = /^[1-9][0-9]*$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function keysOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function ref(value: unknown, id: string): value is PlanValueRef {
  return record(value) && Object.keys(value).length === 1 &&
    value.$ref === id + ".number";
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value)) return "{" + Object.keys(value).sort().map((k) =>
    JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function marker(id: string, resolution: ResourceResolution): string {
  return resolution.identity?.marker ?? "<!-- gh-plan:" + id + " -->";
}
function expectedDate(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const day = value.slice(0, 10);
  const date = new Date(day + "T00:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}

/** Attach to the planner result so silent unsupported intent cannot be omitted from steps. */
export function buildApplyIntent(graph: NormalizedDesiredStateGraph): ApplyIntentManifest {
  const managed: ApplyIntentManifest["managed"] = [];
  const unsupported: string[] = [];
  for (const resource of graph.resources) {
    if (resource.management !== "managed") continue;
    const fields = Object.keys(resource.desired).sort();
    const removes = Object.entries(resource.desired)
      .filter(([, intent]) => intent?.op === "remove").map(([field]) => field).sort();
    const desiredState = resource.desired.state?.value;
    managed.push({ logicalId: resource.logicalId, kind: resource.kind, fields, removes,
      ...(desiredState ? { desiredState } : {}) });
    const allow = resource.kind === "issue"
      ? ["title", "body", "state", "milestone"]
      : ["title", "description", "state", "due_on"];
    for (const field of fields) {
      if (!allow.includes(field)) unsupported.push(resource.kind + "." + field);
    }
  }
  if (graph.labels?.length) unsupported.push("repository.labels");
  if (graph.pullRequests?.length) unsupported.push("pullRequests");
  if (graph.projects?.length || graph.projectItems?.length) unsupported.push("projects");
  if (graph.relationships.length) unsupported.push("relationships");
  if (graph.prune === "close" || graph.deleteDuplicates) unsupported.push("prune");
  if (graph.relationshipMode === "additive") unsupported.push("relationshipMode");
  return {
    version: 1, repository: graph.repository.fullName,
    resourceCount: graph.resources.length + (graph.labels?.length ?? 0) +
      (graph.pullRequests?.length ?? 0) + (graph.projects?.length ?? 0),
    relationshipCount: graph.relationships.length,
    managed: managed.sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
    unsupported: unsupported.sort(),
  };
}

function validField(kind: ApplyPostconditionSpec["kind"], field: string, value: unknown,
  step: PlanStep, steps: Map<string, PlanStep>): boolean {
  if (field === "title") return string(value) && value.trim().length > 0;
  if (field === "body") return typeof value === "string";
  if (field === "state") return value === "open" || value === "closed";
  if (field === "description") return typeof value === "string";
  if (field === "due_on") {
    return kind === "milestone.update" && value === null || expectedDate(value);
  }
  if (field === "milestone") {
    if (kind === "issue.update" && value === null) return true;
    if (positive(value)) return true;
    if (!record(value) || Object.keys(value).length !== 1 || !string(value.$ref)) return false;
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)\.number$/.exec(value.$ref);
    if (!match) return false;
    const producer = steps.get("milestone.create:" + match[1]);
    return producer?.kind === "milestone.create" &&
      step.dependsOn.includes(producer.id);
  }
  return false;
}

function predicates(body: Record<string, unknown>): ApplyFieldPredicate[] {
  return Object.keys(body).sort().map((field) => {
    const expected = body[field] as ApplyFieldPredicate["expected"];
    return {
      field: field as ApplyFieldPredicate["field"],
      comparison: expected === null ? "null" : field === "due_on" ? "utc_day" : "exact",
      expected,
    };
  });
}
function stepSpec(step: PlanStep, steps: Map<string, PlanStep>, repository: string,
  resolutions: Map<string, ResourceResolution>): ApplyPostconditionSpec | undefined {
  const request = step.request;
  if (!request || request.protocol !== "rest" ||
      !keysOnly(request as unknown as Record<string, unknown>, ["protocol", "method", "path", "body"]) ||
      !record(request.body) || !Object.keys(request.body).length ||
      !ALLOWED.has(step.kind) || !LOGICAL_ID.test(step.logicalId)) return undefined;
  const kind = step.kind as ApplyPostconditionSpec["kind"];
  const create = kind.endsWith(".create");
  const base = "/repos/" + repository + "/" +
    (kind.startsWith("issue") ? "issues" : "milestones");
  if (request.method !== (create ? "POST" : "PATCH")) return undefined;
  const allowed = kind === "issue.create" ? ["title", "body", "milestone"] :
    kind === "issue.update" ? ["title", "body", "state", "milestone"] :
    kind === "milestone.create" ? ["title", "description", "state", "due_on"] :
    ["title", "description", "state", "due_on"];
  const body = request.body as Record<string, unknown>;
  if (!keysOnly(body, allowed) || !Object.entries(body).every(([field, value]) =>
    validField(kind, field, value, step, steps))) return undefined;
  if (create && (typeof body.title !== "string" ||
      kind === "issue.create" && typeof body.body !== "string")) return undefined;
  if (step.desired === null || canonical(step.desired) !== canonical(body)) return undefined;
  const resolution = resolutions.get(step.logicalId);
  if (!resolution || resolution.kind !== (kind.startsWith("issue") ? "issue" : "milestone") ||
      !["existing", "new"].includes(resolution.status) ||
      resolution.status !== (create ? "new" : "existing") &&
        !(kind === "issue.update" && resolution.status === "new")) return undefined;

  let identity: ApplyPostconditionIdentity;
  let reads: ApplyPostconditionSpec["reads"];
  if (kind === "milestone.create") {
    if (request.path !== base || resolution.identity?.number !== undefined ||
      resolution.identity?.id !== undefined || resolution.identity?.nodeId !== undefined) return undefined;
    identity = { strategy: "unique_milestone_title", title: body.title as string };
    reads = ["milestones.catalog", "milestones.byNumber"];
  } else if (kind === "milestone.update") {
    const num = resolution.identity?.number;
    if (!positive(num) || request.path !== base + "/" + num) return undefined;
    identity = { strategy: "milestone_number", number: num };
    reads = ["milestones.byNumber"];
  } else if (kind === "issue.create") {
    const token = marker(step.logicalId, resolution);
    const text = body.body as string;
    if (request.path !== base || !string(token) ||
      text.split(token).length !== 2 ||
      !matchesMarker(text, token, token !== "<!-- gh-plan:" + step.logicalId + " -->") ||
      resolution.identity?.number !== undefined ||
      resolution.identity?.id !== undefined || resolution.identity?.nodeId !== undefined) return undefined;
    identity = { strategy: "unique_issue_marker", marker: token };
    reads = ["issues.catalog", "issues.byNumber"];
  } else {
    const token = marker(step.logicalId, resolution);
    const number = resolution.identity?.number;
    let target: number | PlanValueRef;
    if (resolution.status === "new") {
      const producer = steps.get("issue.create:" + step.logicalId);
      if (!producer || !step.dependsOn.includes(producer.id) ||
        !Array.isArray(request.path) || request.path.length !== 2 ||
        request.path[0] !== base + "/" ||
        !ref(request.path[1], step.logicalId)) return undefined;
      target = request.path[1];
    } else {
      if (!positive(number) || request.path !== base + "/" + number) return undefined;
      target = number;
    }
    if (body.body !== undefined && (
      typeof body.body !== "string" || !matchesMarker(body.body, token,
        token !== "<!-- gh-plan:" + step.logicalId + " -->"))) return undefined;
    if (record(step.current) && typeof step.current.body === "string" &&
      !matchesMarker(step.current.body, token,
        token !== "<!-- gh-plan:" + step.logicalId + " -->")) return undefined;
    identity = { strategy: "issue_number", number: target, marker: token };
    reads = ["issues.byNumber", "issues.catalog"];
  }
  const checks = predicates(body);
  // GitHub's issue-create endpoint starts in open state, even when state is
  // omitted from the outgoing POST; make this independently checkable.
  if (kind === "issue.create" && !Object.hasOwn(body, "state"))
    checks.push({ field: "state", comparison: "exact", expected: "open" });
  return {
    version: 1, stepId: step.id, kind, repository,
    method: request.method as "POST" | "PATCH", path: request.path,
    identity, predicates: checks, reads,
  };
}

/**
 * Pure, all-or-nothing, B1-only safety filter. No callback, GitHub request or
 * lock can run from this function. Noops are rejected until #187 adds an
 * independently verified fresh-noop strategy; descriptive strings are ignored.
 */
export function preflightApplyPlan(plan: GithubPlan): ApplyCapabilityPreflight {
  const errors: ApplyCapabilityError[] = [];
  const fail = (code: ApplyCapabilityErrorCode, stepIndex?: number): void => {
    errors.push(stepIndex === undefined ? { code } : { code, stepIndex });
  };
  const p = plan as unknown;
  if (!record(p) || !record(p.metadata) || p.metadata.planner !== "gh-plan" ||
    p.metadata.version !== GITHUB_PLAN_VERSION || p.metadata.mode !== "rest" ||
    !record(p.repository) || typeof p.repository.fullName !== "string" ||
    !REPO.test(p.repository.fullName) || !record(p.desired) ||
    !Array.isArray(p.steps) || !Array.isArray(p.noops) ||
    !Array.isArray(p.resolutions) || !Array.isArray(p.warnings) ||
    !Array.isArray(p.blockers) || !Array.isArray(p.unsupported) ||
    !record(p.summary)) return { ok: false, errors: [{ code: "INVALID_PLAN" }] };
  const input = plan;
  const manifest = input.applyIntent;
  if (!manifest || manifest.version !== 1 || manifest.repository !== input.repository.fullName ||
    manifest.resourceCount !== input.desired.resourceCount ||
    manifest.relationshipCount !== input.desired.relationshipCount ||
    !Array.isArray(manifest.managed) || !Array.isArray(manifest.unsupported)) fail("INVALID_PLAN");
  if (input.readiness !== "ready" || input.blockers.length || input.unsupported.length ||
      input.warnings.length || input.summary.blocked || input.summary.unsupported ||
      input.summary.warnings) fail("CONFLICT");
  if (input.noops.length || input.summary.noops !== input.noops.length) fail("STALE_NOOP");
  if (input.summary.planned !== input.steps.length) fail("INVALID_PLAN");
  if (manifest?.unsupported.length) fail("UNSUPPORTED_INTENT");
  if (manifest && (manifest.managed.some((m) =>
    !LOGICAL_ID.test(m.logicalId) || !["issue", "milestone"].includes(m.kind) ||
    !Array.isArray(m.fields) || !m.fields.every((f) => typeof f === "string") ||
    new Set(m.fields).size !== m.fields.length ||
    !Array.isArray(m.removes) || !m.removes.every((f) => typeof f === "string" &&
      m.fields.includes(f)) || new Set(m.removes).size !== m.removes.length ||
    (m.desiredState !== undefined && m.desiredState !== "open" && m.desiredState !== "closed")) ||
    new Set(manifest.managed.map((m) => m.logicalId)).size !== manifest.managed.length))
      fail("INVALID_PLAN");

  const resolutions = new Map<string, ResourceResolution>();
  for (const item of input.resolutions) {
    if (!record(item) || !string(item.logicalId) ||
      resolutions.has(item.logicalId) || !["existing", "new"].includes(item.status) ||
      !["issue", "milestone"].includes(item.kind)) {
      fail("UNSAFE_IDENTITY"); continue;
    }
    const identity = item.identity;
    if (identity && (!record(identity) ||
      identity.number !== undefined && !positive(identity.number) ||
      identity.id !== undefined && !positive(identity.id) ||
      identity.nodeId !== undefined && !string(identity.nodeId) ||
      identity.marker !== undefined && !string(identity.marker))) fail("UNSAFE_IDENTITY");
    resolutions.set(item.logicalId, item);
  }
  const steps = new Map<string, PlanStep>();
  const specs: ApplyPostconditionSpec[] = [];
  input.steps.forEach((step, i) => {
    if (!record(step) || typeof step.id !== "string" ||
      typeof step.kind !== "string" || !string(step.logicalId) ||
      step.id !== step.kind + ":" + step.logicalId ||
      steps.has(step.id) || !Array.isArray(step.dependsOn) ||
      !step.dependsOn.every((s: unknown) => typeof s === "string") ||
      new Set(step.dependsOn).size !== step.dependsOn.length ||
      step.dependsOn.includes(step.id) || step.status !== "planned" ||
      step.destructive !== false || !step.request) {
      fail("INVALID_PLAN", i);
      if (record(step) && typeof step.kind === "string" && !ALLOWED.has(step.kind as PlanOperationKind))
        fail("UNSUPPORTED_OPERATION", i);
      return;
    }
    steps.set(step.id, step);
  });
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]!;
    if (!record(step) || !string(step.id) || !string(step.kind) ||
      !string(step.logicalId) || steps.get(step.id) !== step) continue;
    if (!ALLOWED.has(step.kind)) { fail("UNSUPPORTED_OPERATION", i); continue; }
    if (!step.dependsOn.every((id) => steps.has(id))) {
      fail("INVALID_REFERENCE", i); continue;
    }
    const descriptor = stepSpec(step, steps, input.repository.fullName, resolutions);
    if (!descriptor) { fail("UNSAFE_REQUEST", i); continue; }
    specs.push(descriptor);
  }
  if (steps.size === input.steps.length) {
    const visit = (id: string, seen: Set<string>, active: Set<string>): boolean => {
      if (active.has(id)) return false;
      if (seen.has(id)) return true;
      const step = steps.get(id);
      if (!step) return false;
      active.add(id);
      for (const dependency of step.dependsOn)
        if (!visit(dependency, seen, active)) return false;
      active.delete(id);
      seen.add(id);
      return true;
    };
    const seen = new Set<string>();
    for (const id of steps.keys()) {
      if (!visit(id, seen, new Set())) { fail("INVALID_REFERENCE"); break; }
    }
    if (validatePlanStepReferences(input.steps).length) fail("INVALID_REFERENCE");
  }
  const createdMarkers = new Set<string>();
  const createdTitles = new Set<string>();
  for (const spec of specs) {
    if (spec.identity.strategy === "unique_issue_marker") {
      if (createdMarkers.has(spec.identity.marker)) fail("UNSAFE_IDENTITY");
      createdMarkers.add(spec.identity.marker);
    }
    if (spec.identity.strategy === "unique_milestone_title") {
      if (createdTitles.has(spec.identity.title)) fail("UNSAFE_IDENTITY");
      createdTitles.add(spec.identity.title);
    }
  }
  if (manifest) {
    for (const m of manifest.managed) {
      const allowed = m.kind === "issue" ? ["title", "body", "state", "milestone"] :
        ["title", "description", "state", "due_on"];
      if (m.fields.some((field) => !allowed.includes(field))) {
        fail("UNSUPPORTED_INTENT"); continue;
      }
      const matching = specs.filter((spec) => spec.identity &&
        input.steps.some((step) => step.id === spec.stepId && step.logicalId === m.logicalId));
      if (m.fields.length && !matching.length) fail("UNSUPPORTED_INTENT");
      for (const field of m.fields) {
        const covered = matching.some((spec) => spec.predicates.some((predicate) =>
          predicate.field === field && (field !== "state" ||
            m.desiredState === undefined || predicate.expected === m.desiredState)));
        const createClear = m.kind === "milestone" && m.removes.includes(field) &&
          (field === "description" || field === "due_on") &&
          matching.some((spec) => spec.kind === "milestone.create");
        if (!covered && !createClear) { fail("STALE_NOOP"); break; }
      }
    }
    for (const spec of specs) {
      const step = steps.get(spec.stepId)!;
      const m = manifest.managed.find((entry) => entry.logicalId === step.logicalId &&
        entry.kind === (step.kind.startsWith("issue") ? "issue" : "milestone"));
      if (!m) { fail("UNSUPPORTED_INTENT"); continue; }
      if (spec.kind.endsWith(".update") && spec.predicates.some((predicate) =>
        !m.fields.includes(predicate.field))) fail("UNSUPPORTED_INTENT");
      for (const field of m.removes) {
        const check = spec.predicates.find((p) => p.field === field);
        if (check && ((field === "description" && check.expected !== "") ||
          (field === "due_on" && check.expected !== null) ||
          (field === "milestone" && check.expected !== null)))
          fail("UNSAFE_REQUEST");
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, postconditions: specs };
}
