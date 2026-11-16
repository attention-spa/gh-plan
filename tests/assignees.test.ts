import {
  normalizeSchema, diffGithubState, compileIssueAssigneeSteps, planGithub,
  bindPlanRequest, validatePlanStepReferences, createRestDiscoveryTransport,
} from "../src/index.ts";
import type {
  FetchLike, FetchResponseLike, GithubStateSnapshot, ResourceResolution, PlanStep,
} from "../src/index.ts";

function assert(test: unknown, message: string): asserts test {
  if (!test) throw Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(message + "\nExpected: " + JSON.stringify(expected) +
      "\nActual: " + JSON.stringify(actual));
  }
}
const repository = { fullName: "sample/widgets" };
const snapshot: GithubStateSnapshot = {
  repository, issues: [
    { kind: "issue", number: 12, id: 120, title: "A", state: "open",
      body: "<!-- gh-plan:A -->", assignees: ["Alice", "Bob"],
      parentNumber: null, blockedByNumbers: [], relatesToNumbers: [] },
  ], milestones: [], issueTypes: [], issueFields: [],
  assigneeEligibility: { alice: true, bob: true, carol: true, dave: false },
};
const existing: ResourceResolution = { logicalId: "A", kind: "issue", status: "existing",
  identity: { number: 12, id: 120 } };
const newer: ResourceResolution = { logicalId: "N", kind: "issue", status: "new" };
const resource = (assignees: unknown) => ({ logicalId: "A", identity: { number: 12 }, assignees });
function make(issue: object, observed = snapshot, resolutions: ResourceResolution[] = [existing]) {
  const parsed = normalizeSchema({ repository: repository.fullName, issues: [issue] });
  assert(parsed.graph && parsed.ok, "Expected normalized desired schema: " +
    JSON.stringify(parsed.diagnostics));
  const diff = diffGithubState(parsed.graph, observed, resolutions);
  const output = compileIssueAssigneeSteps(parsed.graph, diff, observed, resolutions);
  return { graph: parsed.graph, diff, output };
}

let r = make(resource(["bob", "ALICE"]));
equal(r.diff.diffs.find((d) => d.id === "issue.assignees:A")?.status, "noop",
  "Assignee ordering and login case are semantically irrelevant.");
equal(r.output.steps, [], "Matching exact assignee set needs no write.");
equal(r.output.noops.length, 1, "Matching set should have a noop.");

r = make(resource(["Carol"]));
equal(r.output.steps.map((s) => s.kind), ["issue.assignee.add", "issue.assignee.remove"],
  "Exact set plans only necessary add/remove deltas.");
const removal = r.output.steps.find((s) => s.kind === "issue.assignee.remove")!;
const addition = r.output.steps.find((s) => s.kind === "issue.assignee.add")!;
equal(removal.request, { protocol: "rest", method: "DELETE",
  path: "/repos/sample/widgets/issues/12/assignees", body: { assignees: ["Alice", "Bob"] } },
  "Set removes all undesired existing assignees using DELETE body.");
equal(addition.request, { protocol: "rest", method: "POST",
  path: "/repos/sample/widgets/issues/12/assignees", body: { assignees: ["Carol"] } },
  "Set adds only missing assignees using POST body.");
equal(addition.dependsOn, [removal.id], "Removal must precede addition.");
equal(validatePlanStepReferences(r.output.steps), [], "Assignee reconciliation DAG is valid.");

r = make(resource({ add: ["Carol"], remove: ["bob"] }));
equal(r.output.steps.find((s) => s.kind === "issue.assignee.remove")?.request, {
  protocol: "rest", method: "DELETE", path: "/repos/sample/widgets/issues/12/assignees",
  body: { assignees: ["Bob"] },
}, "Incremental removal is targeted and uses observed login casing.");
equal(r.output.steps.find((s) => s.kind === "issue.assignee.add")?.request, {
  protocol: "rest", method: "POST", path: "/repos/sample/widgets/issues/12/assignees",
  body: { assignees: ["Carol"] },
}, "Incremental addition preserves unmentioned Alice.");

r = make(resource({ add: ["ALICE"], remove: ["departed-user"] }));
equal(r.output.steps, [], "No writes for already-added login and absent removed login.");
equal(r.output.noops.length, 1, "Incremental no-op is explicit.");
r = make(resource({ add: [], remove: ["Bob"] }));
equal(r.output.steps.map((s) => s.kind), ["issue.assignee.remove"],
  "Removal-only plan does not need an eligibility lookup.");
