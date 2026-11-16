import { preflightApplyPlan } from "../src/apply-preflight.ts";
import type { ApplyIntentManifest } from "../src/apply-preflight.ts";
import type { GithubPlan, PlanStep, PlanRequest } from "../src/types.ts";

function assert(ok: unknown, reason: string): asserts ok {
  if (!ok) throw Error(reason);
}
function equal(actual: unknown, expected: unknown, why: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(why + "; actual=" + JSON.stringify(actual));
}
const token = (id: string) => "<!-- gh-plan:" + id + " -->";
function step(kind: PlanStep["kind"], id: string, request: PlanRequest,
  dependsOn: string[] = []): PlanStep {
  return {
    id: kind + ":" + id, logicalId: id, kind,
    status: "planned", dependsOn, current: null,
    desired: request.protocol === "rest" ? request.body as PlanStep["desired"] : null,
    reason: "prose irrelevant", preconditions: ["untrusted prose"],
    expectedPostconditions: ["state is safe, allegedly"], destructive: false,
    reversible: "partial", request,
  };
}
const mCreate = step("milestone.create", "M",
  { protocol: "rest", method: "POST", path: "/repos/a/b/milestones",
    body: { title: "Release", description: "", due_on: "2027-01-03T00:00:00Z" } });
const mUpdate = step("milestone.update", "M2",
  { protocol: "rest", method: "PATCH", path: "/repos/a/b/milestones/2",
    body: { description: "", due_on: null } });
const iCreate = step("issue.create", "I",
  { protocol: "rest", method: "POST", path: "/repos/a/b/issues",
    body: { title: "Ship", body: token("I"), milestone: { $ref: "M.number" } } },
  ["milestone.create:M"]);
const iUpdate = step("issue.update", "I2",
  { protocol: "rest", method: "PATCH", path: "/repos/a/b/issues/15",
    body: { state: "closed", milestone: null } });
const iClose = step("issue.update", "I",
  { protocol: "rest", method: "PATCH",
    path: ["/repos/a/b/issues/", { $ref: "I.number" }],
    body: { state: "closed" } }, ["issue.create:I"]);
const manifest: ApplyIntentManifest = {
  version: 1, repository: "a/b", resourceCount: 4, relationshipCount: 0,
  managed: [
    { logicalId: "I", kind: "issue", fields: ["milestone", "state", "title"], removes: [], desiredState: "closed" },
    { logicalId: "I2", kind: "issue", fields: ["milestone", "state"], removes: ["milestone"], desiredState: "closed" },
    { logicalId: "M", kind: "milestone", fields: ["description", "due_on", "title"], removes: [] },
    { logicalId: "M2", kind: "milestone", fields: ["description", "due_on"], removes: ["description", "due_on"] },
  ],
  unsupported: [],
};
const good: GithubPlan = {
  metadata: { planner: "gh-plan", version: "0.1.0", mode: "rest" },
  repository: { fullName: "a/b" }, desired: { resourceCount: 4, relationshipCount: 0 },
  applyIntent: manifest,
  resolutions: [
    { logicalId: "M", kind: "milestone", status: "new" },
    { logicalId: "M2", kind: "milestone", status: "existing", identity: { number: 2 } },
    { logicalId: "I", kind: "issue", status: "new", identity: { marker: token("I") } },
    { logicalId: "I2", kind: "issue", status: "existing",
      identity: { number: 15, id: 150, nodeId: "I_150", marker: token("I2") } },
  ],
  steps: [iClose, iCreate, mUpdate, mCreate, iUpdate],
  noops: [], warnings: [], blockers: [], unsupported: [], readiness: "ready",
  summary: { planned: 5, noops: 0, warnings: 0, blocked: 0, unsupported: 0 },
};
const immutable = JSON.stringify(good);
const outcome = preflightApplyPlan(good);
assert(outcome.ok, "Four kinds and late-bound create+close must pass pure preflight.");
equal(outcome.postconditions.map((x) => x.kind),
  ["issue.update", "issue.create", "milestone.update", "milestone.create", "issue.update"],
  "Each step has one typed descriptor.");
