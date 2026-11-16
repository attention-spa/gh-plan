import { executeCallbackApplyPlan } from "../src/apply-lifecycle.ts";
import { ApplyPlanError } from "../src/index.ts";
import type {
  ApplyPlanOptions, ApplyPlanResult, ApplyPlanErrorCode,
  ApplyPostconditionContext, SafeApplyLogEntry,
  GithubPlan, PlanStep, PlanRequest, PlanBindings,
  ObservedIssue, ObservedMilestone,
} from "../src/index.ts";
import type { ApplyIntentManifest } from "../src/apply-preflight.ts";
function assert(ok: unknown, why: string): asserts ok {
  if (!ok) throw Error(why);
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



function clone<T>(input: T): T { return JSON.parse(JSON.stringify(input)) as T; }
function reference(value: unknown, bindings: Readonly<PlanBindings>): unknown {
  if (value && typeof value === "object" && "$ref" in value &&
    typeof value.$ref === "string") {
    const token = value.$ref;
    return bindings[token.slice(0, -".number".length)]?.number;
  }
  return value;
}
function numbered(path: string): number {
  const match = /\/(\d+)$/.exec(path);
  if (!match) throw Error("DO_NOT_LOG bad path");
  return Number(match[1]);
}
type Issue = ObservedIssue & { id: number; nodeId: string; body: string; milestoneNumber: number | null };
type Milestone = ObservedMilestone & { id: number; nodeId: string; description: string; due_on: string | null };
type Hook = (ctx: ApplyPostconditionContext) => void | Promise<void>;
class Fixture {
  issues: Issue[] = [{
    kind: "issue", id: 150, number: 15, nodeId: "I_150",
    title: "Original", body: token("I2"), state: "open", milestoneNumber: 2,
  }];
  milestones: Milestone[] = [{
    kind: "milestone", id: 200, number: 2, nodeId: "M_200",
    title: "Previous", state: "open", description: "Old", due_on: "2027-02-04T00:00:00Z",
  }];
  events: string[] = [];
  logs: SafeApplyLogEntry[] = [];
  dispatches = 0;
  maxInFlight = 0;
  inFlight = 0;
  ownerHeld = false;
  lostOwner = false;
  acquireReject = false;
  releaseReject = false;
  assertReject = false;
  incorrectResponse = false;
  afterReadInvalid = false;
  beforeReadInvalid = false;
  failAudit?: (entry: SafeApplyLogEntry) => boolean;
  failDispatch?: (step: PlanStep) => boolean;
  beforeReadHook?: Hook;
  afterReadHook?: Hook;
  dispatchHook?: (step: PlanStep) => Promise<void>;
  extraIssue?: Issue;
  ownerCalls = 0;
  reads = 0;
  config(plan: GithubPlan = good): ApplyPlanOptions {
    return {
      plan: clone(plan), acknowledgeCallbackTrust: true,
      dispatch: this.dispatch.bind(this),
      readPostcondition: this.readPostcondition.bind(this),
      readIssueCatalog: this.issueCatalog.bind(this),
      readMilestoneCatalog: this.milestoneCatalog.bind(this),
      ownership: {
        acquire: async (name) => {
          this.events.push("acquire");
          this.ownerCalls++;
          if (this.acquireReject) {
            this.ownerHeld = true; // lost reply after possible acquisition
            throw Error("DO_NOT_LOG unknown CAS result");
          }
          assert(name === "a/b", "Repository scoped owner acquisition only.");
          this.ownerHeld = true;
          return { ownerId: "TEST_OWNER_012345" };
        },
        assertOwned: async () => {
          this.events.push("assert");
          if (this.assertReject) throw Error("DO_NOT_LOG lost owner callback");
          return this.ownerHeld && !this.lostOwner;
        },
        release: async () => {
          this.events.push("release");
          if (this.releaseReject) throw Error("DO_NOT_LOG ambiguous release");
          assert(this.ownerHeld, "Release must be guarded.");
          this.ownerHeld = false;
        },
      },
      onLog: async (entry) => {
        this.events.push("audit:" + entry.phase + ":" + entry.outcome);
        if (this.failAudit?.(entry)) throw Error("DO_NOT_LOG audit backing store down");
        this.logs.push({ ...entry });
      },
    };
  }
  async issueCatalog(name: string): Promise<readonly ObservedIssue[]> {
    this.events.push("issues.catalog");
    assert(name === "a/b", "Catalog never reads another repository.");
    return clone([...this.issues, ...(this.extraIssue ? [this.extraIssue] : [])]);
  }
  async milestoneCatalog(name: string): Promise<readonly ObservedMilestone[]> {
    this.events.push("milestones.catalog");
    assert(name === "a/b", "Catalog never reads another repository.");
    return clone(this.milestones);
  }
  async readPostcondition(ctx: ApplyPostconditionContext) {
    this.events.push("read:" + ctx.phase + ":" + ctx.spec.stepId);
    this.reads++;
    if (ctx.phase === "before") {
      await this.beforeReadHook?.(ctx);
      if (this.beforeReadInvalid) return { status: "bogus", secret: "DO_NOT_LOG" };
    } else {
      await this.afterReadHook?.(ctx);
      if (this.afterReadInvalid) throw Error("DO_NOT_LOG unable to complete GitHub GET");
    }
    const spec = ctx.spec;
    let current: Issue | Milestone | undefined;
    if (spec.kind === "issue.create") {
      current = this.issues.find((i) => i.body.includes(token("I")));
    } else if (spec.kind === "milestone.create") {
      current = this.milestones.find((m) => m.title === "Release");
    } else if (spec.kind === "issue.update") {
      current = this.issues.find((i) => i.number === numbered(ctx.request.path));
    } else {
      current = this.milestones.find((m) => m.number === numbered(ctx.request.path));
    }
    if (!current) return { status: "unsatisfied" as const };
    for (const pred of spec.predicates) {
      const expected = reference(pred.expected, ctx.bindings);
      const field = pred.field === "milestone" ? "milestoneNumber" : pred.field;
      const actual = (current as unknown as Record<string, unknown>)[field];
      if (pred.comparison === "null" ? actual !== null && actual !== "" :
        actual !== expected) return { status: "unsatisfied" as const };
    }
    return {
      status: "satisfied" as const,
      identity: {
        number: current.number, id: current.id, nodeId: current.nodeId,
      },
    };
  }
  async dispatch(request: { protocol: string; path: string; body?: unknown }, step: PlanStep) {
    this.events.push("dispatch:" + step.id);
    this.dispatches++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      assert(this.ownerHeld && !this.lostOwner, "A dispatch requires valid owner.");
      if (this.failDispatch?.(step)) throw Error("DO_NOT_LOG lost write reply");
      await this.dispatchHook?.(step);
      const body = request.body as Record<string, unknown>;
      switch (step.kind) {
        case "milestone.create":
          this.milestones.push({
            kind: "milestone", number: 17, id: 1700, nodeId: "M_1700",
            title: body.title as string, description: (body.description ?? "") as string,
            state: "open", due_on: body.due_on as string ?? null,
          });
          break;
        case "milestone.update": {
          const row = this.milestones.find((m) => m.number === numbered(request.path))!;
          if (body.title !== undefined) row.title = body.title as string;
          if (body.description !== undefined) row.description = body.description as string;
          if (Object.hasOwn(body, "due_on")) row.due_on = body.due_on as string | null;
          if (body.state !== undefined) row.state = body.state as "open" | "closed";
          break;
        }
        case "issue.create":
          this.issues.push({
            kind: "issue", number: 37, id: 3700, nodeId: "I_3700",
            title: body.title as string, body: body.body as string,
            milestoneNumber: body.milestone as number ?? null, state: "open",
          });
          break;
        case "issue.update": {
          const row = this.issues.find((i) => i.number === numbered(request.path))!;
          if (body.state !== undefined) row.state = body.state as "open" | "closed";
          if (body.title !== undefined) row.title = body.title as string;
          if (body.body !== undefined) row.body = body.body as string;
          if (Object.hasOwn(body, "milestone")) row.milestoneNumber = body.milestone as number | null;
          break;
        }
        default: throw Error("DO_NOT_LOG unsupported dispatch reached runtime");
      }
      const created = step.kind.endsWith(".create")
        ? step.kind === "issue.create" ? this.issues.at(-1)! : this.milestones.at(-1)!
        : undefined;
      return created
        ? this.incorrectResponse ? { number: 999, id: 999, node_id: "WRONG" } :
          { number: created.number, id: created.id, node_id: created.nodeId }
        : {};
    } finally {
      this.inFlight--;
    }
  }
}
async function denied(name: string, options: ApplyPlanOptions, expected: ApplyPlanErrorCode,
  expectedState?: string): Promise<ApplyPlanError> {
  let caught: unknown;
  try { await executeCallbackApplyPlan(options); }
  catch (error) { caught = error; }
  assert(caught instanceof ApplyPlanError, name + ": typed safe error expected.");
  equal(caught.code, expected, name + ": exact error code");
  if (expectedState) equal(caught.ownerState, expectedState,
    name + ": lock disposition");
  assert(!JSON.stringify(caught).includes("DO_NOT_LOG") &&
    !caught.message.includes("DO_NOT_LOG"), name + ": no raw error secrets");
  assert(caught.log.every((entry, index) =>
    entry.sequence === index + 1 &&
    Object.keys(entry).every((key) => ["runId","sequence","stepIndex","phase","outcome"].includes(key))),
    name + ": acknowledged audit prefix and restricted metadata only");
  return caught;
}

