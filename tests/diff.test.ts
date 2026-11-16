import assert from "node:assert/strict";
import { diffGithubState } from "../src/diff.ts";
import type { GithubStateSnapshot, NormalizedDesiredStateGraph, ResourceResolution } from "../src/types.ts";

const repo = { fullName: "attention-spa/example" };
const snapshot: GithubStateSnapshot = {
  repository: repo,
  issues: [
    { kind: "issue", number: 1, id: 101, title: "Parent", body: "<!-- gh-plan:P -->\nhello",
      state: "open", milestoneNumber: 2, issueType: "Task",
      fields: { Priority: "High" }, blockedByNumbers: [3], parentNumber: null },
    { kind: "issue", number: 3, id: 103, title: "External", state: "open" },
    { kind: "issue", number: 4, id: 104, title: "Child", state: "open", parentNumber: 1 },
    { kind: "issue", number: 5, id: 105, title: "Other", state: "open", parentNumber: 3 },
  ],
  milestones: [{ kind: "milestone", number: 2, title: "Sprint", state: "open", description: "Description" }],
  issueTypes: [{ name: "Task" }, { name: "Bug" }],
  issueFields: [{ id: 7, name: "Priority", dataType: "single_select", options: [{ name: "High" }, { name: "Low" }] }],
};
const issue = (logicalId: string, desired: Record<string, unknown> = {}, management = "managed") =>
  management === "reference" ? { kind: "issue", logicalId, management: "reference" } :
    { kind: "issue", logicalId, management: "managed", desired };
const milestone = (logicalId: string, desired: Record<string, unknown> = {}, management = "managed") =>
  management === "reference" ? { kind: "milestone", logicalId, management: "reference" } :
    { kind: "milestone", logicalId, management: "managed", desired };
const existing = (logicalId: string, kind: "issue" | "milestone", number: number): ResourceResolution =>
  ({ logicalId, kind, status: "existing", identity: { number } });
const fresh = (logicalId: string, kind: "issue" | "milestone"): ResourceResolution =>
  ({ logicalId, kind, status: "new", ...(kind === "issue" ? { identity: { marker: "<!-- gh-plan:" + logicalId + " -->" } } : {}) });
function run(resources: unknown[], resolutions: ResourceResolution[], relationships: unknown[] = []) {
  return diffGithubState({ repository: repo, resources, relationships } as NormalizedDesiredStateGraph, snapshot, resolutions);
}
const set = (value: unknown) => ({ op: "set", value });
const remove = { op: "remove" };
function status(result: ReturnType<typeof run>, id: string) {
  return result.diffs.find((item) => item.id === id)?.status;
}

// Create is one resource-level delta and preserves marker and future references.
let r = run([issue("N", { title: set("New"), milestone: set({ logicalId: "F" }) }), milestone("F", { title: set("Future") })],
  [fresh("N", "issue"), fresh("F", "milestone")]);
assert.equal(r.diffs.filter((item) => item.status === "create").length, 2);
assert.equal(r.diffs.length, 2);
assert.deepEqual(r.diffs.find((item) => item.id === "issue.create:N")?.references, [{ logicalId: "F" }]);
assert.equal((r.diffs.find((item) => item.id === "issue.create:N")?.desired as Record<string, unknown>).identityMarker, "<!-- gh-plan:N -->");

// Explicitly managed equality and omissions do not update or reset anything.
const p = existing("P", "issue", 1), m = existing("M", "milestone", 2);
r = run([issue("P", { title: set("Parent"), body: set("hello"), state: set("open"),
  milestone: set({ logicalId: "M" }), issueType: set("Task"),
  fields: { Priority: set("High"), Empty: undefined } }), milestone("M", {})], [p, m]);
assert.equal(status(r, "issue.body:P"), "noop");
assert.equal(status(r, "issue.title:P"), "noop");
assert.equal(status(r, "issue.state:P"), "noop");
assert.equal(status(r, "issue.milestone:P"), "noop");
assert.equal(status(r, "issue.type:P"), "noop");
assert.equal(status(r, "issue.field:P:Priority"), "noop");
assert.equal(r.diffs.filter((d) => d.status === "update").length, 0);
// An omitted desired property is not emitted at all.
r = run([issue("P", { title: set("Changed") })], [p]);
assert.deepEqual(r.diffs.map((d) => d.id), ["issue.title:P"]);
assert.equal(status(r, "issue.title:P"), "update");

// Body set/remove, empty removal and state changes.
r = run([issue("P", { body: remove, state: set("closed") })], [p]);
assert.equal(status(r, "issue.body:P"), "update");
assert.equal(status(r, "issue.state:P"), "update");
r = run([issue("E", { body: remove, milestone: remove })], [existing("E", "issue", 3)]);
assert.equal(status(r, "issue.body:E"), "noop");
assert.equal(status(r, "issue.milestone:E"), "noop");
r = run([issue("P", { body: set("revised") })], [p]);
assert.equal(status(r, "issue.body:P"), "update");
assert.equal(r.diffs[0]?.current, "hello");

// Milestone references, including blocked and future milestone.
r = run([issue("P", { milestone: set({ logicalId: "F" }) }), milestone("F", { title: set("Future") })],
  [p, fresh("F", "milestone")]);
assert.equal(status(r, "issue.milestone:P"), "update");
assert.deepEqual(r.diffs.find((d) => d.id === "issue.milestone:P")?.references, [{ logicalId: "F" }]);
r = run([issue("P", { milestone: set({ logicalId: "X" }) })], [p]);
assert.equal(status(r, "issue.milestone:P"), "conflict");
assert.equal(r.blockers[0]?.code, "UNRESOLVED_REFERENCE");