equal(outcome.postconditions[1]?.identity,
  { strategy: "unique_issue_marker", marker: token("I") }, "Exact issue marker identity.");
equal(outcome.postconditions[3]?.identity,
  { strategy: "unique_milestone_title", title: "Release" }, "Exact milestone title.");
equal(outcome.postconditions[2]?.predicates,
  [{ field: "description", comparison: "exact", expected: "" },
   { field: "due_on", comparison: "null", expected: null }],
  "Set/clear presence and explicit null are distinct.");
equal(outcome.postconditions[1]?.predicates.find((x) => x.field === "milestone")?.expected,
  { $ref: "M.number" }, "Milestone must bind numeric number from creator.");
assert(outcome.postconditions.every((p) => p.version === 1 && p.repository === "a/b"),
  "Versioned/repository-locked descriptors only.");
equal(JSON.stringify(good), immutable, "Preflight must not mutate plan.");
const implicitClear = JSON.parse(JSON.stringify(good)) as GithubPlan;
implicitClear.steps[3]!.request = { protocol: "rest", method: "POST",
  path: "/repos/a/b/milestones", body: { title: "Release" } };
implicitClear.steps[3]!.desired = { title: "Release" };
implicitClear.applyIntent!.managed[2]!.removes = ["description", "due_on"];
const clearResult = preflightApplyPlan(implicitClear);
assert(clearResult.ok, "Removing unset description/due_on on new milestone requires no extra write.");
if (clearResult.ok) equal(clearResult.postconditions[3]?.predicates,
  [{ field: "title", comparison: "exact", expected: "Release" }],
  "New milestone removals remain implicit and need no PATCH.");

const openIssue = JSON.parse(JSON.stringify(good)) as GithubPlan;
openIssue.steps.splice(0, 1); // No create-to-close step; issue remains open.
openIssue.summary.planned--;
openIssue.applyIntent!.managed[0]!.desiredState = "open";
const openResult = preflightApplyPlan(openIssue);
assert(openResult.ok, "An explicit desired open state is satisfied by issue-create defaults.");
if (openResult.ok) equal(
  openResult.postconditions[0]?.predicates.find((p) => p.field === "state"),
  { field: "state", comparison: "exact", expected: "open" },
  "Issue create requires independent GET verification of initial open state.");

const prose = JSON.parse(JSON.stringify(good)) as GithubPlan;
prose.steps.forEach((x) => { x.expectedPostconditions = ["this describes an impossible operation"]; });
assert(preflightApplyPlan(prose).ok,
  "Descriptive postcondition strings must not influence typed capability checks.");

