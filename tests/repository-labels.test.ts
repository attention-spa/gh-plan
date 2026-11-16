import {
  normalizeSchema, diffGithubState, compileRepositoryLabelSteps,
  compileIssueLabelSteps, planGithub, bindPlanRequest, validatePlanStepReferences,
} from "../src/index.ts";
import type {
  FetchLike, FetchResponseLike, GithubStateSnapshot, ResourceResolution,
  NormalizedDesiredStateGraph, PlanStep,
} from "../src/index.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(message + "\nExpected: " + JSON.stringify(expected) +
      "\nActual: " + JSON.stringify(actual));
  }
}
const repo = "sample/widgets", base = "https://api.github.com/repos/sample/widgets";
const catalog = [
  { name: "bug", id: 1, color: "112233", description: "Bug reports" },
  { name: "work needed", id: 2, color: "aa0011", description: null },
];
const current: GithubStateSnapshot = {
  repository: { fullName: repo },
  issues: [{
    kind: "issue", number: 12, id: 120, title: "A", state: "open",
    body: "<!-- gh-plan:A -->", labels: ["bug"],
    parentNumber: null, blockedByNumbers: [], relatesToNumbers: [],
  }],
  milestones: [], issueTypes: [], issueFields: [], labels: catalog,
};
const resolution: ResourceResolution = {
  kind: "issue", logicalId: "A", status: "existing", identity: { number: 12, id: 120 },
};
const newResolution: ResourceResolution = {
  kind: "issue", logicalId: "N", status: "new",
};
function build(schema: object, snapshot: GithubStateSnapshot = current,
  resolutions: ResourceResolution[] = []) {
  const normalized = normalizeSchema({ repository: repo, ...schema });
  assert(normalized.ok && normalized.graph, "Fixture normalization failed: " +
    JSON.stringify(normalized.diagnostics));
  const diff = diffGithubState(normalized.graph, snapshot, resolutions);
  const repositoryLabels = compileRepositoryLabelSteps(normalized.graph, diff, snapshot);
  const issueLabels = compileIssueLabelSteps(normalized.graph, diff, snapshot, resolutions);
  return { graph: normalized.graph, diff, repositoryLabels, issueLabels };
}

// Input supports optional logicalId, name, optional metadata, and management.
let r = build({ labels: [
  { name: "work needed", color: "AA0011", description: "" },
  { name: "bug", management: "reference" },
] });
equal(r.graph.labels?.map((x) => x.logicalId), ["label:bug", "label:work%20needed"],
  "Logical IDs are deterministic and labels are sorted by name.");
equal(r.graph.labels?.[1]?.color, "aa0011", "Colors are normalized to lowercase.");
equal(r.repositoryLabels.steps[0]?.request, {
  protocol: "rest", method: "PATCH",
  path: "/repos/sample/widgets/labels/work%20needed",
  body: { description: "" },
}, "Existing label update touches only changed metadata, preserving name and color.");
equal(r.diff.diffs.find((d) => d.id === "label.color:label:work%20needed")?.status,
  "noop", "Color comparison is case insensitive.");
equal(r.diff.diffs.find((d) => d.id === "label.description:label:work%20needed")?.status,
  "update", "Explicit empty string clears a null description.");
assert(!r.repositoryLabels.steps.some((s) => s.kind === "label.create"),
  "Reference-only labels and existing managed labels never create labels.");

r = build({ labels: [{ name: "bug" }] });
equal(r.repositoryLabels.steps, [], "Omitted metadata on existing labels is untouched.");
equal(r.repositoryLabels.noops.length, 1, "Existing label with omitted metadata is noop.");
equal(r.diff.diffs, [], "Omitted label metadata makes no semantic update.");
r = build({ labels: [{ name: "BUG", color: "112233", description: "Bug reports" }] });
equal(r.repositoryLabels.steps, [], "Case differences in a label identity do not rename it.");
equal(r.repositoryLabels.noops.length, 1, "Matching label metadata is noop.");

