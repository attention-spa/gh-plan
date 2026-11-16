import {
  normalizeSchema, diffGithubState, compileIssueLabelSteps, planGithub,
  bindPlanRequest, validatePlanStepReferences,
} from "../src/index.ts";
import type {
  FetchLike, FetchResponseLike, GithubStateSnapshot, NormalizedDesiredStateGraph,
  ResourceResolution, PlanStep,
} from "../src/index.ts";

function assert(test: unknown, message: string): asserts test {
  if (!test) throw Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(message + "\nExpected: " + JSON.stringify(expected) + "\nActual: " + JSON.stringify(actual));
}
const repository = { fullName: "sample/widgets" };
const catalog = [{ name: "bug" }, { name: "enhancement" }, { name: "triage" }];
const observed: GithubStateSnapshot = {
  repository, labels: catalog,
  milestones: [], issueTypes: [], issueFields: [],
  issues: [
    { kind: "issue", number: 12, id: 120, title: "A", state: "open",
      body: "<!-- gh-plan:A -->", labels: ["bug", "triage"],
      parentNumber: null, blockedByNumbers: [], relatesToNumbers: [] },
  ],
};
const existing: ResourceResolution = { logicalId: "A", kind: "issue", status: "existing",
  identity: { number: 12, id: 120 } };
const newer: ResourceResolution = { logicalId: "N", kind: "issue", status: "new" };
const make = (resource: object, snap = observed, resolutions: ResourceResolution[] = [existing]) => {
  const desired = normalizeSchema({ repository: repository.fullName, issues: [resource] });
  assert(desired.graph, "Expected valid normalized graph: " + JSON.stringify(desired.diagnostics));
  const diff = diffGithubState(desired.graph, snap, resolutions);
  return { graph: desired.graph, diff,
    output: compileIssueLabelSteps(desired.graph, diff, snap, resolutions) };
};
const res = (labels: unknown) => ({ logicalId: "A", identity: { number: 12 }, labels });
let r = make(res(["triage", "bug"]));
equal(r.output.steps, [], "Label order does not require a write.");
equal(r.output.noops.length, 1, "Already satisfied exact set emits noop.");
equal(r.diff.diffs.find((d) => d.id === "issue.labels:A")?.status, "noop",
  "Semantic label comparison is unordered.");

r = make(res(["enhancement"]));
equal(r.output.steps[0]?.request, {
  protocol: "rest", method: "PUT",
  path: "/repos/sample/widgets/issues/12/labels", body: { labels: ["enhancement"] },
}, "Exact set replaces all issue labels.");
equal(r.output.steps[0]?.reversible, true, "Exact set is reversible.");

r = make(res({ add: ["enhancement"], remove: ["triage"] }));
equal(r.output.steps.map((s) => s.kind), ["issue.label.add", "issue.label.remove"],
  "Targeted add/remove both planned.");
const deletion = r.output.steps.find((s) => s.kind === "issue.label.remove")!;
const addition = r.output.steps.find((s) => s.kind === "issue.label.add")!;
equal(deletion.request, {
  protocol: "rest", method: "DELETE",
  path: "/repos/sample/widgets/issues/12/labels/triage",
}, "Remove only selected label.");
equal(addition.request, {
  protocol: "rest", method: "POST",
  path: "/repos/sample/widgets/issues/12/labels", body: { labels: ["enhancement"] },
}, "Add targeted label without deleting unrelated bug label.");
assert(addition.dependsOn.includes(deletion.id), "Removal must precede add.");
equal(validatePlanStepReferences(r.output.steps), [], "Incremental DAG validates.");

r = make(res({ add: ["BUG"], remove: ["enhancement"] }));
equal(r.output.steps, [], "Adding present label / removing absent label are noops.");
r = make(res({ op: "set", value: [] }));
equal(r.output.steps[0]?.request, {
  protocol: "rest", method: "PUT",
  path: "/repos/sample/widgets/issues/12/labels", body: { labels: [] },
}, "Explicit empty set clears all labels.");

r = make(res(["does-not-exist"]));
equal(r.output.steps, [], "Unknown labels never produce executable writes.");
assert(r.output.blockers.some((d) => d.code === "UNKNOWN_LABEL"), "Unknown label is blocking.");
assert(r.diff.blockers.some((d) => d.code === "UNKNOWN_LABEL"),
  "Unknown label detected by semantic diff.");
r = make(res({ add: ["enhancement"] }),
  { ...observed, labels: [{ name: "enhancement" }, { name: "ENHANCEMENT" }] });
assert(r.output.blockers.some((d) => d.code === "UNKNOWN_LABEL"),
  "Ambiguous catalog case-folded labels block.");
r = make(res(["bug"]), { ...observed, labels: undefined });
assert(r.output.blockers.some((d) => d.code === "UNKNOWN_LABEL"),
  "Missing catalog cannot be mistaken for an empty catalog.");
r = make(res(["bug"]), { ...observed,
  issues: [{ ...observed.issues[0]!, labels: undefined }] });
assert(r.output.blockers.some((d) => d.code === "UNRESOLVED_REFERENCE"),
  "Unobserved issue labels must block exact set.");

r = make({ logicalId: "N", title: "New", labels: ["enhancement", "bug"] },
  observed, [newer]);