r = make(resource({ op: "set", value: [] }));
equal(r.output.steps.map((s) => s.kind), ["issue.assignee.remove"],
  "Explicit empty set clears existing assignees.");
equal(r.output.steps[0]?.request, { protocol: "rest", method: "DELETE",
  path: "/repos/sample/widgets/issues/12/assignees",
  body: { assignees: ["Alice", "Bob"] } }, "Empty set must not issue ambiguous PATCH.");

r = make(resource(["dave"]));
assert(r.diff.blockers.some((d) => d.code === "UNKNOWN_ASSIGNEE"),
  "Ineligible login must block semantic diff.");
equal(r.output.steps, [], "Ineligible assignees never produce assignment requests.");
r = make(resource(["Carol"]), { ...snapshot, assigneeEligibility: undefined });
assert(r.diff.blockers.some((d) => d.code === "UNKNOWN_ASSIGNEE"),
  "Missing eligibility evidence cannot be treated as eligible.");
r = make(resource(["Carol"]), { ...snapshot,
  issues: [{ ...snapshot.issues[0]!, assignees: undefined }] });
assert(r.diff.blockers.some((d) => d.code === "UNRESOLVED_REFERENCE"),
  "Undiscovered current assignees must block reconciliation.");

r = make({ logicalId: "N", title: "New", assignees: ["Carol", "Alice"] },
  snapshot, [newer]);
equal(r.output.steps.length, 1, "New issue assigns requested users after creation.");
equal(r.output.steps[0]?.kind, "issue.assignee.add", "New issue uses POST.");
equal(r.output.steps[0]?.dependsOn, ["issue.create:N"],
  "Assignment of a new issue depends on creation.");
equal(r.output.steps[0]?.request, {
  protocol: "rest", method: "POST",
  path: ["/repos/sample/widgets/issues/", { $ref: "N.number" }, "/assignees"],
  body: { assignees: ["Alice", "Carol"] },
}, "New issue request has a late-bound number and deterministic login order.");
const producer: PlanStep = {
  id: "issue.create:N", kind: "issue.create", logicalId: "N", status: "planned",
  current: null, desired: null, reason: "New", dependsOn: [],
  preconditions: [], expectedPostconditions: [], destructive: false, reversible: "partial",
};
equal(validatePlanStepReferences([producer, ...r.output.steps]), [],
  "New issue assignment references its create producer.");
equal(bindPlanRequest(r.output.steps[0]!.request!, { N: { number: 88 } }), {
  protocol: "rest", method: "POST", path: "/repos/sample/widgets/issues/88/assignees",
  body: { assignees: ["Alice", "Carol"] },
}, "New issue assignment reference binds at execution time.");
r = make({ logicalId: "N", title: "New", assignees: [] }, snapshot, [newer]);
equal(r.output.steps, [], "Explicitly empty new issue assignees require no request.");
equal(r.output.noops.length, 1, "Empty new issue set produces noop.");

const absent = normalizeSchema({ repository: repository.fullName,
  issues: [{ logicalId: "A", identity: { number: 12 }, title: "A" }] });
assert(absent.graph?.resources[0]?.kind === "issue" &&
  absent.graph.resources[0].management === "managed" &&
  absent.graph.resources[0].desired.assignees === undefined,
  "Missing assignees must remain untouched (never an implicit empty set).");

for (const assignees of [
  ["alice", "ALICE"], ["bad login"], ["-alice"], ["alice-"], [""],
  [123], { op: "set", value: "alice" }, { op: "clear" },
  { add: ["alice"], remove: ["ALICE"] }, { add: "alice" },
]) {
  const result = normalizeSchema({ repository: repository.fullName,
    issues: [{ logicalId: "A", assignees }] });
  assert(!result.ok && result.diagnostics.some((d) => d.code === "INVALID_SCHEMA"),
    "Malformed, duplicate or contradictory logins must block normalization: " +
    JSON.stringify(assignees));
}
equal(normalizeSchema({ repository: repository.fullName,
  issues: [{ logicalId: "A", assignees: { add: ["Carol"], remove: ["Bob"] } }],
}).graph?.resources[0], {
  logicalId: "A", kind: "issue", management: "managed",
  desired: { assignees: { op: "modify", add: ["Carol"], remove: ["Bob"] } },
}, "Incremental schema is normalized.");
const reference = normalizeSchema({ repository: repository.fullName,
  issues: [{ logicalId: "A", management: "reference", assignees: [] }] });
