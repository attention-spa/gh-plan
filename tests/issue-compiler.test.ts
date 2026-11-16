import {
  compileIssueSteps, diffGithubState, validatePlanStepReferences, bindPlanRequest,
} from "../src/index.ts";
import type {
  GithubStateSnapshot, NormalizedDesiredStateGraph, ResourceResolution,
} from "../src/index.ts";

const repository = { fullName: "acme/widgets" };
const marker = (id: string) => "<!-- gh-plan:" + id + " -->";
const set = <T>(value: T) => ({ op: "set" as const, value });
const remove = { op: "remove" as const };
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(message + "\nExpected: " + JSON.stringify(expected) + "\nActual: " + JSON.stringify(actual));
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const baseline: GithubStateSnapshot = {
  repository,
  issues: [
    { kind: "issue", number: 2, id: 200, title: "Existing", body: marker("A") + "\nExisting body",
      state: "open", milestoneNumber: 4, issueType: "Task" },
    { kind: "issue", number: 3, id: 300, title: "Adopt", body: "Legacy text", state: "open" },
    { kind: "issue", number: 5, id: 500, title: "Empty", body: null, state: "closed" },
  ],
  milestones: [{ kind: "milestone", number: 4, title: "Old", state: "open" }],
  issueTypes: [{ name: "Task" }, { name: "Bug" }], issueFields: [],
};
const resource = (id: string, desired: Record<string, unknown> = {}, management = "managed") =>
  management === "reference" ? { kind: "issue", management: "reference", logicalId: id } :
    { kind: "issue", management: "managed", logicalId: id, desired };
const milestone = (id: string, management = "managed") =>
  management === "reference"
    ? { kind: "milestone", management: "reference", logicalId: id }
    : { kind: "milestone", management: "managed", logicalId: id, desired: { title: set("New") } };
const existing = (id: string, number: number, kind: "issue" | "milestone" = "issue"): ResourceResolution =>
  ({ logicalId: id, kind, status: "existing", identity: { number } });
const fresh = (id: string, kind: "issue" | "milestone" = "issue"): ResourceResolution =>
  ({ logicalId: id, kind, status: "new", ...(kind === "issue" ? { identity: { marker: marker(id) } } : {}) });
function run(resources: unknown[], resolutions: ResourceResolution[], observed = baseline) {
  const graph = { repository, resources, relationships: [] } as NormalizedDesiredStateGraph;
  const diffs = diffGithubState(graph, observed, resolutions);
  return compileIssueSteps(graph, diffs, observed, resolutions);
}
const request = (output: ReturnType<typeof run>, id: string) =>
  output.steps.find((step) => step.id === id)?.request;

let result = run([resource("N", { title: set("New"), body: set("Hello"), issueType: set("Bug"),
  milestone: set({ logicalId: "M" }) }), milestone("M", "reference")],
[fresh("N"), existing("M", 4, "milestone")]);
equal(result.blockers, [], "New issue with discovered type and existing milestone is safe.");
equal(result.steps.length, 1, "One create request includes all create-time properties.");
equal(request(result, "issue.create:N"), {
  protocol: "rest", method: "POST", path: "/repos/acme/widgets/issues",
  body: { title: "New", body: marker("N") + "\nHello", type: "Bug", milestone: 4 },
}, "Canonical marker, type and existing milestone included in create.");
equal(result.steps[0]?.destructive, false, "Create is non-destructive.");
equal(result.steps[0]?.reversible, "partial", "Create is partially reversible.");

result = run([resource("N", { title: set("New"), milestone: set({ logicalId: "M" }) }),
  milestone("M")], [fresh("N"), fresh("M", "milestone")]);
equal(result.steps[0]?.dependsOn, ["milestone.create:M"], "Create depends on future milestone.");
equal(request(result, "issue.create:N"), {
  protocol: "rest", method: "POST", path: "/repos/acme/widgets/issues",
  body: { title: "New", body: marker("N"), milestone: { $ref: "M.number" } },
}, "Future milestone remains a logical request binding.");
equal(validatePlanStepReferences(result.steps), [{
  code: "UNRESOLVED_REFERENCE", severity: "error", blocking: true, logicalId: "N",
  schemaPath: "steps.issue.create:N.dependsOn",
  message: "Request reference M in issue.create:N requires exactly one distinct producing create step listed in dependsOn.",
  details: { reference: "M", producerStepIds: [] },
}], "Standalone issue steps require milestone producer from M3.2.");
const producer = {
  id: "milestone.create:M", kind: "milestone.create" as const,
  logicalId: "M", status: "planned" as const, current: null, desired: null,
  reason: "new", dependsOn: [], preconditions: [], expectedPostconditions: [],
  destructive: false, reversible: "partial" as const,
};
equal(validatePlanStepReferences([...result.steps, producer]), [], "Combined DAG reference resolves.");
equal(bindPlanRequest(request(result, "issue.create:N")!, { M: { number: 11 } }), {
  protocol: "rest", method: "POST", path: "/repos/acme/widgets/issues",
  body: { title: "New", body: marker("N"), milestone: 11 },
}, "Future milestone binds exactly.");

result = run([resource("N", { title: set("New"), state: set("closed") })], [fresh("N")]);
equal(result.steps.map((step) => step.id), ["issue.create:N", "issue.update:N"],
  "Closing a new issue is a follow-up PATCH.");
equal(result.steps[1]?.dependsOn, ["issue.create:N"], "New close depends on create.");
equal(result.steps[1]?.destructive, false, "Closing is non-destructive.");
equal(result.steps[1]?.reversible, true, "Closing is reversible.");
equal(request(result, "issue.update:N"), {
  protocol: "rest", method: "PATCH",
  path: ["/repos/acme/widgets/issues/", { $ref: "N.number" }],
  body: { state: "closed" },
}, "New close uses late-bound issue number.");
equal(validatePlanStepReferences(result.steps), [], "New close DAG validates.");

