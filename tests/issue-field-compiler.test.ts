import {
  bindPlanRequest, compileIssueFieldSteps, diffGithubState, validatePlanStepReferences,
} from "../src/index.ts";
import type { GithubStateSnapshot, NormalizedDesiredStateGraph, ResourceResolution, PlanStep } from "../src/index.ts";

function equal(a: unknown, b: unknown, description: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(description + "\nExpected: " + JSON.stringify(b) + "\nActual: " + JSON.stringify(a));
}
function check(ok: unknown, description: string): asserts ok {
  if (!ok) throw new Error(description);
}
const repository = { fullName: "acme/example" };
const snapshot: GithubStateSnapshot = {
  repository,
  milestones: [], issueTypes: [], issueFields: [
    { id: 10, name: "Priority", dataType: "single_select", options: [
      { id: 12, name: "High" }, { id: 13, name: "Low" },
    ] },
    { id: 11, name: "Tags", dataType: "multi_select", options: [
      { id: 14, name: "Backend" }, { id: 15, name: "Frontend" }, { id: 16, name: "Infra" },
    ] },
    { id: 20, name: "Estimate", dataType: "number" },
    { id: 21, name: "Summary", dataType: "text" },
    { id: 22, name: "Due", dataType: "date" },
  ],
  issues: [{
    kind: "issue", number: 7, id: 700, title: "Example", state: "open",
    fields: {
      Priority: "Low", Tags: ["Frontend", "Backend"], Estimate: 2,
      Summary: "Keep", Due: "2026-12-01",
    },
  }, { kind: "issue", number: 8, id: 800, title: "Empty", state: "open", fields: {} }],
};
const set = (value: unknown) => ({ op: "set" as const, value });
const remove = { op: "remove" as const };
function resource(logicalId: string, fields: Record<string, unknown>, management: "managed" | "reference" = "managed") {
  return management === "reference"
    ? { kind: "issue", logicalId, management }
    : { kind: "issue", logicalId, management, desired: { fields } };
}
const found = (id: string, number: number): ResourceResolution => ({
  logicalId: id, kind: "issue", status: "existing", identity: { number },
});
const fresh = (id: string): ResourceResolution => ({
  logicalId: id, kind: "issue", status: "new",
});
function run(resources: unknown[], resolutions: ResourceResolution[], observed = snapshot) {
  const graph = { repository, resources, relationships: [] } as NormalizedDesiredStateGraph;
  const diffs = diffGithubState(graph, observed, resolutions);
  return { diffs, ...compileIssueFieldSteps(graph, diffs, observed, resolutions) };
}
const path = "/repos/acme/example/issues/7/issue-field-values";
let output = run([resource("A", { Priority: set("High"), Tags: set(["Backend", "Frontend"]) })], [found("A", 7)]);
equal(output.blockers, [], "Valid fields are unblocked.");
equal(output.steps.length, 1, "Only changed fields produce mutations.");
equal(output.steps[0]?.request, {
  protocol: "rest", method: "POST", path,
  body: { issue_field_values: [{ field_id: 10, value: "High" }] },
}, "POST targets the selected field by numeric ID without replacing the rest.");
equal(output.noops.length, 1, "Different multi-select order compares as equal set.");
equal(output.noops[0]?.id, "issue.field.set:A:Tags", "Stable noop for multi-select.");
equal(output.diffs.diffs.find((x) => x.id === "issue.field:A:Tags")?.status, "noop",
  "Multi-select equality is settled at the semantic diff layer.");
equal(snapshot.issues[0]?.fields?.Tags, ["Frontend", "Backend"], "Snapshot values not mutated.");
output = run([resource("A", { Tags: set(["Infra", "Backend", "Infra"]) })], [found("A", 7)]);
equal(output.steps[0]?.request, {
  protocol: "rest", method: "POST", path,
  body: { issue_field_values: [{ field_id: 11, value: ["Backend", "Infra"] }] },
}, "Changed multi-select values are canonicalized before writing.");
output = run([resource("A", { Estimate: set(3), Summary: set("Keep"), Due: set("2026-12-01") })], [found("A", 7)]);
equal(output.steps.map((s) => s.id), ["issue.field.set:A:Estimate"],
  "Omitted/unchanged fields must not generate write operations.");
output = run([resource("A", { Estimate: remove })], [found("A", 7)]);
equal(output.steps[0]?.request, {
  protocol: "rest", method: "DELETE", path: path + "/20",
}, "Explicit clear uses narrow DELETE instead of destructive PUT.");
equal(output.steps[0]?.kind, "issue.field.remove", "Clear has explicit operation kind.");
equal(output.steps[0]?.reversible, "partial", "Clearing a value is partially reversible.");
output = run([resource("E", { Estimate: remove })], [found("E", 8)]);
equal(output.steps, [], "Already-absent explicit remove is a noop.");
equal(output.noops.length, 1, "Already-absent field is explicitly a noop.");