assert(!reference.ok, "Reference-only issues must reject assignee ownership.");

const url = "https://api.github.com/repos/sample/widgets";
function response(status: number, body: unknown = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300, status,
    statusText: status === 404 ? "Not Found" : "OK",
    headers: { get() { return null; } },
    async json() {
      if (status === 204) throw Error("204 responses have no JSON payload");
      return body;
    },
    async text() { return JSON.stringify(body); },
  };
}
function fake(eligible: boolean, calls: string[], missingCurrent = false): FetchLike {
  return async (request, init) => {
    calls.push(request);
    assert(init?.method === "GET", "The planner must never execute writes.");
    if (request === url) return response(200, {
      id: 1, full_name: repository.fullName, owner: { login: "sample", type: "User" },
    });
    if (request === url + "/issues?state=all&per_page=100") return response(200, [{
      id: 120, number: 12, title: "A", body: "<!-- gh-plan:A -->", state: "open",
      ...(missingCurrent ? {} : { assignees: [{ login: "Alice" }, { login: "Bob" }] }),
    }]);
    if (request === url + "/milestones?state=all&per_page=100" ||
      request === url + "/issue-types") return response(200, []);
    if (request === url + "/issues/12/parent") return response(404);
    if (request === url + "/issues/12/dependencies/blocked_by?per_page=100" ||
      request === url + "/issues/12/relates_to?per_page=100") return response(200, []);
    if (request === url + "/assignees/Carol") return response(eligible ? 204 : 404);
    throw Error("Unexpected request: " + request);
  };
}
let calls: string[] = [];
let plan = await planGithub({
  schema: { repository: repository.fullName, issues: [
    { logicalId: "A", identity: { number: 12 }, assignees: { add: ["Carol"] } },
  ] }, auth: "fixture-secret", fetch: fake(true, calls),
});
equal(plan.readiness, "ready", "Eligible assignee supports a ready plan.");
equal(plan.steps.filter((s) => s.kind.startsWith("issue.assignee.")).map((s) => s.kind),
  ["issue.assignee.add"], "End-to-end assignment is incremental.");
assert(calls.includes(url + "/assignees/Carol"),
  "Explicit new assignee triggers repository eligibility check.");
assert(!JSON.stringify(plan).includes("fixture-secret"),
  "Plan output must never leak the GitHub token.");

calls = [];
plan = await planGithub({
  schema: { repository: repository.fullName, issues: [
    { logicalId: "A", identity: { number: 12 }, assignees: ["Carol"] },
  ] }, auth: "fixture-secret", fetch: fake(false, calls),
});
equal(plan.readiness, "blocked", "404 ineligible login blocks the plan.");
assert(plan.blockers.some((d) => d.code === "UNKNOWN_ASSIGNEE"),
  "204/404 eligibility result maps to UNKNOWN_ASSIGNEE.");

calls = [];
plan = await planGithub({
  schema: { repository: repository.fullName, issues: [
    { logicalId: "A", identity: { number: 12 }, assignees: { remove: ["Bob"] } },
  ] }, auth: "fixture-secret", fetch: fake(false, calls),
});
equal(plan.readiness, "ready", "Removal remains valid without eligibility lookup.");
assert(!calls.some((path) => path.includes("/assignees/")),
  "Removal-only plans never query assignment eligibility.");

calls = [];
plan = await planGithub({
  schema: { repository: repository.fullName, issues: [
    { logicalId: "A", identity: { number: 12 }, title: "A" },
  ] }, auth: "fixture-secret", fetch: fake(true, calls),
});
assert(!calls.some((path) => path.includes("/assignees/")),
  "Omitted assignees do not trigger eligibility checks.");
assert(!plan.steps.some((step) => step.kind.startsWith("issue.assignee.")),
  "Omitted assignees never mutate assignment.");

const transport = createRestDiscoveryTransport({ auth: "fixture-secret", fetch: fake(true, []) });
const invalid = make(resource(["Carol"]), { ...snapshot,
  issues: [{ ...snapshot.issues[0]!, assignees: undefined }] });
equal(invalid.output.steps, [], "Missing assignee discovery never yields a write.");
void transport;
console.log("Issue assignee schema, eligibility, diff, compiler, and plan fixtures passed.");