const fixture = new Fixture();
const success = await executeCallbackApplyPlan(fixture.config());
equal(success.status, "applied", "All four B1 kinds and create-followed-by-close are applied.");
equal(success.completedStepIds.length, 5, "All steps committed and verified.");
equal(success.skippedStepIds, [], "No preexisting step was skipped.");
equal(fixture.dispatches, 5, "Five writes for five unsatisfied B1 steps.");
equal(fixture.maxInFlight, 1, "No overlapping in-run mutations.");
equal(success.bindings.M?.number, 17, "Milestone numeric identity bound for issue create.");
equal(success.bindings.I?.number, 37, "Issue numeric identity bound for close.");
assert(!fixture.ownerHeld, "Successful run must release ownership.");
assert(fixture.logs.every((entry, index) => entry.sequence === index + 1),
  "Ack sequence must increase by exactly one within the same run.");
assert(fixture.logs.every((entry) => entry.runId === success.runId),
  "Every successful audit entry uses one stable opaque run ID.");
equal(success.log.length, fixture.logs.length,
  "Result only contains acknowledged safe audit events.");
const precedingWrites = fixture.dispatches;
const replay = await executeCallbackApplyPlan(fixture.config());
equal(replay.status, "already_satisfied", "Fresh verified rerun is a no-op.");
equal(fixture.dispatches, precedingWrites, "Rerun dispatches ZERO requests.");
equal(replay.skippedStepIds.length, 5, "All five replay steps are verified skipped.");
equal(replay.bindings.M?.number, 17, "Skipped milestone producer late-binds identity.");
equal(replay.bindings.I?.number, 37, "Skipped issue producer late-binds identity.");
assert(!fixture.ownerHeld, "No-op run still releases owner.");

