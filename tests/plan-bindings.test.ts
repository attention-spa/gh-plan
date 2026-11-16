import {
  bindPlanRequest, PlanBindingError, requestReferences, validatePlanStepReferences,
  type PlanRequest, type PlanStep,
} from "../src/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  const normalized = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item);
  if (normalized(actual) !== normalized(expected))
    throw new Error(message + "\nExpected: " + normalized(expected) + "\nActual: " + normalized(actual));
}
function throwsCode(fn: () => unknown, code: string): void {
  try { fn(); } catch (error) {
    assert(error instanceof PlanBindingError, "Unexpected exception type");
    equal(error.code, code, "Unexpected binding error");
    return;
  }
  throw new Error("Expected " + code + " to be thrown.");
}
const ref = (name: string) => ({ $ref: name as "CHILD.id" });
const bindings = {
  CHILD: { id: 87321, number: 75, nodeId: "I_child" },
  M1: { number: 7 },
};
const nested: PlanRequest = {
  protocol: "rest", method: "POST",
  path: ["/repos/acme/repo/issues/", ref("CHILD.number"), "/sub_issues"],
  body: {
    sub_issue_id: ref("CHILD.id"),
    milestone: ref("M1.number"),
    values: [true, { nested: [ref("CHILD.nodeId"), null, { literal: "abc" }] }],
  },
};
const original = JSON.stringify(nested);
equal(requestReferences(nested), ["CHILD", "M1"], "Reference scan must deduplicate and sort.");
equal(bindPlanRequest(nested, bindings), {
  protocol: "rest", method: "POST",
  path: "/repos/acme/repo/issues/75/sub_issues",
  body: {
    sub_issue_id: 87321,
    milestone: 7,
    values: [true, { nested: ["I_child", null, { literal: "abc" }] }],
  },
}, "REST template and nested payload must bind exactly.");
equal(JSON.stringify(nested), original, "Binding must not mutate its input.");
equal(bindPlanRequest({ protocol: "rest", method: "GET", path: "/repos/acme/repo/issues" }, {}), {
  protocol: "rest", method: "GET", path: "/repos/acme/repo/issues",
}, "Literal REST path remains unchanged.");

const gql: PlanRequest = {
  protocol: "graphql", document: "mutation Update($input: UpdateInput!) { update(input: $input) { id } }",
  operationName: "Update",
  variables: { input: { id: ref("CHILD.nodeId"), children: [ref("M1.number"), "literal"] } },
};
equal(requestReferences(gql), ["CHILD", "M1"], "GraphQL scan must include nested variables.");
equal(bindPlanRequest(gql, bindings), {
  protocol: "graphql", document: gql.document, operationName: "Update",
  variables: { input: { id: "I_child", children: [7, "literal"] } },
}, "GraphQL bindings must preserve document and types.");
throwsCode(() => bindPlanRequest(nested, { CHILD: { id: 87321 } }), "UNRESOLVED_PLAN_REFERENCE");
throwsCode(() => bindPlanRequest(nested, { CHILD: { id: 87321, number: 75, nodeId: "I_child" } }), "UNRESOLVED_PLAN_REFERENCE");
throwsCode(() => bindPlanRequest({ protocol: "rest", method: "POST", path: ["/x/", ref("CHILD.id")] }, {
  CHILD: { id: 0 },
}), "UNRESOLVED_PLAN_REFERENCE");
throwsCode(() => bindPlanRequest({ protocol: "rest", method: "POST", path: "/x", body: ref("CHILD.id.extra") }, bindings),
  "INVALID_PLAN_REFERENCE");
throwsCode(() => bindPlanRequest({
  protocol: "rest", method: "POST", path: "/x",
  body: { $ref: "CHILD.id", extra: 1 } as unknown as PlanRequest & never,
}, bindings), "INVALID_PLAN_REFERENCE");
// Inherited properties must not satisfy a binding.
const inherited = Object.create({ CHILD: { id: 87321 } }) as typeof bindings;
throwsCode(() => bindPlanRequest({ protocol: "rest", method: "GET", path: ["/", ref("CHILD.id")] }, inherited),
  "UNRESOLVED_PLAN_REFERENCE");

function step(id: string, kind: PlanStep["kind"], logicalId: string, dependsOn: string[],
  request?: PlanRequest, status: PlanStep["status"] = "planned"): PlanStep {
  return {
    id, kind, logicalId, status, current: null, desired: null, reason: "fixture",
    dependsOn, ...(request === undefined ? {} : { request }), preconditions: [],
    expectedPostconditions: [], destructive: false, reversible: true,
  };
}
const createChild = step("issue.create:CHILD", "issue.create", "CHILD", [], {
  protocol: "rest", method: "POST", path: "/repos/acme/repo/issues", body: { title: "Child" },
});
const attach = step("issue.parent.set:CHILD", "issue.parent.set", "CHILD", ["issue.create:CHILD"], {
  protocol: "rest", method: "POST", path: "/repos/acme/repo/issues/42/sub_issues",
  body: { sub_issue_id: ref("CHILD.id") },
});
equal(validatePlanStepReferences([createChild, attach]), [], "Producer in dependsOn is valid.");
equal(validatePlanStepReferences([attach, createChild]), [], "Validation must not depend on input ordering.");
let diagnostics = validatePlanStepReferences([createChild, { ...attach, dependsOn: [] }]);
equal(diagnostics.length, 1, "Missing dependsOn must block.");
equal(diagnostics[0]?.code, "UNRESOLVED_REFERENCE", "Missing dependency diagnostic.");
diagnostics = validatePlanStepReferences([attach]);
equal(diagnostics.length, 1, "Missing producer must block.");
diagnostics = validatePlanStepReferences([
  { ...createChild, status: "noop" }, attach,
]);
equal(diagnostics.length, 1, "Non-planned producer is not an executable create.");
diagnostics = validatePlanStepReferences([createChild, { ...createChild, id: "issue.create:CHILD-copy" }, attach]);
equal(diagnostics.length, 1, "Ambiguous producers must block.");
diagnostics = validatePlanStepReferences([
  step("issue.create:CHILD", "issue.create", "CHILD", ["issue.create:CHILD"], {
    protocol: "rest", method: "POST", path: ["/", ref("CHILD.id")],
  }),
]);
equal(diagnostics.length, 1, "Self dependency must block.");
diagnostics = validatePlanStepReferences([
  createChild, { ...attach, request: { protocol: "rest", method: "POST", path: "/x", body: ref("invalid?") } },
]);
equal(diagnostics[0]?.code, "INVALID_SCHEMA", "Malformed reference should be a structured blocker.");

console.log("Late-bound request binding and DAG reference fixtures passed.");
