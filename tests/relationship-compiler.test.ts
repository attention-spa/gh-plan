import {
  bindPlanRequest, compileRelationshipSteps, diffGithubState, normalizeSchema,
  validatePlanStepReferences,
} from "../src/index.ts";
import type {
  DesiredRelationship, GithubStateSnapshot, NormalizedDesiredStateGraph,
  ResourceResolution, PlanStep,
} from "../src/index.ts";
function check(test: unknown, label: string): asserts test {
  if (!test) throw Error(label);
}
function equal(actual: unknown, wanted: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    throw Error(label + "\nExpected: " + JSON.stringify(wanted) + "\nActual: " + JSON.stringify(actual));
}
const repository = { fullName: "acme/example" };
const issue = (logicalId: string, management: "managed" | "reference" = "managed") =>
  management === "managed"
    ? { kind: "issue" as const, logicalId, management, desired: {} }
    : { kind: "issue" as const, logicalId, management };
const existing = (logicalId: string, number: number): ResourceResolution =>
  ({ logicalId, kind: "issue", status: "existing", identity: { number } });
const fresh = (logicalId: string): ResourceResolution =>
  ({ logicalId, kind: "issue", status: "new" });
function observed(
  parent: number | null = 1, blocked: number[] = [3], related: number[] = [4],
): GithubStateSnapshot {
  return {
    repository, milestones: [], issueTypes: [], issueFields: [],
    issues: [
      { kind: "issue", number: 1, id: 101, title: "Old parent", state: "open",
        parentNumber: null, blockedByNumbers: [], relatesToNumbers: [] },
      { kind: "issue", number: 2, id: 102, title: "Managed", state: "open",
        parentNumber: parent, blockedByNumbers: blocked, relatesToNumbers: related },
      { kind: "issue", number: 3, id: 103, title: "Blocker", state: "open",
        parentNumber: null, blockedByNumbers: [], relatesToNumbers: [] },
      { kind: "issue", number: 4, id: 104, title: "Related", state: "open",
        parentNumber: null, blockedByNumbers: [], relatesToNumbers: [2] },
      { kind: "issue", number: 5, id: 105, title: "New parent", state: "open",
        parentNumber: null, blockedByNumbers: [], relatesToNumbers: [] },
    ],
  };
}
const resources = [issue("OLD", "reference"), issue("CHILD"), issue("BLOCKER", "reference"),
  issue("RELATED", "reference"), issue("NEW_PARENT", "reference")];
const resolutions = [existing("OLD", 1), existing("CHILD", 2), existing("BLOCKER", 3),
  existing("RELATED", 4), existing("NEW_PARENT", 5)];
function run(
  edges: DesiredRelationship[], state = observed(),
  mode: "reconcile" | "additive" = "reconcile",
  allResources: unknown[] = resources, allResolutions: ResourceResolution[] = resolutions,
  transport: "rest" | "graphql" = "rest",
) {
  const graph = { repository, relationshipMode: mode, resources: allResources,
    relationships: edges } as NormalizedDesiredStateGraph;
  const diff = diffGithubState(graph, state, allResolutions);
  return { diff, ...compileRelationshipSteps(graph, diff, state, allResolutions, transport) };
}
const plan = (result: ReturnType<typeof run>, kind: string) =>
  result.steps.find((s) => s.kind === kind);
let r = run([{ kind: "parent", parent: "NEW_PARENT", child: "CHILD" },
  { kind: "blocked_by", issue: "CHILD", blocker: "BLOCKER" },
  { kind: "relates_to", from: "CHILD", to: "RELATED" }]);
equal(r.blockers, [], "A reparent with existing desired blocker and related edge is safe.");
equal(r.steps.map((s) => s.id), ["issue.parent.set:CHILD"], "No redundant edges created.");
equal(plan(r, "issue.parent.set")?.request, {
  protocol: "rest", method: "POST", path: "/repos/acme/example/issues/5/sub_issues",
  body: { sub_issue_id: 102, replace_parent: true },
}, "Reparent POST passes child's REST id and replace_parent true.");
check(plan(r, "issue.parent.set")!.reason.includes("#1") &&
  plan(r, "issue.parent.set")!.reason.includes("#5"), "Reparent reason names both parents.");