const bad = clone(good);
bad.steps.push(step("label.create", "BAD", {
  protocol: "rest", method: "POST", path: "/repos/a/b/labels", body: { name: "DO_NOT_LOG" },
}));
bad.summary.planned++;
const badRuntime = new Fixture();
await denied("unsafe last step preflight", badRuntime.config(bad), "UNSUPPORTED_PLAN",
  "not_acquired");
equal(badRuntime.events, [], "Rejected final step causes ZERO callback/lock/reader work.");

const thrown = new Fixture();
thrown.failDispatch = () => true;
const uncertain = await denied("lost POST reply", thrown.config(),
  "INDETERMINATE_WRITE", "retained");
equal(thrown.dispatches, 1, "Uncertain POST is NEVER retried.");
assert(thrown.ownerHeld, "Unknown write outcome must retain owner for recovery.");
equal(uncertain.completedStepIds, [], "No unverified step can be completed.");
equal(uncertain.log.at(-1)?.outcome, "failed", "Safe failure audit acknowledged.");

const failedVerification = new Fixture();
failedVerification.afterReadInvalid = true;
await denied("postwrite reader fails", failedVerification.config(),
  "VERIFICATION_FAILED", "retained");
equal(failedVerification.dispatches, 1, "No second mutation after failed verification.");
assert(failedVerification.ownerHeld, "Unverified state retains lock.");