// Unknown capability definitions must block, including on new resources.
r = run([issue("P", { issueType: set("Unknown"), fields: { Missing: set("x"), Priority: set("Unknown") } })], [p]);
assert.deepEqual(r.blockers.map((d) => d.code).sort(), ["UNKNOWN_FIELD_OPTION", "UNKNOWN_ISSUE_FIELD", "UNKNOWN_ISSUE_TYPE"].sort());
r = run([issue("P", { issueType: set("Bug"), fields: { Priority: set("Low") } })], [p]);
assert.equal(status(r, "issue.type:P"), "update");
assert.equal(status(r, "issue.field:P:Priority"), "update");
r = run([issue("P", { fields: { Priority: remove } })], [p]);
assert.equal(status(r, "issue.field:P:Priority"), "update");
r = run([issue("E", { fields: { Priority: remove } })], [existing("E", "issue", 3)]);
assert.equal(status(r, "issue.field:E:Priority"), "noop");
r = run([issue("N", { issueType: set("Unknown") })], [fresh("N", "issue")]);
assert.equal(status(r, "issue.type:N"), "conflict");

// Milestone only emits managed explicit changes.
r = run([milestone("M", { title: set("Sprint"), description: set("Description"), state: set("open") })], [m]);
assert.equal(r.diffs.length, 3);
assert.ok(r.diffs.every((d) => d.status === "noop"));
r = run([milestone("M", { title: set("New"), description: remove, state: set("closed") })], [m]);
assert.equal(r.diffs.filter((d) => d.status === "update").length, 3);
r = run([milestone("M", { description: set("Description") })], [m]);
assert.equal(status(r, "milestone.description:M"), "noop");

// References do not yield mutations; unresolved and ambiguous identities are preserved.
r = run([issue("P", {}, "reference")], [p]);
assert.equal(r.diffs.length, 0);
r = run([issue("P", {}, "reference")], [{ logicalId: "P", kind: "issue", status: "unresolved" }]);
assert.equal(status(r, "issue.identity:P"), "conflict");
assert.equal(r.blockers[0]?.code, "UNRESOLVED_REFERENCE");
r = run([issue("P", {})], [{ logicalId: "P", kind: "issue", status: "ambiguous" }]);
assert.equal(status(r, "issue.identity:P"), "conflict");
assert.equal(r.blockers[0]?.code, "AMBIGUOUS_IDENTITY");

// Native parent and dependency semantics, including safe future references.
const child = existing("C", "issue", 4), ext = existing("E", "issue", 3);
r = run([issue("P", {}, "reference"), issue("C", {}, "reference")], [p, child],
  [{ kind: "parent", parent: "P", child: "C" }]);
assert.equal(status(r, "issue.parent:P:C"), "noop");
r = run([issue("E", {}, "reference"), issue("C", {}, "reference")], [ext, child],
  [{ kind: "parent", parent: "E", child: "C" }]);
assert.equal(status(r, "issue.parent:E:C"), "conflict");
assert.equal(r.blockers[0]?.code, "PARENT_CONFLICT");
r = run([issue("P", {}, "reference"), issue("E", {}, "reference")], [p, ext],
  [{ kind: "blocked_by", issue: "P", blocker: "E" }, { kind: "blocks", issue: "E", blocked: "P" }]);
assert.equal(r.diffs.length, 1);
assert.equal(status(r, "issue.dependency:P:E"), "noop");
r = run([issue("C", {}, "reference"), issue("E", {}, "reference")], [child, ext],
  [{ kind: "blocked_by", issue: "C", blocker: "E" }]);
assert.equal(status(r, "issue.dependency:C:E"), "update");
r = run([issue("N", { title: set("New") }), issue("E", {}, "reference")], [fresh("N", "issue"), ext],
  [{ kind: "parent", parent: "E", child: "N" }, { kind: "blocked_by", issue: "N", blocker: "E" }]);
assert.equal(status(r, "issue.parent:E:N"), "update");
assert.equal(status(r, "issue.dependency:N:E"), "update");
assert.deepEqual(r.diffs.find((d) => d.id === "issue.parent:E:N")?.references,
  [{ logicalId: "E" }, { logicalId: "N" }]);
r = run([issue("P", {}, "reference"), issue("E", {}, "reference")], [p, ext],
  [{ kind: "relates_to", from: "P", to: "E" }]);
assert.equal(r.diffs[0]?.status, "unsupported");
assert.equal(r.unsupported[0]?.code, "UNSUPPORTED_SCHEMA_FEATURE");

// Determinism under input permutation and idempotency after a simulated apply.
const resources = [issue("P", { title: set("Parent") }), issue("C", {}, "reference"), issue("E", {}, "reference")];
const relations = [{ kind: "parent", parent: "P", child: "C" },
  { kind: "blocked_by", issue: "P", blocker: "E" }];
const a = run(resources, [p, child, ext], relations);
const b = run([...resources].reverse(), [ext, child, p], [...relations].reverse());
assert.deepEqual(a, b);
assert.ok(a.diffs.every((d) => d.status === "noop"));
assert.equal(a.blockers.length, 0);
assert.equal(a.diffs.filter((d) => d.status === "create" || d.status === "update").length, 0);
console.log("Semantic diff fixtures passed.");