result = run([resource("A", { title: set("Renamed"), body: set("Replaced"),
  state: set("closed"), milestone: remove })], [existing("A", 2)]);
equal(result.steps.length, 1, "Changed core properties coalesce to one PATCH.");
equal(request(result, "issue.update:A"), {
  protocol: "rest", method: "PATCH", path: "/repos/acme/widgets/issues/2",
  body: { title: "Renamed", body: marker("A") + "\nReplaced", state: "closed", milestone: null },
}, "Patch includes only changed properties and preserves marker.");
equal(result.steps[0]?.destructive, false, "Existing close is non-destructive.");
equal(result.steps[0]?.reversible, "partial", "Body overwrite is partially reversible.");

result = run([resource("A", { title: set("Existing"), body: set("Existing body"),
  state: set("open"), issueType: set("Task"), milestone: set({ logicalId: "M" }) }),
  milestone("M", "reference")], [existing("A", 2), existing("M", 4, "milestone")]);
equal(result.steps, [], "Fully reconciled resource requires no mutation.");
equal(result.noops.length, 1, "Fully reconciled resource has explicit noop.");

result = run([resource("A", { state: set("closed") })], [existing("A", 2)]);
equal(request(result, "issue.update:A"), {
  protocol: "rest", method: "PATCH", path: "/repos/acme/widgets/issues/2", body: { state: "closed" },
}, "State-only update omits body/title/milestone.");
equal(result.steps[0]?.reversible, true, "State-only close is reversible.");
result = run([resource("A", { body: remove })], [existing("A", 2)]);
equal((request(result, "issue.update:A") as { body: Record<string,string> }).body,
  { body: marker("A") }, "Body remove retains identity marker.");
result = run([resource("E", { body: remove })], [existing("E", 5)]);
equal(request(result, "issue.marker.adopt:E"), {
  protocol: "rest", method: "PATCH", path: "/repos/acme/widgets/issues/5", body: { body: marker("E") },
}, "Marker adoption into an empty issue retains identity even when body removal is noop.");

result = run([resource("B", { title: set("Adopt") })], [existing("B", 3)]);
equal(request(result, "issue.marker.adopt:B"), {
  protocol: "rest", method: "PATCH", path: "/repos/acme/widgets/issues/3",
  body: { body: marker("B") + "\nLegacy text" },
}, "Adoption preserves original unmanaged body content.");
equal(result.steps[0]?.reversible, "partial", "Adoption is partially reversible.");

result = run([resource("B", { title: set("Adopt"), body: set("Replacement") })], [existing("B", 3)]);
equal(request(result, "issue.update:B"), {
  protocol: "rest", method: "PATCH", path: "/repos/acme/widgets/issues/3",
  body: { body: marker("B") + "\nReplacement" },
}, "Adoption and body change coalesce into one PATCH.");

result = run([resource("A", { issueType: set("Bug") })], [existing("A", 2)]);
equal(request(result, "issue.type.set:A"), {
  protocol: "rest", method: "PATCH", path: "/repos/acme/widgets/issues/2", body: { type: "Bug" },
}, "Issue type change is its own typed operation.");
result = run([resource("A", { issueType: set("Unknown") })], [existing("A", 2)]);
equal(result.steps, [], "Unknown issue type must block all issue mutations.");
assert(result.blockers.some((b) => b.code === "UNKNOWN_ISSUE_TYPE"),
  "Unknown issue type blocker retained.");
result = run([resource("N", { title: set("New"), issueType: set("Unknown") })], [fresh("N")]);
equal(result.steps, [], "Unknown type blocks issue create.");
result = run([resource("N", { title: set("New"), milestone: set({ logicalId: "M" }) }),
 milestone("M", "reference")], [fresh("N"), { logicalId: "M", kind: "milestone", status: "unresolved" }]);
equal(result.steps, [], "Unresolved milestone blocks issue create.");
assert(result.blockers.some((b) => b.code === "UNRESOLVED_REFERENCE"), "Unresolved milestone blocked.");

result = run([resource("N", { body: set("Orphan") })], [fresh("N")]);
equal(result.steps, [], "New issue without title does not create.");
assert(result.blockers.length > 0, "Missing title blocks.");
result = run([resource("A", { title: set("Wrong") })],
 [{ logicalId: "A", kind: "issue", status: "ambiguous" }]);
equal(result.steps, [], "Ambiguous issue does not mutate.");

result = run([resource("REF", {}, "reference")], [existing("REF", 2)]);
equal(result.steps, [], "Reference-only issue never writes.");
equal(result.noops, [], "Reference-only issue never participates in property reconciliation.");

result = run([resource("Z", { title: set("Zed") }), resource("N", { title: set("New") })],
 [fresh("Z"), fresh("N")]);
const reversed = run([resource("N", { title: set("New") }), resource("Z", { title: set("Zed") })],
 [fresh("N"), fresh("Z")]);
equal(result, reversed, "Equivalent unordered inputs produce deterministic steps.");
equal(result.steps.map((s) => s.id), ["issue.create:N", "issue.create:Z"], "Stable IDs sorted.");

// A simulated applied update is idempotent.
const after: GithubStateSnapshot = { ...baseline, issues: [
  { ...baseline.issues[0]!, title: "Renamed" }, ...baseline.issues.slice(1),
]};
result = run([resource("A", { title: set("Renamed") })], [existing("A", 2)], after);
equal(result.steps, [], "Applied title yields no further mutation.");
console.log("Issue core compiler fixtures passed.");
