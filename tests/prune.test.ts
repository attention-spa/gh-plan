import {
  normalizeSchema, resolveResourceIdentities, compilePruneSteps, planGithub,
  validatePlanStepReferences,
} from "../src/index.ts";
import type {
  GithubPlanSchema, GithubStateSnapshot, NormalizedDesiredStateGraph,
  ResourceResolution, FetchLike, FetchResponseLike,
} from "../src/index.ts";

function check(ok: unknown, msg: string): asserts ok { if (!ok) throw Error(msg); }
function equal(a: unknown, b: unknown, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(msg + "\nactual=" + JSON.stringify(a) + "\nexpected=" + JSON.stringify(b));
}
const repo = "alice/plan";
const marked = (id: string) => "<!-- gh-plan:" + id + " -->\n";
const issue = (number: number, title: string, body: string | null,
  state: "open" | "closed" = "open") => ({
  kind: "issue" as const, id: 1000 + number, nodeId: "I_" + number,
  number, title, body, state,
});
const snapshot: GithubStateSnapshot = {
  repository: { fullName: repo }, milestones: [], issueTypes: [], issueFields: [],
  issues: [
    issue(1, "Alpha", marked("X") + "Main"),
    issue(2, "Alpha", marked("X") + "Duplicate"),
    issue(3, "Old orphan", marked("OLD") + "Legacy"),
    issue(4, "Alpha", "Human issue without marker"),
    issue(5, "Multiple", marked("P") + marked("Q")),
    issue(6, "Closed orphan", marked("CLOSED"), "closed"),
  ],
};
const authored = (extra: object = {}): GithubPlanSchema => ({
  repository: repo,
  issues: [{ logicalId: "X", title: "Alpha", identity: { number: 1 } }],
  ...extra,
});
const normalized = (extra: object = {}): NormalizedDesiredStateGraph => {
  const n = normalizeSchema(authored(extra));
  check(n.ok && n.graph, "Expected valid normalized schema");
  return n.graph;
};
const defaultGraph = normalized();
check(defaultGraph.prune === undefined && defaultGraph.deleteDuplicates === undefined,
  "Default must be report-only, never delete.");
const explicitGraph = normalized({ prune: "close" });
const strict = resolveResourceIdentities(defaultGraph, snapshot);
check(strict.blockers.some((x) => x.code === "AMBIGUOUS_IDENTITY"),
  "Duplicate markers remain ambiguous in default identity resolution.");
const selected = resolveResourceIdentities(explicitGraph, snapshot,
  { allowDuplicateMarkerWithExplicitIdentity: true });
equal(selected.blockers, [], "Opt-in close with explicit canonical number resolves duplicates safely.");
check(selected.resolutions.find((x) => x.logicalId === "X")?.identity?.number === 1,
  "Explicit canonical issue must never be reassigned to a duplicate.");
const defaultPolicy = compilePruneSteps(defaultGraph, snapshot, strict.resolutions);
check(defaultPolicy.steps.length === 0 && defaultPolicy.blockers.length === 0,
  "Default prune must not propose any mutation or new blocker.");
check(defaultPolicy.warnings.some((x) => x.code === "ORPHAN_ISSUE" &&
  x.logicalId === "OLD" && x.severity === "info" && !x.blocking),
  "Unmanaged canonical markers must be reported as info.");
check(defaultPolicy.warnings.some((x) => x.code === "DUPLICATE_ISSUE_MARKER" &&
  x.logicalId === "X"), "Duplicate canonical marker must be reported.");
check(defaultPolicy.warnings.some((x) => x.code === "DUPLICATE_ISSUE_TITLE"),
  "Title collision should be reported.");
const closer = compilePruneSteps(explicitGraph, snapshot, selected.resolutions);
equal(closer.blockers, [], "Explicit canonical close should be safe.");
equal(closer.steps.map((s) => s.kind).sort(), [
  "issue.duplicate.close", "issue.duplicate.comment", "issue.orphan.close",
].sort(), "Only a unique orphan and exact-marker duplicate may be closed.");
const orphan = closer.steps.find((s) => s.kind === "issue.orphan.close")!;
equal(orphan.request, {
  protocol: "rest", method: "PATCH", path: "/repos/alice/plan/issues/3",
  body: { state: "closed", state_reason: "not_planned" },
}, "Orphan close must be reversible, with not_planned reason.");
check(!orphan.destructive && orphan.reversible === true,
  "Orphan close cannot be destructive or irreversible.");