equal(r.diff.blockers, [], "Semantic diff no longer blocks explicit reparent.");
equal(r.noops.map((s) => s.kind), ["issue.dependency.add", "issue.relates_to.add"],
  "Existing dependency and related edge noops.");

r = run([{ kind: "parent", parent: "OLD", child: "CHILD" }]);
equal(plan(r, "issue.dependency.remove")?.request, {
  protocol: "rest", method: "DELETE",
  path: "/repos/acme/example/issues/2/dependencies/blocked_by/103",
}, "Stale blocker is removed using issue REST id.");
equal(plan(r, "issue.relates_to.remove")?.request, {
  protocol: "rest", method: "DELETE",
  path: "/repos/acme/example/issues/2/relates_to/104",
}, "Stale symmetric related edge is removed using REST id.");
check(r.steps.every((s) => s.destructive === false && s.reversible === true),
  "All relationship removals are non-destructive and reversible.");

r = run([], observed());
equal(plan(r, "issue.parent.remove")?.request, {
  protocol: "rest", method: "DELETE",
  path: "/repos/acme/example/issues/1/sub_issue", body: { sub_issue_id: 102 },
}, "Absent desired parent removes stale child from observed parent.");
equal(r.steps.length, 3, "Reconcile removes all three absent owned edges.");

r = run([], observed(), "additive");
equal(r.steps, [], "Additive mode never removes stale owned edges.");
equal(r.warnings.length, 3, "Additive mode reports all extra owned edges.");
check(r.warnings.every((item) => item.severity === "info" && !item.blocking),
  "Additive extras are nonblocking informational diagnostics.");

r = run([{ kind: "parent", parent: "OLD", child: "CHILD" },
  { kind: "blocked_by", issue: "CHILD", blocker: "BLOCKER" },
  { kind: "relates_to", from: "RELATED", to: "CHILD" }]);
equal(r.steps, [], "Second pass after applied relationships produces no mutations.");
equal(r.noops.length, 3, "All desired edges are classified as noops.");

r = run([{ kind: "blocked_by", issue: "CHILD", blocker: "NEW_PARENT" },
  { kind: "relates_to", from: "CHILD", to: "NEW_PARENT" }], observed(null, [], []));
equal(plan(r, "issue.dependency.add")?.request, {
  protocol: "rest", method: "POST",
  path: "/repos/acme/example/issues/2/dependencies/blocked_by",
  body: { issue_id: 105 },
}, "Dependency add uses the blocker REST id.");
equal(plan(r, "issue.relates_to.add")?.request, {
  protocol: "rest", method: "POST",
  path: "/repos/acme/example/issues/2/relates_to",
  body: { issue_id: 105 },
}, "Native symmetric relates_to POST uses related REST id.");

r = run([{ kind: "blocked_by", issue: "CHILD", blocker: "NEW_PARENT" }],
  observed(null, [3], []));
const remove = plan(r, "issue.dependency.remove")!, add = plan(r, "issue.dependency.add")!;
check(add.dependsOn.includes(remove.id), "Dependency removal precedes add for the same owner.");
equal(validatePlanStepReferences(r.steps), [], "Existing-reference DAG is valid.");

const refOnly = [issue("A", "reference"), issue("B", "reference")];
const refResolutions = [existing("A", 2), existing("B", 3)];
r = run([{ kind: "blocked_by", issue: "A", blocker: "B" },
  { kind: "relates_to", from: "A", to: "B" },
  { kind: "parent", parent: "B", child: "A" }],
  observed(), "reconcile", refOnly, refResolutions);
equal(r.steps, [], "Reference-only pairs cannot create or remove relationships.");
equal(r.noops, [], "Reference-only pairs are not reconciled.");

r = run([{ kind: "blocked_by", issue: "CHILD", blocker: "BLOCKER" }],
  observed(null, [3], []), "reconcile");
equal(r.steps, [], "An existing blocker is never duplicated.");
equal(r.noops.length, 1, "Existing blocker has explicit noop.");

r = run([{ kind: "blocks", issue: "BLOCKER", blocked: "CHILD" },
  { kind: "blocked_by", issue: "CHILD", blocker: "BLOCKER" }],
  observed(null, [3], []));
equal(r.noops.length, 1, "blocks and blocked_by are deduplicated.");

r = run([{ kind: "relates_to", from: "CHILD", to: "RELATED" },
  { kind: "relates_to", from: "RELATED", to: "CHILD" }],
  observed(null, [], [4]));