function clone(): GithubPlan {
  return JSON.parse(JSON.stringify(good)) as GithubPlan;
}
function denied(name: string, patch: (plan: GithubPlan) => void,
  expectedCode?: string): void {
  const plan = clone();
  patch(plan);
  let writes = 0, locks = 0;
  const result = preflightApplyPlan(plan);
  if (result.ok) { locks++; writes++; }
  assert(!result.ok, name + " must fail closed.");
  if (!result.ok && expectedCode) assert(result.errors.some((e) => e.code === expectedCode),
    name + " expected " + expectedCode + " but got " + JSON.stringify(result.errors));
  equal({ writes, locks }, { writes: 0, locks: 0 },
    name + ": entire plan refused before any downstream callback or lock.");
}
denied("unknown final operation", (p) => {
  p.steps.push(step("label.create", "X", { protocol: "rest", method: "POST",
    path: "/repos/a/b/labels", body: { name: "x" } }));
  p.summary.planned++;
}, "UNSUPPORTED_OPERATION");
denied("unknown enum", (p) => {
  p.steps[4]!.kind = "hypothetical.operation" as PlanStep["kind"];
}, "UNSUPPORTED_OPERATION");
denied("mixed target repositories", (p) => {
  (p.steps[4]!.request as { path: string }).path = "/repos/elsewhere/repo/issues/15";
}, "UNSAFE_REQUEST");
denied("unsupported extra update field", (p) => {
  const r = p.steps[4]!.request!;
  if (r.protocol === "rest") r.body = { state: "closed", labels: ["malicious"] };
}, "UNSAFE_REQUEST");
denied("destructive flag", (p) => { p.steps[4]!.destructive = true; }, "INVALID_PLAN");
denied("untrusted GraphQL request", (p) => {
  p.steps[4]!.request = { protocol: "graphql", document: "mutation { deleteIssue }" };
}, "UNSAFE_REQUEST");
denied("malformed nested reference", (p) => {
  const r = p.steps[1]!.request!;
  if (r.protocol === "rest") r.body = {
    title: "Ship", body: token("I"), milestone: { $ref: "M.nodeId" },
  };
}, "UNSAFE_REQUEST");
denied("missing producer dependency", (p) => { p.steps[1]!.dependsOn = []; }, "UNSAFE_REQUEST");
denied("dependency cycle", (p) => { p.steps[3]!.dependsOn = ["issue.create:I"]; }, "INVALID_REFERENCE");
denied("duplicate step", (p) => { p.steps[3] = p.steps[2]!; }, "INVALID_PLAN");
denied("missing plan source intent", (p) => { delete p.applyIntent; }, "INVALID_PLAN");
denied("unsupported normalized property even if no separate step", (p) => {
  p.applyIntent!.unsupported = ["issue.issueType"];
}, "UNSUPPORTED_INTENT");
denied("silent unsupported managed field", (p) => {
  p.applyIntent!.managed[0]!.fields.push("assignees");
}, "UNSUPPORTED_INTENT");
denied("stale noop", (p) => {
  p.noops.push({ ...iUpdate, id: "issue.noop:I2", status: "noop", request: undefined });
  p.summary.noops = 1;
}, "STALE_NOOP");
denied("changed intent not represented in body", (p) => {
  p.applyIntent!.managed[1]!.fields.push("title");
}, "STALE_NOOP");
denied("mutated desired value", (p) => { p.steps[4]!.desired = { state: "open", milestone: null }; },
  "UNSAFE_REQUEST");
denied("blocked plan", (p) => { p.readiness = "blocked"; }, "CONFLICT");
denied("unsupported diagnostics", (p) => {
  p.unsupported.push({ code: "UNSUPPORTED_SCHEMA_FEATURE", severity: "warning",
    blocking: false, message: "unknown" }); p.summary.unsupported++;
}, "CONFLICT");
denied("foreign resource resolution", (p) => { p.resolutions[1]!.kind = "issue"; }, "UNSAFE_REQUEST");
denied("wrong issue marker", (p) => {
  const r = p.steps[1]!.request!;
  if (r.protocol === "rest") r.body = { title: "Ship", body: "<!-- gh-plan:other -->",
    milestone: { $ref: "M.number" } };
}, "UNSAFE_REQUEST");
denied("duplicate marker", (p) => {
  const r = p.steps[1]!.request!;
  if (r.protocol === "rest") r.body = { title: "Ship", body: token("I") + token("I"),
    milestone: { $ref: "M.number" } };
}, "UNSAFE_REQUEST");
denied("bad milestone calendar day", (p) => {
  const r = p.steps[3]!.request!;
  if (r.protocol === "rest") r.body = { title: "Release", due_on: "2027-02-30T00:00:00Z" };
}, "UNSAFE_REQUEST");
denied("unsafe numeric identity", (p) => { p.resolutions[3]!.identity!.number = -1; },
  "UNSAFE_IDENTITY");
denied("malformed request path injection", (p) => {
  const r = p.steps[2]!.request!;
  if (r.protocol === "rest") r.path = "/repos/a/b/milestones/2?force=true";
}, "UNSAFE_REQUEST");
denied("partial managed intent ignored by compiler", (p) => {
  p.applyIntent!.managed.push({ logicalId: "J", kind: "issue", fields: ["title"], removes: [] });
}, "UNSUPPORTED_INTENT");
console.log("B1 typed preflight: mixed DAG, zero-write rejection and strict intent/identity fixtures passed.");