output = run([resource("A", { Priority: set("High"), Invalid: set("X") })], [found("A", 7)]);
equal(output.steps, [], "Unknown field prevents partial issue field updates.");
check(output.blockers.some((x) => x.code === "UNKNOWN_ISSUE_FIELD"), "Unknown field must block.");
output = run([resource("A", { Priority: set("None") })], [found("A", 7)]);
equal(output.steps, [], "Unknown single-select option is not writable.");
check(output.blockers.some((x) => x.code === "UNKNOWN_FIELD_OPTION"), "Unknown select must block.");
output = run([resource("A", { Tags: set(["Unknown"]) })], [found("A", 7)]);
check(output.blockers.some((x) => x.code === "UNKNOWN_FIELD_OPTION"), "Unknown multi-select option must block.");
output = run([resource("A", { Estimate: set("not a number") })], [found("A", 7)]);
check(output.blockers.some((x) => x.code === "INVALID_SCHEMA"), "Wrong field type must block.");
output = run([resource("A", { Due: set("2026-02-30") })], [found("A", 7)]);
check(output.blockers.some((x) => x.code === "INVALID_SCHEMA"), "Impossible date must block.");
output = run([resource("A", { Priority: set("High") })], [found("A", 7)],
  { ...snapshot, issueFields: [] });
equal(output.steps, [], "No organization field metadata cannot produce writes.");
check(output.unsupported.some((x) => x.code === "UNSUPPORTED_SCHEMA_FEATURE"),
  "User-owned/no org field capability must be unsupported.");

output = run([resource("R", { Priority: set("High") }, "reference")], [found("R", 7)]);
equal(output.steps, [], "Reference-only resource cannot be mutated.");
output = run([resource("A", { Priority: set("High") })],
  [{ logicalId: "A", kind: "issue", status: "ambiguous" }]);
equal(output.steps, [], "Ambiguous identity never generates writes.");
output = run([resource("A", { Priority: set("High") })], [found("A", 7)],
  { ...snapshot, issues: [{ ...snapshot.issues[0]!, fields: undefined }] });
equal(output.steps, [], "Unenriched observed field state cannot be treated as empty.");
check(output.blockers.some((x) => x.code === "UNRESOLVED_IDENTITY"),
  "Unenriched fields must block.");

const newIssue = resource("N", { Priority: set("High"), Tags: set(["Frontend", "Backend"]) });
const graph = { repository, resources: [newIssue], relationships: [] } as NormalizedDesiredStateGraph;
const diffs = diffGithubState(graph, snapshot, [fresh("N")]);
const compiled = compileIssueFieldSteps(graph, diffs, snapshot, [fresh("N")]);
equal(compiled.steps.length, 2, "New issue fields are separate post-create writes.");
equal(compiled.steps.map((s) => s.dependsOn), [["issue.create:N"], ["issue.create:N"]],
  "New issue fields depend on its creation.");
equal(validatePlanStepReferences(compiled.steps).length, 2,
  "Standalone fields require the producing issue create step.");
const producer: PlanStep = {
  id: "issue.create:N", logicalId: "N", kind: "issue.create", status: "planned",
  current: null, desired: null, reason: "Create", dependsOn: [],
  preconditions: [], expectedPostconditions: [], destructive: false, reversible: "partial",
};
equal(validatePlanStepReferences([producer, ...compiled.steps]), [],
  "Combined DAG satisfies every new issue reference.");
equal(bindPlanRequest(compiled.steps[0]!.request!, { N: { number: 19 } }), {
  protocol: "rest", method: "POST",
  path: "/repos/acme/example/issues/19/issue-field-values",
  body: { issue_field_values: [{ field_id: 10, value: "High" }] },
}, "Field request binds new issue number correctly.");

const after = {
  ...snapshot,
  issues: [{ ...snapshot.issues[0]!, fields: { ...snapshot.issues[0]!.fields!, Priority: "High" } },
    snapshot.issues[1]!],
};
output = run([resource("A", { Priority: set("High") })], [found("A", 7)], after);
equal(output.steps, [], "A second plan after simulated apply is idempotent.");
const reversed = run([
  resource("Z", { Priority: set("High") }),
  resource("A", { Priority: set("High") }),
], [found("Z", 8), found("A", 7)]);
const reordered = run([
  resource("A", { Priority: set("High") }),
  resource("Z", { Priority: set("High") }),
], [found("A", 7), found("Z", 8)]);
equal(reversed, reordered, "Output is deterministic under resource permutation.");
check(reordered.steps.every((s) => s.request?.protocol !== "rest" ||
  s.request.method !== "PUT"), "No field compiler request may use replacing PUT.");

console.log("Issue-field request compiler fixtures passed.");
