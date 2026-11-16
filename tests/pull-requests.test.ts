import { planGithub, normalizeSchema, compilePullRequestSteps, bindPlanRequest, requestReferences } from "../src/index.ts";
import type { FetchLike, FetchResponseLike, GithubPlanSchema, GithubStateSnapshot } from "../src/index.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function same(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(message +
    "\nactual: " + JSON.stringify(a) + "\nexpected: " + JSON.stringify(b));
}
const repo = "alice/plan", base = "https://api.github.com/repos/" + repo;
function response(status: number, data: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300, status,
    statusText: status === 404 ? "Not Found" : "OK",
    headers: { get() { return null; } },
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}
const pull = (baseRef = "main", draft = false) => ({
  number: 50, id: 500, node_id: "PR_50", title: "Review changes",
  body: "Human copy\n\n<!-- gh-plan:closes:begin -->\nCloses #10\n<!-- gh-plan:closes:end -->",
  state: "open", head: { ref: "feature" }, base: { ref: baseRef },
  draft, merged: false, merged_at: null,
  labels: [{ name: "triage" }], assignees: [{ login: "bob" }],
  requested_reviewers: [{ login: "carol" }],
});
function mock(mode: "new" | "existing" | "missing-head" | "identity", calls: string[]): FetchLike {
  return async (url, options) => {
    calls.push(url);
    check(options?.method === "GET", "All planner I/O must be GET.");
    check(options?.headers?.Authorization === "Bearer secret", "Authorization stays runtime-only.");
    if (url === base) return response(200,
      { id: 1, node_id: "R_1", full_name: repo, owner: { type: "User" } });
    if (url === base + "/issues?state=all&per_page=100") return response(200, [
      { number: 10, id: 100, title: "Implement", body: "Task", state: "open" },
      ...(mode === "existing" || mode === "identity" ? [
        { number: 50, id: 500, title: "Review changes", state: "open",
          pull_request: { url: base + "/pulls/50" } },
        { number: 51, id: 501, title: "Unrelated", state: "open",
          pull_request: { url: base + "/pulls/51" } },
      ] : []),
    ]);
    if (url === base + "/milestones?state=all&per_page=100" ||
        url === base + "/issue-types") return response(200, []);
    if (url === base + "/labels?per_page=100") return response(200,
      [{ name: "triage", id: 11 }]);
    if (url === base + "/assignees/bob") return response(204, null);
    if (url === base + "/pulls?state=open&head=alice%3Afeature&base=main&per_page=100") {
      return response(200, mode === "existing" ? [{ number: 50 }] : []);
    }
    if (url === base + "/pulls/50") return response(200, pull());
    if (url === base + "/pulls/50/requested_reviewers") return response(200,
      { users: [{ login: "carol" }], teams: [] });
    if (url === base + "/git/ref/heads/feature") return response(
      mode === "missing-head" ? 404 : 200, { ref: "heads/feature" });
    if (url === base + "/git/ref/heads/main") return response(200, { ref: "heads/main" });
    if (url === base + "/compare/main...feature") return response(200, { ahead_by: 2 });
    throw Error("Unexpected PR fixture GET: " + url);
  };
}

const desired = {
  repository: repo,
  issues: [{ logicalId: "TASK", management: "reference", identity: { number: 10 } }],
  pullRequests: [{
    logicalId: "PR", head: "feature", base: "main", title: "Review changes",
    reviewers: { add: ["dave"] },
    closes: ["TASK"],
    labels: { add: ["triage"] },
    assignees: { add: ["bob"] },
  }],
} satisfies GithubPlanSchema;

let calls: string[] = [];
let plan = await planGithub({ schema: desired, auth: "secret", fetch: mock("new", calls) });
same(plan.readiness, "ready", "New PR with valid refs must be ready.");
check(plan.steps.some((x) => x.kind === "pull_request.create"), "PR create missing.");
check(!plan.steps.some((x) => x.kind.includes("merge")), "Planner must never plan merging.");
same(plan.desired.resourceCount, 2, "PR is part of desired resource count.");
const created = plan.steps.find((x) => x.kind === "pull_request.create")!;
check(created.request?.protocol === "rest" && created.request.method === "POST", "PR creation must be REST POST.");
check(created.dependsOn.length === 0, "Existing Closes references need no producer dependency.");
check(created.request.protocol === "rest" && JSON.stringify(created.request.body).includes("Closes #10"),
  "Closes block must resolve existing issue identity.");
