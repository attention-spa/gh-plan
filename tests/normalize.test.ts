import { normalizeSchema } from "../src/index.ts";
import type { GithubDiagnostic, NormalizedDesiredStateGraph } from "../src/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (stable(actual) !== stable(expected)) {
    throw new Error(`${message}\nexpected: ${stable(expected)}\nactual:   ${stable(actual)}`);
  }
}

function valid(schema: object): NormalizedDesiredStateGraph {
  const result = normalizeSchema(schema);
  assert(result.ok, `expected valid schema, got ${stable(result.diagnostics)}`);
  assert(result.graph, "valid result must contain a graph");
  return result.graph;
}

function blocked(schema: object, code: GithubDiagnostic["code"]): GithubDiagnostic[] {
  const result = normalizeSchema(schema);
  assert(!result.ok, "expected schema to be blocked");
  assert(!result.graph, "blocked result must not expose a graph");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === code && diagnostic.blocking), `expected blocking ${code}: ${stable(result.diagnostics)}`);
  return result.diagnostics;
}

// 1. Minimal ergonomic schema compiles to the explicit normalized contract.
const minimal = valid({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: "Alpha" }],
});
equal(minimal, {
  repository: { fullName: "attention-spa/example" },
  resources: [{
    logicalId: "A",
    kind: "issue",
    management: "managed",
    desired: { title: { op: "set", value: "Alpha" } },
  }],
  relationships: [],
}, "minimal schema normalization");

// 2. Nested issues flatten into resources plus a parent edge.
const nested = valid({
  repository: "attention-spa/example",
  issues: [{
    logicalId: "PARENT",
    title: "Parent",
    children: [{ logicalId: "CHILD", title: "Child" }],
  }],
});
assert(nested.resources.length === 2, "nested issue should flatten to two resources");
equal(nested.relationships, [{ kind: "parent", parent: "PARENT", child: "CHILD" }], "nested issue parent edge");

// 3. A managed issue may reference a future-created managed milestone.
const milestone = valid({
  repository: "attention-spa/example",
  milestones: [{ logicalId: "M1", title: "Foundation" }],
  issues: [{ logicalId: "A", title: "Alpha", milestone: "M1" }],
});
const milestoneIssue = milestone.resources.find((resource) => resource.logicalId === "A");
assert(milestoneIssue?.kind === "issue" && milestoneIssue.management === "managed", "managed issue expected");
equal(milestoneIssue.desired.milestone, { op: "set", value: { logicalId: "M1" } }, "milestone reference should normalize to logical ref");

// 4. Relationship-only endpoints can be explicit reference resources.
const reference = valid({
  repository: "attention-spa/example",
  issues: [
    { logicalId: "A", title: "Alpha", blockedBy: ["EXTERNAL"] },
    { logicalId: "EXTERNAL", management: "reference", identity: { number: 99 } },
  ],
});
const external = reference.resources.find((resource) => resource.logicalId === "EXTERNAL");
assert(external?.kind === "issue" && external.management === "reference", "external endpoint should stay reference-only");
equal(reference.relationships, [{ kind: "blocked_by", issue: "A", blocker: "EXTERNAL" }], "blocked-by edge");

// 5-7. Omission, set, and supported remove stay distinct.
const partial = valid({
  repository: "attention-spa/example",
  issues: [{
    logicalId: "A",
    title: "Alpha",
    body: { op: "remove" },
    state: "open",
    fields: { Priority: "High", Effort: { op: "remove" } },
  }],
});
const partialIssue = partial.resources[0];
assert(partialIssue?.kind === "issue" && partialIssue.management === "managed", "managed issue expected");
assert(!("milestone" in partialIssue.desired), "omitted milestone must stay omitted");
equal(partialIssue.desired.title, { op: "set", value: "Alpha" }, "raw title becomes set");
equal(partialIssue.desired.body, { op: "remove" }, "body remove preserved");
equal(partialIssue.desired.fields, {
  Effort: { op: "remove" },
  Priority: { op: "set", value: "High" },
}, "field set/remove normalized deterministically");

// 8. Duplicate logical IDs are rejected.
blocked({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: "One" }, { logicalId: "A", title: "Two" }],
}, "INVALID_SCHEMA");

// 9. Dangling logical references are rejected.
blocked({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: "Alpha", blockedBy: ["MISSING"] }],
}, "INVALID_SCHEMA");

// 10. Self-parenting is rejected.
blocked({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: "Alpha" }],
  relationships: [{ kind: "parent", parent: "A", child: "A" }],
}, "INVALID_SCHEMA");

// 11. Parent cycles are reported as relationship cycles.
blocked({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: "Alpha" }, { logicalId: "B", title: "Beta" }],
  relationships: [
    { kind: "parent", parent: "A", child: "B" },
    { kind: "parent", parent: "B", child: "A" },
  ],
}, "RELATIONSHIP_CYCLE");

// 12. Self-dependencies are rejected.
blocked({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: "Alpha", blockedBy: ["A"] }],
}, "INVALID_SCHEMA");

// 13. Equivalent duplicate edges are deduplicated.
const deduped = valid({
  repository: "attention-spa/example",
  issues: [
    { logicalId: "A", title: "Alpha", blockedBy: ["B"] },
    { logicalId: "B", title: "Beta" },
  ],
  relationships: [{ kind: "blocked_by", issue: "A", blocker: "B" }],
});
equal(deduped.relationships, [{ kind: "blocked_by", issue: "A", blocker: "B" }], "duplicate edge should dedupe");

// 14. Parent relationships require issue endpoints.
blocked({
  repository: "attention-spa/example",
  milestones: [{ logicalId: "M1", title: "Foundation" }],
  issues: [{ logicalId: "A", title: "Alpha" }],
  relationships: [{ kind: "parent", parent: "M1", child: "A" }],
}, "INVALID_SCHEMA");

// 15. Repository selector must be owner/name.
blocked({ repository: "not-a-repo", issues: [] }, "INVALID_SCHEMA");

// 16. Unknown top-level constructs fail closed instead of being silently ignored.
blocked({
  repository: "attention-spa/example",
  issues: [],
  projects: [{ id: 1 }],
}, "UNSUPPORTED_SCHEMA_FEATURE");

// Unsupported removal also fails closed.
blocked({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: { op: "remove" } }],
}, "INVALID_SCHEMA");

// Non-JSON field values are rejected.
blocked({
  repository: "attention-spa/example",
  issues: [{ logicalId: "A", title: "Alpha", fields: { Priority: () => "High" } }],
}, "INVALID_SCHEMA");

// 17. Semantically equivalent source ordering normalizes identically.
const orderedA = valid({
  repository: { fullName: "attention-spa/example" },
  milestones: [{ logicalId: "M1", title: "Foundation" }],
  issues: [
    { logicalId: "B", title: "Beta", related: ["A"] },
    { logicalId: "A", title: "Alpha" },
  ],
});
const orderedB = valid({
  repository: "attention-spa/example",
  issues: [
    { logicalId: "A", title: "Alpha" },
    { logicalId: "B", title: "Beta", related: ["A"] },
  ],
  milestones: [{ logicalId: "M1", title: "Foundation" }],
});
equal(orderedA, orderedB, "semantically equivalent source order should normalize identically");