r = build({ labels: [{ logicalId: "newlabel", name: "Release Review", description: "Release checks" }] });
equal(r.diff.diffs[0]?.status, "create", "Absent managed label produces create semantic diff.");
equal(r.repositoryLabels.steps[0]?.id, "label.create:newlabel", "Label create has stable logical step ID.");
equal(r.repositoryLabels.steps[0]?.request, {
  protocol: "rest", method: "POST", path: "/repos/sample/widgets/labels",
  body: { name: "Release Review", color: "ededed", description: "Release checks" },
}, "Create uses a deterministic neutral color when optional color is omitted.");
equal(r.repositoryLabels.steps[0]?.reversible, "partial",
  "Creating a label is only partially reversible because deletion is out of scope.");
r = build({ labels: [{ name: "NEW", color: "7F00FF" }] });
equal(r.repositoryLabels.steps[0]?.request, {
  protocol: "rest", method: "POST", path: "/repos/sample/widgets/labels",
  body: { name: "NEW", color: "7f00ff" },
}, "Explicit color is preserved without a default description.");

r = build({ labels: [{ logicalId: "edit", name: "bug",
  color: "abcdef", description: "Needs repro" }] });
equal(r.repositoryLabels.steps[0]?.request, {
  protocol: "rest", method: "PATCH", path: "/repos/sample/widgets/labels/bug",
  body: { color: "abcdef", description: "Needs repro" },
}, "Both explicitly changed fields are compiled into one PATCH.");
assert(!JSON.stringify(r.repositoryLabels).includes("new_name"),
  "Name is identity: patch must never rename labels.");
assert(!r.repositoryLabels.steps.some((s) => s.request?.protocol === "rest" &&
  s.request.method === "DELETE"), "Repository labels are never deleted.");

r = build({ labels: [{ name: "bug", management: "reference" }] });
equal(r.repositoryLabels.steps, [], "Existing reference-only label does not mutate.");
r = build({ labels: [{ name: "unknown", management: "reference" }] });
assert(r.diff.blockers.some((d) => d.code === "UNKNOWN_LABEL"),
  "Nonexistent reference-only label blocks planning.");
equal(r.repositoryLabels.steps, [], "A reference label is not implicitly created.");

r = build({ labels: [{ name: "bug", color: "abcdef" }] },
  { ...current, labels: [...catalog, { ...catalog[0]!, name: "BUG" }] });
assert(r.diff.blockers.some((d) => d.code === "AMBIGUOUS_IDENTITY"),
  "Case-folded duplicate observed labels block identity.");
equal(r.repositoryLabels.steps, [], "Ambiguous label identity yields no write.");
r = build({ labels: [{ name: "bug", color: "abcdef" }] },
  { ...current, labels: undefined });
assert(r.diff.blockers.some((d) => d.code === "UNRESOLVED_REFERENCE"),
  "Missing label catalog blocks even creation.");

for (const raw of [
  { name: "" }, { name: " padded " }, { name: "bug", color: "#abcdef" },
  { name: "bug", color: "fff" }, { name: "bug", color: null },
  { name: "bug", description: "x".repeat(101) },
  { name: "bug", management: "reference", color: "abcdef" },
  { name: "bug", management: "reference", description: "unsafe" },
  { name: "bug", management: "unsupported" },
  { name: "bug", logicalId: "no spaces" },
]) {
  const invalid = normalizeSchema({ repository: repo, labels: [raw] });
  assert(!invalid.ok && invalid.diagnostics.some((d) => d.code === "INVALID_SCHEMA"),
    "Invalid label schema must block normalization: " + JSON.stringify(raw));
}
for (const labels of [[{ name: "bug" }, { name: "BUG" }], [{ name: "bug", logicalId: "A" }],
  [{ name: "bug" }, { name: "x", logicalId: "label:bug" }]]) {
  const invalid = normalizeSchema({ repository: repo, labels, issues: [{ logicalId: "A" }] });
  assert(!invalid.ok, "Duplicate name or logical ID cannot be accepted.");
}
assert(!normalizeSchema({ repository: repo, labels: "bug" }).ok,
  "Root labels must be an array.");