const alteredResponse = new Fixture();
alteredResponse.incorrectResponse = true;
await denied("wrong created response identity", alteredResponse.config(),
  "VERIFICATION_FAILED", "retained");
equal(alteredResponse.dispatches, 1, "No replay after mismatched create response.");

const invalidBefore = new Fixture();
invalidBefore.beforeReadInvalid = true;
await denied("reader returns malformed status", invalidBefore.config(),
  "UNVERIFIED_STATE", "released");
equal(invalidBefore.dispatches, 0, "Malformed before-read cannot dispatch.");

const missingOwner = new Fixture();
missingOwner.acquireReject = true;
await denied("acquire possibly committed before lost response", missingOwner.config(),
  "OWNER_UNCERTAIN", "unknown");
equal(missingOwner.dispatches, 0, "Ambiguous acquire cannot permit dispatch.");
assert(missingOwner.ownerHeld, "No speculative release after lost acquire reply.");

const lostOwner = new Fixture();
lostOwner.lostOwner = true;
await denied("owner no longer controls lock", lostOwner.config(),
  "OWNER_LOST", "unknown");
equal(lostOwner.dispatches, 0, "Lost owner blocks dispatch.");
assert(lostOwner.ownerHeld, "Do not release a ref no longer owned.");

const throwingOwner = new Fixture();
throwingOwner.assertReject = true;
await denied("owner assertion throws", throwingOwner.config(),
  "OWNER_LOST", "unknown");
equal(throwingOwner.dispatches, 0, "Thrown owner callback stops.");

const auditBeforeWrite = new Fixture();
auditBeforeWrite.failAudit = (entry) =>
  entry.outcome === "started" && entry.phase === "dispatch";
const auditFirst = await denied("durable dispatch-intent audit failure",
  auditBeforeWrite.config(), "AUDIT_FAILED");
equal(auditBeforeWrite.dispatches, 0, "Failing audit BEFORE write dispatches zero.");
equal(auditFirst.log.length, 1, "Only the ownership audit was acknowledged.");

const auditAfterWrite = new Fixture();
auditAfterWrite.failAudit = (entry) =>
  entry.outcome === "applied" && entry.phase === "verification";
const auditFinal = await denied("postwrite audit fails",
  auditAfterWrite.config(), "AUDIT_FAILED", "retained");
equal(auditAfterWrite.dispatches, 1, "No further writes after postwrite audit failed.");
equal(auditFinal.completedStepIds, [], "Unacknowledged applied step is not completed.");
equal(auditFinal.log.length, 2, "Only ownership and predispatch intent acknowledged.");

const releaseFailed = new Fixture();
releaseFailed.releaseReject = true;
const noFakeSuccess = await denied("release callback fails after verified writes",
  releaseFailed.config(), "RELEASE_FAILED", "unknown");
equal(releaseFailed.dispatches, 5, "Reads and writes may have completed before release error.");
equal(noFakeSuccess.completedStepIds.length, 5, "Partial verified step IDs survive error.");
assert(releaseFailed.ownerHeld, "Release failure must not report lock free.");