equal(r.output.steps.length, 1, "New issue label set is applied after creation.");
equal(r.output.steps[0]?.dependsOn, ["issue.create:N"], "New issue binding is explicit.");
equal(r.output.steps[0]?.request, {
  protocol: "rest", method: "POST",
  path: ["/repos/sample/widgets/issues/", { $ref: "N.number" }, "/labels"],
  body: { labels: ["bug", "enhancement"] },
}, "New issue labels use a targeted post-create request.");
const producer: PlanStep = {
  id: "issue.create:N", kind: "issue.create", logicalId: "N", status: "planned",
  current: null, desired: null, reason: "new", dependsOn: [],
  preconditions: [], expectedPostconditions: [], destructive: false, reversible: "partial",
};
equal(validatePlanStepReferences([producer, ...r.output.steps]), [],
  "New labels have a valid producer in combined DAG.");
equal(bindPlanRequest(r.output.steps[0]!.request!, { N: { number: 99 } }), {
  protocol: "rest", method: "POST",
  path: "/repos/sample/widgets/issues/99/labels",
  body: { labels: ["bug", "enhancement"] },
}, "New issue label reference binds correctly.");

const absent = normalizeSchema({ repository: repository.fullName,
  issues: [{ logicalId: "A", identity: { number: 12 }, title: "A" }] });
assert(absent.graph, "Missing labels is a valid schema.");
assert((absent.graph.resources[0]?.kind === "issue" &&
  absent.graph.resources[0].management === "managed" &&
  absent.graph.resources[0].desired.labels === undefined),
  "Absent labels property is omitted, never implicitly empty.");
for (const labels of [
  ["bug", "BUG"],
  { add: ["bug"], remove: ["BUG"] },
  { op: "set", value: [""] },
  { op: "reset", value: ["bug"] },
  { add: "bug" },
]) {
  const bad = normalizeSchema({ repository: repository.fullName,
    issues: [{ logicalId: "A", labels }] });
  assert(!bad.ok && bad.diagnostics.some((d) => d.code === "INVALID_SCHEMA"),
    "Malformed/duplicate labels must block normalization.");
}
equal(normalizeSchema({ repository: repository.fullName, issues: [
  { logicalId: "A", labels: { add: ["enhancement"], remove: ["triage"] } },
] }).graph?.resources[0], {
  logicalId: "A", kind: "issue", management: "managed",
  desired: { labels: { op: "modify", add: ["enhancement"], remove: ["triage"] } },
}, "Incremental operation normalization produces explicit intent.");

const fixtureBase = "https://api.github.com/repos/sample/widgets";
function response(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300, status,
    statusText: status === 404 ? "Not Found" : "OK",
    headers: { get() { return null; } },
    async json() { return body; }, async text() { return JSON.stringify(body); },
  };
}
function fetchWithLabels(applied: boolean, calls: string[]): FetchLike {
  return async (url, init) => {
    calls.push(url);
    assert(init?.method === "GET", "Planner may only read REST.");
    if (url === fixtureBase) return response(200, {
      id: 111, full_name: repository.fullName, owner: { type: "User", login: "sample" },
    });
    if (url === fixtureBase + "/issues?state=all&per_page=100") return response(200, applied ?
      [{ number: 12, id: 120, title: "A", body: "<!-- gh-plan:A -->",
        state: "open", labels: [{ name: "bug" }, { name: "triage" }] }] : []);
    if (url === fixtureBase + "/labels?per_page=100") return response(200,
      catalog.map((label, index) => ({ ...label, id: index + 1 })));
    if (url === fixtureBase + "/milestones?state=all&per_page=100") return response(200, []);
    if (url === fixtureBase + "/issue-types") return response(200, []);
    if (url === fixtureBase + "/issues/12/parent") return response(404, {});
    if (url === fixtureBase + "/issues/12/dependencies/blocked_by?per_page=100" ||
      url === fixtureBase + "/issues/12/relates_to?per_page=100") return response(200, []);
    throw Error("Unexpected REST request " + url);
  };
}
let calls: string[] = [];
let plan = await planGithub({
  schema: { repository: repository.fullName, issues: [
    { logicalId: "A", title: "A", labels: ["bug", "triage"] },
  ] }, auth: "fixture-secret", fetch: fetchWithLabels(true, calls),
});
equal(plan.readiness, "ready", "Fully applied labels produce a ready plan.");
equal(plan.steps, [], "Applied labels require no executable mutations.");
assert(plan.noops.some((s) => s.kind === "issue.label.set"),
  "Complete plan includes label noop.");
assert(calls.includes(fixtureBase + "/labels?per_page=100"),
  "Desired labels trigger catalog discovery.");
calls = [];
plan = await planGithub({
  schema: { repository: repository.fullName, issues: [
    { logicalId: "N", title: "New", labels: ["enhancement"] },
  ] }, auth: "fixture-secret", fetch: fetchWithLabels(false, calls),
});
equal(plan.readiness, "ready", "New issue and labels compile into ready plan.");
equal(plan.steps.map((s) => s.kind), ["issue.create", "issue.label.add"],
  "New create followed by targeted label request.");
assert(plan.steps[1]?.dependsOn.includes(plan.steps[0]!.id),
  "Label request happens after issue creation.");
const planWithoutLabels = await planGithub({
  schema: { repository: repository.fullName, issues: [
    { logicalId: "N", title: "New" },
  ] }, auth: "fixture-secret", fetch: fetchWithLabels(false, calls = []),
});
assert(!calls.includes(fixtureBase + "/labels?per_page=100"),
  "Unmanaged labels avoid unnecessary catalog calls.");
assert(!planWithoutLabels.steps.some((s) => s.kind.startsWith("issue.label.")),
  "Omitted labels never mutate existing labels.");
console.log("Issue label schema, REST, diff and planner fixtures passed.");