const comment = closer.steps.find((s) => s.kind === "issue.duplicate.comment")!;
const duplicate = closer.steps.find((s) => s.kind === "issue.duplicate.close")!;
check(comment.request?.protocol === "rest" &&
  JSON.stringify(comment.request.body).includes("https://github.com/alice/plan/issues/1"),
  "Duplicate comment must retain canonical link and reason.");
equal(duplicate.request, {
  protocol: "rest", method: "PATCH", path: "/repos/alice/plan/issues/2",
  body: { state: "closed", state_reason: "duplicate", duplicate_issue_id: 1001 },
}, "Duplicate closure must link to the selected canonical REST ID.");
check(duplicate.dependsOn.includes(comment.id) &&
  !duplicate.destructive && duplicate.reversible === true,
  "Reversible duplicate closure must depend on its reason comment.");
equal(validatePlanStepReferences(closer.steps), [],
  "Prune steps may not contain unresolved references.");
check(!closer.steps.some((s) =>
  s.request?.protocol === "rest" &&
  (s.request.method === "DELETE" || JSON.stringify(s.request).includes("issues/4"))),
  "Unmarked issue must never be deleted or closed for a matching title.");

const ambiguous = compilePruneSteps(explicitGraph, snapshot,
  strict.resolutions);
check(ambiguous.blockers.some((x) => x.code === "AMBIGUOUS_IDENTITY") &&
  !ambiguous.steps.some((x) => x.kind.startsWith("issue.duplicate")),
  "Without an explicitly resolved canonical, duplicate closure must block.");
const quotedMarker = compilePruneSteps(explicitGraph, {
  ...snapshot, issues: [
    ...snapshot.issues, issue(8, "Documentation example",
      "Documentation:\\n\\n" + marked("QUOTED") + "is just a sample."),
  ],
}, selected.resolutions);
check(quotedMarker.warnings.some((x) => x.code === "ORPHAN_ISSUE" &&
  x.logicalId === "QUOTED"), "A quoted marker can still be reported.");
check(quotedMarker.blockers.some((x) => x.code === "AMBIGUOUS_IDENTITY" &&
  x.logicalId === "QUOTED") &&
  !quotedMarker.steps.some((x) => x.logicalId === "QUOTED"),
  "Quoted markers later in a body never authorize a close proposal.");

const orphanDupSnapshot: GithubStateSnapshot = { ...snapshot,
  issues: [...snapshot.issues, issue(7, "Another old", marked("OLD"))] };
const orphanDup = compilePruneSteps(explicitGraph, orphanDupSnapshot, selected.resolutions);
check(orphanDup.blockers.some((x) => x.code === "DUPLICATE_ISSUE_MARKER") &&
  !orphanDup.steps.some((x) => x.kind === "issue.orphan.close"),
  "Two orphan copies of a marker must not be implicitly closed.");

const restDelete = compilePruneSteps(normalized({
  prune: "close", deleteDuplicates: true,
}), snapshot, selected.resolutions, "rest");
check(restDelete.blockers.some((x) => x.code === "DUPLICATE_DELETION_UNSUPPORTED") &&
  restDelete.unsupported.some((x) => x.code === "DUPLICATE_DELETION_UNSUPPORTED") &&
  !restDelete.steps.some((x) => x.kind.startsWith("issue.duplicate")),
  "REST mode must explicitly block deletion even when opt-in is set.");
const gqlDelete = compilePruneSteps(normalized({
  prune: "close", deleteDuplicates: true,
}), snapshot, selected.resolutions, "graphql");
const deleteStep = gqlDelete.steps.find((x) => x.kind === "issue.duplicate.delete")!;
check(deleteStep.destructive && deleteStep.reversible === false &&
  deleteStep.request?.protocol === "graphql" &&
  deleteStep.request.operationName === "DeleteDuplicateIssue" &&
  deleteStep.request.variables?.issueId === "I_2",
  "Only an explicit GraphQL opt-in may propose irreversible deleteIssue.");
const canonicalNote = gqlDelete.steps.find((x) =>
  x.kind === "issue.duplicate.comment")!;