check(plan.steps.some((x) => x.kind === "issue.label.add") &&
      plan.steps.some((x) => x.kind === "issue.assignee.add") &&
      plan.steps.some((x) => x.kind === "pull_request.reviewer.add"),
  "M4 labels/assignees and reviewer APIs must plan on PRs.");
for (const op of plan.steps.filter((x) => x.kind.startsWith("issue.label") ||
    x.kind.startsWith("issue.assignee") || x.kind.startsWith("pull_request.reviewer"))) {
  check(op.dependsOn.includes("pull_request.create:PR"),
    "PR issue endpoints and reviews must depend on PR creation.");
}
check(calls.some((x) => x.includes("/compare/main...feature")), "New PR must compare commits.");
check(!calls.some((x) => x.includes("/pulls/50")), "New PR must not enrich unrelated existing PRs.");
check(!JSON.stringify(plan).includes("secret"), "Plan must not contain token.");

calls = [];
plan = await planGithub({ schema: desired, auth: "secret", fetch: mock("existing", calls) });
same(plan.readiness, "ready", "Matching open PR should resolve safely.");
check(!plan.steps.some((x) => x.kind === "pull_request.create"), "Existing PR must not be recreated.");
check(plan.resolutions.some((x) => x.kind === "pull_request" && x.status === "existing" &&
  x.identity?.number === 50), "Existing PR must use open head/base identity.");
check(plan.steps.some((x) => x.kind === "pull_request.reviewer.add"), "Reviewer add must be planned.");
check(!calls.some((x) => x.includes("/pulls/51")), "Unrelated PR must not be enriched.");
check(!calls.some((x) => x.includes("/compare/")), "Existing PR does not need new branch comparison.");

calls = [];
plan = await planGithub({ schema: desired, auth: "secret", fetch: mock("missing-head", calls) });
same(plan.readiness, "blocked", "Missing head must block PR creation.");
check(plan.blockers.some((x) => x.code === "PR_BRANCH_INVALID"), "Missing-branch diagnostic.");
check(!plan.steps.some((x) => x.kind === "pull_request.create"), "No create with missing head.");

const invalidPair = normalizeSchema({ repository: repo, pullRequests: [
  { logicalId: "A", head: "feature", base: "main", title: "A" },
  { logicalId: "B", head: "feature", base: "main", title: "B" },
] });
check(!invalidPair.ok && invalidPair.diagnostics.some((x) => x.code === "PR_PAIR_CONFLICT"),
  "Duplicate head/base pair is invalid.");
const badCloses = normalizeSchema({ repository: repo, pullRequests: [
  { logicalId: "P", head: "feature", base: "main", title: "PR", closes: ["UNKNOWN"] },
] });
check(!badCloses.ok, "Closes requires declared issue logical IDs.");

const updated = {
  repository: repo, pullRequests: [{
    logicalId: "PR", head: "feature", base: "release",
    identity: { number: 50 }, title: "Updated title",
  }],
} satisfies GithubPlanSchema;
const graph = normalizeSchema(updated).graph!;
const snapshot: GithubStateSnapshot = {
  repository: { fullName: repo }, issues: [], milestones: [], issueTypes: [], issueFields: [],
  pullRequests: [{
    kind: "pull_request", number: 50, id: 500, title: "Old", body: null,
    state: "open", head: "feature", base: "main", draft: false, merged: false,
    labels: [], assignees: [], requestedReviewers: [],
  }],
};
const compiled = compilePullRequestSteps(graph, snapshot, []);
check(compiled.blockers.length === 0, "Explicit PR number permits base updates.");
check(compiled.steps.some((x) => x.kind === "pull_request.update" &&
  x.request?.protocol === "rest" && JSON.stringify(x.request.body).includes("release")),
  "PR update must PATCH only managed properties.");