assert(!normalizeSchema({ repository: repo, labels: [null] }).ok,
  "Label array items must be objects.");

// A missing managed label is a valid target for new and existing issue labels.
r = build({ labels: [{ logicalId: "futureLabel", name: "Future Work", color: "00aa00" }],
  issues: [{ logicalId: "A", identity: { number: 12 },
    labels: ["bug", "future work"] }] }, current, [resolution]);
equal(r.diff.blockers, [], "Managed missing label resolves issue label reference.");
equal(r.issueLabels.steps[0]?.request, {
  protocol: "rest", method: "PUT",
  path: "/repos/sample/widgets/issues/12/labels",
  body: { labels: ["bug", "Future Work"] },
}, "Exact issue set resolves the future label to its declared canonical name.");
equal(r.issueLabels.steps[0]?.dependsOn, ["label.create:futureLabel"],
  "Issue-label exact set waits for repository label creation.");
equal(validatePlanStepReferences([...r.repositoryLabels.steps, ...r.issueLabels.steps]), [],
  "Cross-resource dependency is satisfied.");

r = build({ labels: [{ name: "Future Work" }],
  issues: [{ logicalId: "A", identity: { number: 12 },
    labels: { add: ["future work"], remove: ["bug"] } }] }, current, [resolution]);
const add = r.issueLabels.steps.find((s) => s.kind === "issue.label.add")!;
const rem = r.issueLabels.steps.find((s) => s.kind === "issue.label.remove")!;
equal(add.dependsOn, [rem.id, "label.create:label:future%20work"],
  "Add request waits for removal and label creation, retaining other labels.");
equal(add.request, { protocol: "rest", method: "POST",
  path: "/repos/sample/widgets/issues/12/labels", body: { labels: ["Future Work"] } },
  "Future label add uses canonical root declaration.");
equal(rem.request, { protocol: "rest", method: "DELETE",
  path: "/repos/sample/widgets/issues/12/labels/bug" },
  "Unrelated repository label is never deleted when removed from an issue.");

r = build({ labels: [{ name: "Future Work" }],
  issues: [{ logicalId: "N", title: "New", labels: ["future work"] }] },
  current, [newResolution]);
equal(r.issueLabels.steps[0]?.dependsOn,
  ["issue.create:N", "label.create:label:future%20work"],
  "New issue assignment depends on both issue creation and label creation.");
const createIssue: PlanStep = {
  id: "issue.create:N", kind: "issue.create", logicalId: "N",
  status: "planned", current: null, desired: null, reason: "fixture", dependsOn: [],
  preconditions: [], expectedPostconditions: [], destructive: false, reversible: "partial",
};
equal(validatePlanStepReferences([
  createIssue, ...r.repositoryLabels.steps, ...r.issueLabels.steps,
]), [], "New issue + new repository label has a valid plan DAG.");
equal(bindPlanRequest(r.issueLabels.steps[0]!.request!, { N: { number: 42 } }), {
  protocol: "rest", method: "POST", path: "/repos/sample/widgets/issues/42/labels",
  body: { labels: ["Future Work"] },
}, "Late-bound issue number is materialized without binding label identity.");

r = build({ labels: [{ name: "Future Work", management: "reference" }],
  issues: [{ logicalId: "A", identity: { number: 12 },
    labels: { add: ["future work"] } }] }, current, [resolution]);
assert(r.diff.blockers.some((d) => d.code === "UNKNOWN_LABEL"),
  "Missing reference label still blocks issue-level assignment.");
equal(r.issueLabels.steps, [], "No issue request is emitted for missing reference label.");
r = build({ issues: [{ logicalId: "A", identity: { number: 12 },
  labels: ["missing"] }] }, current, [resolution]);
assert(r.diff.blockers.some((d) => d.code === "UNKNOWN_LABEL"),
  "Unknown labels remain blocking when not managed at root.");

// End-to-end read-only REST orchestration, including create before assignment.
function response(status: number, body: unknown = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status, statusText: status === 404 ? "Not Found" : "OK",
    headers: { get() { return null; } },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}