check(canonicalNote.request?.protocol === "rest" &&
  canonicalNote.request.path === "/repos/alice/plan/issues/1/comments" &&
  deleteStep.dependsOn.includes(canonicalNote.id),
  "Permanent deletion justification must first be recorded on surviving canonical.");
const noNode = compilePruneSteps(normalized({
  prune: "close", deleteDuplicates: true,
}), { ...snapshot, issues: snapshot.issues.map((x) =>
    x.number === 2 ? { ...x, nodeId: undefined } : x) },
  selected.resolutions, "graphql");
check(noNode.blockers.some((x) => x.code === "UNRESOLVED_IDENTITY") &&
  !noNode.steps.some((x) => x.kind === "issue.duplicate.delete"),
  "Missing GraphQL identity must block deletion.");

const protectedResource = normalized({
  issues: [
    { logicalId: "X", title: "Alpha", identity: { number: 1 } },
    { logicalId: "R", management: "reference", identity: { number: 3 } },
  ],
  prune: "close",
});
const protectedPlan = compilePruneSteps(protectedResource, snapshot, selected.resolutions);
check(!protectedPlan.steps.some((x) => x.kind === "issue.orphan.close"),
  "Explicitly referenced issue identity remains protected from orphan pruning.");

for (const bad of [
  { prune: "delete" }, { prune: true }, { deleteDuplicates: "true" },
  { deleteDuplicates: true }, { prune: "report", deleteDuplicates: true },
]) {
  const invalid = normalizeSchema({ repository: repo, ...bad });
  check(!invalid.ok && invalid.diagnostics.some((x) => x.blocking),
    "Unsafe pruning input must not normalize: " + JSON.stringify(bad));
}
const allClosed = compilePruneSteps(explicitGraph, {
  ...snapshot,
  issues: snapshot.issues.map((x) =>
    x.number === 2 || x.number === 3 ? { ...x, state: "closed" } : x),
}, selected.resolutions);
check(!allClosed.steps.length,
  "Already closed duplicates/orphans must be idempotent.");

function response(data: unknown): FetchResponseLike {
  return { ok: true, status: 200, statusText: "OK",
    headers: { get() { return null; } },
    async json() { return data; }, async text() { return JSON.stringify(data); } };
}
const seen: string[] = [];
const fetch: FetchLike = async (url, init) => {
  seen.push(url);
  check(init?.method === "GET", "Planner must only issue GET calls.");
  check(init?.headers?.Authorization === "Bearer private-token",
    "Authentication must remain a runtime header.");
  const root = "https://api.github.com/repos/alice/plan";
  if (url === root) return response({ id: 50, full_name: repo,
    owner: { type: "User" } });
  if (url === root + "/issues?state=all&per_page=100") return response([
    { id: 1003, node_id: "I_3", number: 3, title: "Old orphan",
      body: marked("OLD"), state: "open" },
    { id: 3000, node_id: "I_PR", number: 50, title: "Pull request",
      pull_request: { url: root + "/pulls/50" }, body: marked("P"), state: "open" },
  ]);
  if (url === root + "/milestones?state=all&per_page=100" ||
      url === root + "/issue-types") return response([]);
  throw Error("Unexpected read: " + url);
};
const integratedReport = await planGithub({
  schema: { repository: repo }, auth: "private-token", fetch,
});
equal(integratedReport.readiness, "ready_with_warnings",
  "Orphan informational diagnostic should not block read-only plan.");
check(integratedReport.steps.length === 0 &&
  integratedReport.warnings.some((x) => x.code === "ORPHAN_ISSUE"),
  "Default end-to-end plan reports orphan without a mutation.");
const integratedClose = await planGithub({
  schema: { repository: repo, prune: "close" }, auth: "private-token", fetch,
});
equal(integratedClose.readiness, "ready_with_warnings",
  "Explicit orphan close with info warning remains usable.");
check(integratedClose.steps.length === 1 &&
  integratedClose.steps[0]?.kind === "issue.orphan.close",
  "Opt-in end-to-end plan may propose reversible orphan close.");
check(seen.length === 8, "Prune uses existing four broad GETs only.");
check(!JSON.stringify(integratedClose).includes("private-token") &&
  !JSON.stringify(integratedReport).includes("private-token"),
  "No runtime credentials can enter outputs.");
console.log("Prune report/close, marker and title conflicts, guarded duplicate close, GraphQL-only deletion and GET-only fixtures passed.");