equal(r.noops.length, 1, "Symmetric related pairs are deduplicated.");

r = run([{ kind: "relates_to", from: "CHILD", to: "RELATED" }],
  observed(null, [], []), "reconcile", resources, resolutions, "graphql");
equal(r.steps, [], "GraphQL-only transport does not invent REST operations.");
equal(r.unsupported[0]?.code, "NO_REST_TRANSPORT", "Only incapable transports report unsupported.");

r = run([{ kind: "blocked_by", issue: "CHILD", blocker: "NEW_PARENT" }],
  observed(null, [], []), "reconcile",
  [...resources.filter((x) => x.logicalId !== "NEW_PARENT"), issue("NEW_PARENT")],
  [...resolutions.filter((x) => x.logicalId !== "NEW_PARENT"), fresh("NEW_PARENT")]);
equal(plan(r, "issue.dependency.add")?.request, {
  protocol: "rest", method: "POST",
  path: "/repos/acme/example/issues/2/dependencies/blocked_by",
  body: { issue_id: { $ref: "NEW_PARENT.id" } },
}, "Future blocker REST id is late-bound.");
check(plan(r, "issue.dependency.add")!.dependsOn.includes("issue.create:NEW_PARENT"),
  "New blocker create is an explicit predecessor.");
const producer: PlanStep = {
  id: "issue.create:NEW_PARENT", kind: "issue.create", logicalId: "NEW_PARENT",
  status: "planned", current: null, desired: null, reason: "create",
  dependsOn: [], preconditions: [], expectedPostconditions: [],
  destructive: false, reversible: "partial",
};
equal(validatePlanStepReferences([...r.steps, producer]), [],
  "Combined request DAG resolves late-bound REST id.");
equal(bindPlanRequest(plan(r, "issue.dependency.add")!.request!, { NEW_PARENT: { id: 777 } }), {
  protocol: "rest", method: "POST",
  path: "/repos/acme/example/issues/2/dependencies/blocked_by",
  body: { issue_id: 777 },
}, "Late-bound IDs are executable by external integrations.");


r = run([{ kind: "parent", parent: "OLD", child: "CHILD" }],
  observed(null, [], []), "reconcile",
  [issue("OLD", "reference"), issue("CHILD")],
  [existing("OLD", 1), fresh("CHILD")]);
equal(plan(r, "issue.parent.set")?.request, {
  protocol: "rest", method: "POST", path: "/repos/acme/example/issues/1/sub_issues",
  body: { sub_issue_id: { $ref: "CHILD.id" } },
}, "New child parent assignment requires its REST id, not issue number.");
check(plan(r, "issue.parent.set")!.dependsOn.includes("issue.create:CHILD"),
  "New child must be created before parent assignment.");
const childProducer: PlanStep = {
  id: "issue.create:CHILD", kind: "issue.create", logicalId: "CHILD",
  status: "planned", current: null, desired: null, reason: "create",
  dependsOn: [], preconditions: [], expectedPostconditions: [],
  destructive: false, reversible: "partial",
};
equal(validatePlanStepReferences([childProducer, ...r.steps]), [],
  "New child parent binding has a valid producer DAG.");
equal(bindPlanRequest(plan(r, "issue.parent.set")!.request!, { CHILD: { id: 222 } }), {
  protocol: "rest", method: "POST", path: "/repos/acme/example/issues/1/sub_issues",
  body: { sub_issue_id: 222 },
}, "New child REST id binds exactly in POST.");

const schemaDefault = normalizeSchema({ repository: "acme/example", issues: [] });
check(schemaDefault.ok && (schemaDefault.graph?.relationshipMode ?? "reconcile") === "reconcile",
  "Default schema relation mode is reconcile.");
const schemaAdd = normalizeSchema({ repository: "acme/example", issues: [], relationshipMode: "additive" });
check(schemaAdd.ok && schemaAdd.graph?.relationshipMode === "additive",
  "Schema supports explicit additive mode.");
const badSchema = normalizeSchema({ repository: "acme/example", relationshipMode: "replace" });
check(!badSchema.ok && badSchema.diagnostics.some((x) => x.code === "INVALID_SCHEMA"),
  "Unknown relationship mode is rejected.");
console.log("Native relationship reconciliation fixtures passed.");
