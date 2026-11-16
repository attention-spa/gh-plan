import { compileMilestoneSteps, diffGithubState, validatePlanStepReferences } from "../src/index.ts";
import type { GithubStateSnapshot, NormalizedDesiredStateGraph, ResourceResolution } from "../src/index.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + "\nExpected: " + JSON.stringify(expected) + "\nActual: " + JSON.stringify(actual));
  }
}
const repository = { fullName: "attention-spa/example" };
const observed: GithubStateSnapshot = {
  repository, issues: [], issueTypes: [], issueFields: [],
  milestones: [
    { kind: "milestone", number: 4, title: "Current", description: "Notes", state: "open" },
    { kind: "milestone", number: 5, title: "Empty", state: "closed" },
  ],
};
const set = <T>(value: T) => ({ op: "set" as const, value });
const remove = { op: "remove" as const };
function resource(logicalId: string, desired: Record<string, unknown>, management = "managed") {
  return management === "reference" ?
    { kind: "milestone", logicalId, management: "reference" } :
    { kind: "milestone", logicalId, management, desired };
}
const existing = (logicalId: string, number: number): ResourceResolution =>
  ({ logicalId, kind: "milestone", status: "existing", identity: { number } });
const fresh = (logicalId: string): ResourceResolution =>
  ({ logicalId, kind: "milestone", status: "new" });
function compile(resources: unknown[], resolutions: ResourceResolution[], snapshot = observed) {
  const graph = { repository, resources, relationships: [] } as NormalizedDesiredStateGraph;
  const result = diffGithubState(graph, snapshot, resolutions);
  return compileMilestoneSteps(graph, result, resolutions);
}
let output = compile([resource("NEW", {
  title: set("Release"), description: set("Description"), state: set("closed"),
})], [fresh("NEW")]);
equal(output.blockers, [], "New milestone must not block.");
equal(output.steps.length, 1, "New resource produces exactly one create.");
equal(output.noops.length, 0, "New resource does not generate a noop.");
equal(output.steps[0]?.id, "milestone.create:NEW", "Stable create ID.");
equal(output.steps[0]?.status, "planned", "Create is planned.");
equal(output.steps[0]?.request, {
  protocol: "rest", method: "POST", path: "/repos/attention-spa/example/milestones",
  body: { title: "Release", description: "Description", state: "closed" },
}, "Create POST must carry all managed properties.");
equal(output.steps[0]?.reversible, "partial", "Creation is partially reversible.");
equal(validatePlanStepReferences(output.steps), [], "No late-bound references on milestone requests.");

output = compile([resource("NEW", {
  title: set("Release"), description: remove,
})], [fresh("NEW")]);
equal(output.steps[0]?.request, {
  protocol: "rest", method: "POST", path: "/repos/attention-spa/example/milestones",
  body: { title: "Release" },
}, "New milestone explicit description remove should not create a redundant clear.");
output = compile([resource("NEW", { description: set("Orphan") })], [fresh("NEW")]);
equal(output.steps.length, 0, "Create without title must not produce an unsafe request.");
equal(output.blockers[0]?.code, "INVALID_SCHEMA", "Incomplete create should block.");

output = compile([resource("M", { title: set("Current"), description: set("Notes"), state: set("open") })],
  [existing("M", 4)]);
equal(output.steps, [], "Fully reconciled resource produces no mutations.");
equal(output.noops.length, 1, "Fully reconciled resource produces aggregate noop.");
equal(output.noops[0]?.status, "noop", "Noop classified explicitly.");

output = compile([resource("M", { title: set("Revised") })], [existing("M", 4)]);
equal(output.steps.length, 1, "One changed property produces one update.");
equal(output.steps[0]?.request, {
  protocol: "rest", method: "PATCH", path: "/repos/attention-spa/example/milestones/4",
  body: { title: "Revised" },
}, "Unmanaged description/state must not be reset.");
equal(output.steps[0]?.current, { title: "Current" }, "Current value retained.");
equal(output.steps[0]?.reversible, true, "Title change remains reversible.");

output = compile([resource("M", {
  title: set("Revised"), description: set("Notes"), state: set("closed"),
})], [existing("M", 4)]);
equal(output.steps.length, 1, "Multiple changes to same milestone collapse to one update.");
equal(output.steps[0]?.request, {
  protocol: "rest", method: "PATCH", path: "/repos/attention-spa/example/milestones/4",
  body: { title: "Revised", state: "closed" },
}, "Equal description should be excluded from PATCH.");

output = compile([resource("M", { description: remove })], [existing("M", 4)]);
equal(output.steps[0]?.request, {
  protocol: "rest", method: "PATCH", path: "/repos/attention-spa/example/milestones/4",
  body: { description: "" },
}, "Remove description maps to GitHub empty string, not null.");
equal(output.steps[0]?.reversible, "partial", "Description clear is partially reversible.");
equal(output.steps[0]?.destructive, false, "Description clear is not issue deletion.");

output = compile([resource("E", { description: remove, state: set("closed") })], [existing("E", 5)]);
equal(output.steps, [], "Already-absent description and matching state are noops.");
equal(output.noops.length, 1, "Noop emitted for already-clear description.");

output = compile([resource("M", {})], [existing("M", 4)]);
equal(output.steps, [], "Omission never means reset.");
equal(output.noops.length, 1, "No explicitly managed properties still produces noop.");

output = compile([resource("R", {}, "reference")], [existing("R", 4)]);
equal(output.steps, [], "Reference-only milestone cannot create/update.");
equal(output.noops, [], "Reference-only milestone is not managed.");

output = compile([resource("M", { title: set("Unsafe") })],
  [{ logicalId: "M", kind: "milestone", status: "ambiguous" }]);
equal(output.steps, [], "Ambiguous milestone produces no mutation.");
assert(output.blockers.some((diagnostic) => diagnostic.code === "AMBIGUOUS_IDENTITY"),
  "Ambiguous identity should remain a blocker.");

output = compile([resource("M", { title: set("Unsafe") })], [existing("M", 99)]);
equal(output.steps, [], "Missing observed milestone must not be patched.");
assert(output.blockers.some((diagnostic) => diagnostic.code === "UNRESOLVED_IDENTITY"),
  "Missing existing milestone should block.");

output = compile([
  resource("Z", { title: set("Zed") }),
  resource("A", { title: set("Aye") }),
], [fresh("Z"), fresh("A")]);
equal(output.steps.map((step) => step.id), ["milestone.create:A", "milestone.create:Z"],
  "Output is sorted by stable ID.");

const reversed = compile([
  resource("A", { title: set("Aye") }),
  resource("Z", { title: set("Zed") }),
], [fresh("A"), fresh("Z")]);
equal(output, reversed, "Equivalent unordered inputs compile deterministically.");

// After applying a change, a repeated run must emit no executable steps.
const applied = {
  ...observed, milestones: [{ kind: "milestone" as const, number: 4,
    title: "Revised", description: "Notes", state: "open" as const }],
};
output = compile([resource("M", { title: set("Revised") })], [existing("M", 4)], applied);
equal(output.steps, [], "Idempotent replan after simulated apply emits no update.");
console.log("Milestone request compiler fixtures passed.");