const unsupported = compilePullRequestSteps(normalizeSchema({
  repository: repo, pullRequests: [{
    logicalId: "PR", head: "feature", base: "main", identity: { number: 50 },
    draft: true,
  }],
}).graph!, snapshot, []);
check(unsupported.blockers.some((x) => x.code === "PR_DRAFT_UNSUPPORTED") &&
  !unsupported.steps.some((x) => x.kind === "pull_request.update"),
  "Existing REST draft toggle must be blocking and emit no update.");
const newGraph = normalizeSchema({
  repository: repo,
  issues: [{ logicalId: "NEW", title: "New task" }],
  pullRequests: [{ logicalId: "PR", head: "feature", base: "main",
    title: "Deliver", closes: ["NEW"] }],
}).graph!;
const newSnapshot: GithubStateSnapshot = {
  ...snapshot, pullRequests: [], pullRequestBranchChecks: {
    PR: { headExists: true, baseExists: true, differs: true },
  },
};
const deferred = compilePullRequestSteps(newGraph, newSnapshot, [
  { logicalId: "NEW", kind: "issue", status: "new" },
]);
const deferredCreate = deferred.steps.find((x) => x.kind === "pull_request.create")!;
check(deferredCreate.dependsOn.includes("issue.create:NEW"),
  "PR with new Closes reference must depend on issue creation.");
check(deferredCreate.request?.protocol === "rest", "Expected REST create.");
const bound = bindPlanRequest(deferredCreate.request!, { NEW: { number: 123 } });
check(bound.protocol === "rest" && JSON.stringify(bound.body).includes("Closes #123"),
  "Late-bound Closes text must substitute the created issue number.");
const duplicate = normalizeSchema({
  repository: repo, pullRequests: [
    { logicalId: "P1", head: "feature", base: "main", identity: { number: 50 } },
    { logicalId: "P2", head: "feature", base: "release", identity: { number: 50 } },
  ],
}).graph!;
const collisions = compilePullRequestSteps(duplicate, snapshot, []);
check(collisions.blockers.some((x) => x.code === "PR_PAIR_CONFLICT"),
  "Two distinct logical PRs targeting one existing number must block readiness.");
const manualPrefix = "Lead   \n\n";
const manualSuffix = "\n\nFooter\n";
const managed = "<!-- gh-plan:closes:begin -->\nCloses #10\n<!-- gh-plan:closes:end -->";
const humanState: GithubStateSnapshot = {
  ...snapshot,
  pullRequests: [{ ...snapshot.pullRequests![0]!,
    body: manualPrefix + managed + manualSuffix }],
};
const updateClosure = normalizeSchema({
  repository: repo,
  issues: [{ logicalId: "OTHER", management: "reference", identity: { number: 12 } }],
  pullRequests: [{ logicalId: "PR", head: "feature", base: "main",
    identity: { number: 50 }, closes: ["OTHER"] }],
}).graph!;
const closurePlan = compilePullRequestSteps(updateClosure, humanState, [
  { logicalId: "OTHER", kind: "issue", status: "existing", identity: { number: 12 } },
]);
const bodyPatch = closurePlan.steps.find((x) => x.kind === "pull_request.update");
check(bodyPatch?.request?.protocol === "rest", "Closes diff requires a managed PR PATCH.");
const bodyPatchString = JSON.stringify(bodyPatch.request.body);
check(bodyPatchString.includes("Closes #12") && !bodyPatchString.includes("Closes #10"),
  "Managed closure must be replaced without leaving stale refs.");
check(bodyPatchString.includes("Lead   ") && bodyPatchString.includes("Footer"),
  "Closes replacement must retain human text outside the block.");
const invalidTemplate = { protocol: "rest", method: "POST", path: "/issues",
  body: { body: { $template: "not-an-array" } } };
let malformedTemplateRejected = false;
try {
  requestReferences(invalidTemplate as unknown as Parameters<typeof requestReferences>[0]);
} catch {
  malformedTemplateRejected = true;
}
check(malformedTemplateRejected, "Request validation must reject malformed string templates.");

console.log("PR create/update, safe head/base identity, scoped reads, M4 endpoints, Closes and draft fixtures passed.");