const auditAfterRelease = new Fixture();
auditAfterRelease.failAudit = (entry) =>
  entry.outcome === "applied" && entry.phase === "release";
await denied("failed postrelease audit is not success", auditAfterRelease.config(),
  "AUDIT_FAILED", "released");
assert(!auditAfterRelease.ownerHeld, "Known prior release remains released despite audit failure.");

const ctrlBefore = new AbortController();
ctrlBefore.abort();
const abortedBefore = new Fixture();
await denied("already-aborted signal rejects before owner callback",
  { ...abortedBefore.config(), signal: ctrlBefore.signal },
  "ABORTED", "not_acquired");
equal(abortedBefore.events, [], "Preflight abort performs no callback.");

const ctrlBetween = new AbortController();
const abortDuringRead = new Fixture();
abortDuringRead.beforeReadHook = () => { ctrlBetween.abort(); };
await denied("abort before dispatch after a read", {
  ...abortDuringRead.config(), signal: ctrlBetween.signal,
}, "ABORTED", "released");
equal(abortDuringRead.dispatches, 0, "Pre-dispatch abort causes zero writes.");

const ctrlDuring = new AbortController();
const during = new Fixture();
let entered!: () => void, leave!: () => void;
const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
const leavePromise = new Promise<void>((resolve) => { leave = resolve; });
during.dispatchHook = async () => { entered(); await leavePromise; };
const pending = denied("abort while dispatch in flight", {
  ...during.config(), signal: ctrlDuring.signal,
}, "ABORTED", "released");
await enteredPromise;
assert(during.inFlight === 1, "Mutation was in flight at time of abort.");
ctrlDuring.abort();
leave();
const interrupted = await pending;
equal(during.dispatches, 1, "Abort after in-flight dispatch does not start another mutation.");
equal(interrupted.completedStepIds.length, 1, "Terminally verified write retained in partial result.");
assert(!during.ownerHeld, "After confirmed terminal read the lock can be released.");
assert(during.events.some((e) => e.startsWith("read:after:")),
  "Must read POST postcondition after abort; cannot pretend canceling stopped it.");

const ctrlUnknown = new AbortController();
const unknown = new Fixture();
unknown.dispatchHook = async () => { ctrlUnknown.abort(); throw Error("DO_NOT_LOG interrupted POST"); };
await denied("aborted POST with unknown outcome", {
  ...unknown.config(), signal: ctrlUnknown.signal,
}, "INDETERMINATE_WRITE", "retained");
assert(unknown.ownerHeld, "Unknown aborted POST cannot be released.");

const rollback = new Fixture();
const seeded = await executeCallbackApplyPlan(rollback.config());
assert(seeded.status === "applied", "Seed a verified fake state.");
rollback.dispatches = 0;
rollback.extraIssue = {
  ...rollback.issues.find((x) => x.number === 37)!,
  number: 55, id: 5500, nodeId: "I_5500",
};
await denied("duplicate exact marker on rerun", rollback.config(),
  "UNVERIFIED_STATE", "released");
equal(rollback.dispatches, 0, "Ambiguous marker cannot cause writes.");

const lying = new Fixture();
lying.beforeReadHook = (ctx) => {
  if (ctx.spec.kind === "milestone.create") {
    lying.milestones.push({
      kind: "milestone", number: 17, id: 1700, nodeId: "M_1700",
      title: "Release", state: "open", description: "WRONG", due_on: "2027-01-03T00:00:00Z",
    });
  }
};
await denied("existing unique title but conflicting managed fields", lying.config(),
  "UNVERIFIED_STATE", "released");
equal(lying.dispatches, 0, "Existing mismatched title must not be adopted/created again.");

console.log("C2 #188: guarded four-kind callback graph, late binding, verified replay, serial writes, audit prefix, cancellation and uncertain-owner refusal passed.");