function fixtureFetch(calls: string[], existingIssue: boolean): FetchLike {
  return async (url, init) => {
    calls.push(url);
    assert(init?.method === "GET", "Planner must never mutate GitHub.");
    if (url === base) return response(200, {
      id: 333, full_name: repo, owner: { type: "User", login: "sample" },
    });
    if (url === base + "/issues?state=all&per_page=100") return response(200, existingIssue ? [{
      id: 120, number: 12, title: "A", body: "<!-- gh-plan:A -->",
      state: "open", labels: [{ name: "bug" }],
    }] : []);
    if (url === base + "/labels?per_page=100") return response(200, catalog);
    if (url === base + "/milestones?state=all&per_page=100" ||
      url === base + "/issue-types") return response(200, []);
    if (url === base + "/issues/12/parent") return response(404);
    if (url === base + "/issues/12/dependencies/blocked_by?per_page=100" ||
      url === base + "/issues/12/relates_to?per_page=100") return response(200, []);
    throw Error("Unexpected REST call " + url);
  };
}
let calls: string[] = [];
let plan = await planGithub({
  schema: {
    repository: repo,
    labels: [{ logicalId: "release", name: "Release Review", color: "abc123" }],
    issues: [{ logicalId: "A", identity: { number: 12 }, labels: ["bug", "Release Review"] }],
  },
  auth: "fixture-token", fetch: fixtureFetch(calls, true),
});
equal(plan.readiness, "ready", "Managed label + existing issue produces a ready plan.");
equal(plan.desired.resourceCount, 2, "Desired root labels count as managed resources.");
equal(plan.steps.map((s) => s.kind), ["label.create", "issue.label.set"],
  "Repository label creation must occur before issue label set.");
assert(plan.steps[1]?.dependsOn.includes(plan.steps[0]!.id),
  "Issue assignment waits for root label create.");
assert(calls.includes(base + "/labels?per_page=100"),
  "Root labels trigger catalog discovery.");
assert(!JSON.stringify(plan).includes("fixture-token"), "Credential must not appear in plan.");
assert(plan.steps.every((s) => s.kind !== ("label.delete" as string)),
  "Repository label deletion is never planned.");

calls = [];
plan = await planGithub({
  schema: {
    repository: repo,
    labels: [{ name: "Future Work" }],
    issues: [{ logicalId: "N", title: "New", labels: ["Future Work"] }],
  },
  auth: "fixture-token", fetch: fixtureFetch(calls, false),
});
equal(plan.readiness, "ready", "New issue with new label is planned successfully.");
assert(plan.steps.findIndex((s) => s.kind === "label.create") <
  plan.steps.findIndex((s) => s.kind === "issue.label.add"),
  "Create repository label before attaching it to new issue.");
assert(plan.steps.findIndex((s) => s.kind === "issue.create") <
  plan.steps.findIndex((s) => s.kind === "issue.label.add"),
  "Create issue before attaching its label.");
equal(validatePlanStepReferences(plan.steps), [],
  "Combined new-label/new-issue plan has valid references.");

calls = [];
plan = await planGithub({
  schema: { repository: repo, labels: [{ name: "bug", color: "112233" }] },
  auth: "fixture-token", fetch: fixtureFetch(calls, false),
});
equal(plan.steps, [], "Applied root metadata produces zero planned writes.");
assert(plan.noops.some((s) => s.kind === "label.update"),
  "Applied root metadata has a label noop.");
calls = [];
plan = await planGithub({
  schema: { repository: repo, issues: [{ logicalId: "N", title: "New" }] },
  auth: "fixture-token", fetch: fixtureFetch(calls, false),
});
assert(!calls.includes(base + "/labels?per_page=100"),
  "No root or issue labels means no catalog discovery.");
assert(!plan.steps.some((s) => s.kind.startsWith("label.")),
  "Omitted labels produce no repository label writes.");

console.log("Managed repository label schema, discovery, diff, REST compiler and DAG fixtures passed.");
