import { prepareApplyPlan } from "../src/apply-contract.ts";
import { ApplyPlanError } from "../src/index.ts";
import type {
  ApplyPlanOptions, ApplyPlanResult, ApplyOwnershipAdapter,
  ApplyPostconditionReader, ApplyDispatcher, ApplyPlanErrorCode,
  SafeApplyLogEntry, ApplyIssueCatalogReader, ApplyMilestoneCatalogReader,
  PlanOperationKind, GithubPlan, PlanRequest, PlanStep,
} from "../src/index.ts";
import type { ApplyIntentManifest } from "../src/apply-preflight.ts";

function assert(value: unknown, reason: string): asserts value {
  if (!value) throw Error(reason);
}
function equal(actual: unknown, expected: unknown, why: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(why + " expected=" + JSON.stringify(expected) +
      " actual=" + JSON.stringify(actual));
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


const allowed = [
  "issue.create", "issue.update", "milestone.create", "milestone.update",
] as const;
const allUnsupported: Array<Exclude<PlanOperationKind, typeof allowed[number]>> = [
  "label.create", "label.update", "project.item.add", "project.item.fields.set",
  "pull_request.create", "pull_request.update", "pull_request.reviewer.add",
  "pull_request.reviewer.remove", "issue.orphan.close", "issue.duplicate.comment",
  "issue.duplicate.close", "issue.duplicate.delete", "issue.type.set",
  "issue.marker.adopt", "issue.label.set", "issue.label.add",
  "issue.label.remove", "issue.assignee.set", "issue.assignee.add",
  "issue.assignee.remove", "issue.field.set", "issue.field.remove",
  "issue.parent.set", "issue.dependency.add", "issue.dependency.remove",
  "issue.parent.remove", "issue.relates_to.add", "issue.relates_to.remove",
  "verification.read",
];
equal(allUnsupported.length, 29, "Every disallowed operation kind is individually exercised.");

function clone(): GithubPlan {
  return JSON.parse(JSON.stringify(good)) as GithubPlan;
}
const touched: string[] = [];
const dispatch: ApplyDispatcher = async () => {
  touched.push("dispatch");
  throw Error("DO_NOT_LOG dispatch invoked unexpectedly");
};
const readPostcondition: ApplyPostconditionReader = async () => {
  touched.push("postcondition");
  throw Error("DO_NOT_LOG reader invoked unexpectedly");
};
const readIssueCatalog: ApplyIssueCatalogReader = async () => {
  touched.push("issues.catalog");
  return [];
};
const readMilestoneCatalog: ApplyMilestoneCatalogReader = async () => {
  touched.push("milestones.catalog");
  return [];
};
const ownership: ApplyOwnershipAdapter = {
  async acquire() {
    touched.push("ownership.acquire");
    return { ownerId: "DO_NOT_LOG" };
  },
  async assertOwned() {
    touched.push("ownership.assert");
    return true;
  },
  async release() { touched.push("ownership.release"); },
};
const onLog = async (_entry: Readonly<SafeApplyLogEntry>) => {
  touched.push("audit");
  throw Error("DO_NOT_LOG audit should never run");
};
function options(plan: GithubPlan = clone()): ApplyPlanOptions {
  return {
    plan, dispatch, readPostcondition, readIssueCatalog,
    readMilestoneCatalog, ownership, acknowledgeCallbackTrust: true, onLog,
  };
}
function rejected(name: string, candidate: unknown,
  code: ApplyPlanErrorCode): void {
  touched.length = 0;
  let error: unknown;
  try { prepareApplyPlan(candidate); }
  catch (caught) { error = caught; }
  assert(error instanceof ApplyPlanError, name + ": typed error only");
  equal(error.code, code, name + ": stable error code");
  equal(error.phase, "preflight", name + ": validation-only phase");
  equal(error.ownerState, "not_acquired", name + ": no lock started");
  equal(error.log, [], name + ": no audit record fabricated");
  assert(!error.message.includes("DO_NOT_LOG") &&
    !JSON.stringify(error).includes("DO_NOT_LOG"),
    name + ": no arbitrary exception/request/secret leakage");
  equal(touched, [], name + ": ZERO callback/lock/audit operations");
}
const original = clone();
const before = JSON.stringify(original);
touched.length = 0;
const prepared = prepareApplyPlan(options(original));
assert(prepared.postconditions.length === original.steps.length,
  "All five steps have typed version-one postconditions, preserving mixed B1 graph.");
equal(prepared.postconditions.map((s) => s.kind),
  original.steps.map((s) => s.kind),
  "Descriptors cover all four kinds without reordering.");
assert(Object.isFrozen(prepared) &&
  Object.isFrozen(prepared.plan) &&
  Object.isFrozen(prepared.postconditions) &&
  Object.isFrozen(prepared.plan.steps) &&
  Object.isFrozen(prepared.postconditions[0]),
  "Validated plan and descriptors are immutable staging snapshots.");
assert(prepared.plan !== original && prepared.plan.steps !== original.steps,
  "Preflight snapshots instead of returning caller-owned plan graph.");
equal(JSON.stringify(original), before, "Preflight never mutates the input.");
equal(touched, [], "Even a valid plan invokes ZERO callbacks in #187.");
original.steps[0]!.kind = "label.create";
const preparedPlan = prepared.plan as GithubPlan;
equal(preparedPlan.steps[0]!.kind, "issue.update",
  "Post-preflight caller mutations cannot rewrite validated plan.");
let mutationFailed = false;
try { (preparedPlan.steps[0] as PlanStep).kind = "label.create"; }
catch { mutationFailed = true; }
assert(mutationFailed, "Prepared state cannot be mutated in strict ESM.");
// Callback functions are caller-owned and remain untrusted; the type contract
// does not claim they actually read GitHub or hold a CAS lock.
equal(typeof prepared.dispatch, "function", "Dispatch is recorded, never invoked.");
equal(typeof prepared.ownership.assertOwned, "function", "Owner callbacks captured.");
const phaseType: ApplyPlanResult = {
  status: "already_satisfied", runId: "opaque",
  completedStepIds: [], skippedStepIds: [], bindings: {}, log: [],
};
void phaseType;
const impossibleError = new ApplyPlanError({
  code: "INVALID_PLAN", phase: "preflight",
});
equal(impossibleError.toJSON(), {
  code: "INVALID_PLAN", phase: "preflight", ownerState: "not_acquired",
  log: [], completedStepIds: [], skippedStepIds: [],
}, "Sanitized public error JSON exposes only allowlisted fields.");
equal(Object.keys(impossibleError.toJSON()).includes("cause"), false,
  "No arbitrary error cause is serialized.");

for (const kind of allUnsupported) {
  const p = clone();
  p.steps.push(step(kind, "FINAL-UNSAFE", {
    protocol: "rest", method: "POST", path: "/repos/a/b/issues",
    body: { title: "Never execute" },
  }));
  p.summary.planned++;
  rejected("all 29 disallowed kind: " + kind, options(p), "UNSUPPORTED_PLAN");
}
for (const change of [
  (p: GithubPlan) => { p.steps[p.steps.length - 1]!.request = {
    protocol: "rest", method: "PATCH", path: "/repos/foreign/repo/issues/15",
    body: { state: "closed" },
  }; },
  (p: GithubPlan) => { p.steps[4]!.request = {
    protocol: "graphql", document: "mutation { deleteIssue }",
  }; },
  (p: GithubPlan) => { p.steps[4]!.request = {
    protocol: "rest", method: "PATCH", path: "/repos/a/b/issues/15",
    body: { state: "closed", labels: ["should never reach GitHub"] },
  }; },
  (p: GithubPlan) => { p.steps[4]!.dependsOn = ["issue.update:I2"]; },
  (p: GithubPlan) => { p.steps[1]!.dependsOn = []; },
  (p: GithubPlan) => { p.steps[4]!.destructive = true; },
  (p: GithubPlan) => { p.resolutions[3]!.identity!.number = -1; },
  (p: GithubPlan) => { p.applyIntent!.unsupported = ["issue.issueType"]; },
  (p: GithubPlan) => { p.applyIntent!.managed[0]!.fields.push("assignees"); },
  (p: GithubPlan) => { p.noops.push({
    ...p.steps[4]!, id: "issue.noop:I2", status: "noop", request: undefined,
  }); p.summary.noops++; },
  (p: GithubPlan) => { p.readiness = "blocked"; },
]) {
  const p = clone();change(p);
  rejected("unsafe plan refused atomically", options(p),
    p.applyIntent?.unsupported?.length ||
    p.applyIntent?.managed[0]?.fields.includes("assignees")
    ? "UNSUPPORTED_PLAN" : "INVALID_PLAN");
}
rejected("no options", undefined, "CALLBACK_INVALID");
rejected("null plan", { ...options(), plan: null }, "INVALID_PLAN");
rejected("missing trust acknowledgement", {
  ...options(), acknowledgeCallbackTrust: false,
}, "CALLBACK_INVALID");
rejected("invalid trust acknowledgement value", {
  ...options(), acknowledgeCallbackTrust: "true",
}, "CALLBACK_INVALID");
rejected("missing dispatcher", { ...options(), dispatch: null },
  "CALLBACK_INVALID");
rejected("missing reader", { ...options(), readPostcondition: 0 },
  "CALLBACK_INVALID");
rejected("invalid ownership", { ...options(), ownership: null },
  "CALLBACK_INVALID");
rejected("ownership incomplete", {
  ...options(), ownership: { acquire: async () => ({ ownerId: "x" }) },
}, "CALLBACK_INVALID");
rejected("extra ownership escape hatch denied", {
  ...options(), ownership: { ...ownership, skipLock: true },
}, "CALLBACK_INVALID");
rejected("missing issue catalog", (() => {
  const o = options();
  delete (o as Partial<ApplyPlanOptions>).readIssueCatalog;
  return o;
})(), "CALLBACK_INVALID");
rejected("missing milestone catalog", (() => {
  const o = options();
  delete (o as Partial<ApplyPlanOptions>).readMilestoneCatalog;
  return o;
})(), "CALLBACK_INVALID");
rejected("invalid issue catalog", {
  ...options(), readIssueCatalog: {},
}, "CALLBACK_INVALID");
rejected("invalid milestone catalog", {
  ...options(), readMilestoneCatalog: "cached",
}, "CALLBACK_INVALID");
rejected("invalid log sink", {
  ...options(), onLog: "pretend log",
}, "CALLBACK_INVALID");
rejected("unknown signal", {
  ...options(), signal: { aborted: false },
}, "CALLBACK_INVALID");
rejected("user supplies a credential", {
  ...options(), auth: "DO_NOT_LOG",
}, "CALLBACK_INVALID");
rejected("user supplies a custom base URL", {
  ...options(), apiBaseUrl: "https://evil.example",
}, "CALLBACK_INVALID");
rejected("user supplies unrestricted fetch", {
  ...options(), fetch: async () => {},
}, "CALLBACK_INVALID");
rejected("attempted ownership bypass option", {
  ...options(), skipOwnership: true,
}, "CALLBACK_INVALID");
rejected("bad plan before inspecting unsafe callbacks", {
  ...options(Object.assign(clone(), { readiness: "blocked" })),
  get dispatch() { throw Error("DO_NOT_LOG callback getter"); },
}, "INVALID_PLAN");
const canceled = new AbortController();
canceled.abort();
rejected("aborted before ownership or side effects", {
  ...options(), signal: canceled.signal,
}, "ABORTED");
const never = new AbortController();
const withSignal = prepareApplyPlan({ ...options(), signal: never.signal });
assert(withSignal.signal === never.signal, "Live AbortSignal remains referenced.");

const soleIssue = clone();
soleIssue.steps = soleIssue.steps.filter((step) =>
  step.kind !== "milestone.create");
soleIssue.summary.planned--;
soleIssue.resolutions = soleIssue.resolutions.filter((r) => r.logicalId !== "M");
// This graph is intentionally now invalid because issue.create refers to M:
// the preflight must refuse even with a perfect catalog.
rejected("cross-resource refs require original milestone producer", options(soleIssue),
  "INVALID_PLAN");

console.log("C2 #187: public type contract, 29 disallowed kinds, mixed B1 immutability and zero-callback preflight passed.");
