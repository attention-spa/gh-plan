/** M8.1.5 stateful, no-network replay fixtures for the internal executor. */
import { executePlanSteps, PlanExecutionError } from "../src/execute-steps.ts";
import type { PlanApplyLogEntry } from "../src/execute-steps.ts";
import type { GithubPlan, ObservedIssue, PlanStep } from "../src/types.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(message + "\nexpected: " + JSON.stringify(expected) +
      "\nactual: " + JSON.stringify(actual));
}
const marker = "<!-- gh-plan:I -->";
const body = marker + "\nRelease checklist.";
const SECRET = "Bearer secret-injected-fixture";
function step(id: string, kind: PlanStep["kind"], logicalId: string,
  dependsOn: string[], request: NonNullable<PlanStep["request"]>): PlanStep {
  return {
    id, kind, logicalId, dependsOn, request, status: "planned", current: null,
    desired: null, reason: SECRET, preconditions: [],
    expectedPostconditions: ["All managed fields match"], destructive: false,
    reversible: "partial",
  };
}
const milestone = step("milestone.create:M", "milestone.create", "M", [],
  { protocol: "rest", method: "POST", path: "/repos/a/b/milestones",
    body: { title: "Delivery" } });
const issue = step("issue.create:I", "issue.create", "I", [milestone.id],
  { protocol: "rest", method: "POST", path: "/repos/a/b/issues",
    body: { title: "Checklist", body, milestone: { $ref: "M.number" } } });
const close = step("issue.update:I", "issue.update", "I", [issue.id],
  { protocol: "rest", method: "PATCH",
    path: ["/repos/a/b/issues/", { $ref: "I.number" }],
    body: { state: "closed" } });
const plan: GithubPlan = {
  metadata: { planner: "gh-plan", version: "0.1.0", mode: "rest" },
  repository: { fullName: "a/b" },
  desired: { resourceCount: 2, relationshipCount: 0 },
  resolutions: [
    { logicalId: "M", kind: "milestone", status: "new" },
    { logicalId: "I", kind: "issue", status: "new", identity: { marker } },
  ],
  steps: [close, issue, milestone], // deliberately reverse DAG order
  noops: [], warnings: [], blockers: [], unsupported: [], readiness: "ready",
  summary: { planned: 3, noops: 0, warnings: 0, blocked: 0, unsupported: 0 },
};
const frozen = JSON.stringify(plan);
const order = [milestone.id, issue.id, close.id];
const allApplied: PlanApplyLogEntry[] = [0, 1, 2].map(stepIndex =>
  ({ stepIndex, outcome: "applied", phase: "verification" }));
const allSkipped: PlanApplyLogEntry[] = [0, 1, 2].map(stepIndex =>
  ({ stepIndex, outcome: "skipped", phase: "precondition" }));

type Mode = "normal" | "lost-reply" | "lost-verification";
function server(mode: Mode) {
  let hasMilestone = false;
  let actualIssue: ObservedIssue | undefined;
  let failed = false;
  const writes = { milestone: 0, issue: 0, update: 0 };
  const reads = { postcondition: 0, catalog: 0 };
  const trace: string[] = [];
  let persisted: PlanApplyLogEntry[] = [];
  const dispatch: Parameters<typeof executePlanSteps>[1] = async (request, target) => {
    assert(request.protocol === "rest", "Only REST fixture requests may dispatch.");
    trace.push("write:" + target.id);
    if (target.kind === "milestone.create") {
      equal(request.body, { title: "Delivery" }, "Milestone create body.");
      assert(!hasMilestone, "Duplicate milestone POST.");
      writes.milestone++; hasMilestone = true;
      return { id: 70, number: 7, node_id: "M_7" };
    }
    if (target.kind === "issue.create") {
      equal(request.body, { title: "Checklist", body, milestone: 7 },
        "Issue body must include canonical marker and bound milestone.");
      assert(hasMilestone && !actualIssue, "Duplicate or out-of-order issue POST.");
      writes.issue++;
      actualIssue = {
        kind: "issue", id: 420, number: 42, nodeId: "I_42",
        body, title: "Checklist", state: "open", milestoneNumber: 7,
      };
      if (mode === "lost-reply" && !failed) {
        failed = true;
        throw Error(SECRET + " lost response after remote issue create");
      }
      return { id: 420, number: 42, node_id: "I_42" };
    }
    assert(target.kind === "issue.update", "Unexpected planned operation.");
    equal(request.path, "/repos/a/b/issues/42",
      "Recovery must late-bind the previously created issue identity.");
    equal(request.body, { state: "closed" }, "Update must be minimally scoped.");
    assert(actualIssue, "Cannot close a missing issue.");
    writes.update++; actualIssue.state = "closed";
    return {};
  };
  const read: Parameters<typeof executePlanSteps>[2] = async (target, request, bindings) => {
    reads.postcondition++; trace.push("read:" + target.id);
    assert(request.protocol === "rest", "Postcondition check expects bound REST request.");
    if (target.kind === "milestone.create") {
      return hasMilestone
        ? { status: "satisfied", identity: { id: 70, number: 7, node_id: "M_7" } }
        : { status: "unsatisfied" };
    }
    if (target.kind === "issue.create") {
      equal(request.body, { title: "Checklist", body, milestone: 7 },
        "Postcondition observes bound milestone number.");
      equal(bindings.M?.number, 7, "Producer binding must precede issue read.");
      if (!actualIssue) return { status: "unsatisfied" };
      if (mode === "lost-verification" && !failed && bindings.I?.number === 42) {
        failed = true;
        throw Error(SECRET + " failed post-write read");
      }
      assert(actualIssue.title === "Checklist" &&
        actualIssue.body === body && actualIssue.milestoneNumber === 7,
      "Satisfaction must cover every managed create property.");
      return { status: "satisfied", identity: {
        id: actualIssue.id, number: actualIssue.number, node_id: actualIssue.nodeId,
      } };
    }
    equal(request.path, "/repos/a/b/issues/42", "Update postcondition uses bound path.");
    equal(bindings.I?.number, 42, "Recovered issue number required to verify update.");
    return actualIssue?.state === "closed"
      ? { status: "satisfied" } : { status: "unsatisfied" };
  };
  const catalog: Parameters<typeof executePlanSteps>[3] = async (fullName) => {
    equal(fullName, "a/b", "Catalog must be scoped to the declared repository.");
    reads.catalog++; trace.push("catalog");
    return actualIssue ? [{ ...actualIssue }] : [];
  };
  async function run() {
    persisted = [];
    const result = await executePlanSteps(plan, dispatch, read, catalog,
      async (entry) => { persisted.push({ ...entry }); });
    equal(result.completedStepIds, order, "DAG executes in dependency order.");
    equal(result.log, persisted, "Persisted decisions match returned log.");
    equal(JSON.stringify(plan), frozen, "Execution cannot mutate caller plan.");
    assert(!JSON.stringify(result.log).includes(SECRET), "Log must exclude secrets.");
    return result;
  }
  return {
    run, writes, reads, trace,
    get issues() { return actualIssue ? [{ ...actualIssue }] : []; },
    get persisted() { return persisted; },
  };
}

const normal = server("normal");
const first = await normal.run();
equal(first.skippedStepIds, [], "First clean run must apply all steps.");
equal(first.log, allApplied, "Successful run logs all verified writes.");
equal(normal.writes, { milestone: 1, issue: 1, update: 1 },
  "Three remote mutations are required in initial run.");
equal(normal.reads, { postcondition: 6, catalog: 2 },
  "Every initial write requires before/after postcondition reads and issue catalogs.");
const before = { ...normal.writes }, readsBefore = { ...normal.reads };
const replay = await normal.run();
equal(replay.skippedStepIds, order, "Successful rerun must skip every step.");
equal(replay.log, allSkipped, "Rerun log records only skips.");
equal(replay.bindings, first.bindings, "Rerun rediscovers the same producer identities.");
equal(normal.writes, before, "Successful rerun must perform exactly ZERO writes.");
equal(normal.reads.postcondition - readsBefore.postcondition, 3,
  "Rerun freshly reads each postcondition.");
equal(normal.reads.catalog - readsBefore.catalog, 1,
  "Rerun checks issue marker catalog before skipping create.");
equal(normal.issues.length, 1, "Successful rerun must not create duplicates.");

for (const mode of ["lost-reply", "lost-verification"] as const) {
  const simulated = server(mode);
  let failure: PlanExecutionError | undefined;
  try { await simulated.run(); }
  catch (error) {
    assert(error instanceof PlanExecutionError,
      mode + " failure must have sanitized type.");
    failure = error;
  }
  assert(failure, mode + " must simulate a mid-run failure.");
  equal(failure.stepIndex, 1, mode + " fails on issue create step.");
  equal(failure.phase, mode === "lost-reply" ? "dispatch" : "verification",
    mode + " reports the correct, allowlisted phase.");
  equal(failure.log, [
    allApplied[0],
    { stepIndex: 1, outcome: "failed", phase: failure.phase },
  ], mode + " keeps successful prior decision and terminal failure.");
  equal(simulated.persisted, failure.log, mode + " persists partial log.");
  assert(!JSON.stringify({ message: failure.message, phase: failure.phase,
    code: failure.code, log: failure.log }).includes(SECRET),
  mode + " hides sensitive injected exception text.");
  equal(simulated.writes, { milestone: 1, issue: 1, update: 0 },
    mode + " halts after one remotely committed issue create.");
  equal(simulated.issues.length, 1,
    mode + " must have exactly one persisted issue before recovery.");

  const resumed = await simulated.run(); // SAME stale plan, fresh GitHub reads
  equal(resumed.skippedStepIds, [milestone.id, issue.id],
    mode + " skips both already-created producers.");
  equal(resumed.log, [allSkipped[0], allSkipped[1], allApplied[2]],
    mode + " resumes unfinished dependent update after verified skips.");
  equal(resumed.bindings.I?.number, 42,
    mode + " rebinds the recovered issue identity.");
  equal(simulated.writes, { milestone: 1, issue: 1, update: 1 },
    mode + " must not repeat either create operation.");
  equal(simulated.issues.length, 1, mode + " must not duplicate issue.");

  const lastWrites = { ...simulated.writes };
  const lastReads = { ...simulated.reads };
  const finalReplay = await simulated.run();
  equal(finalReplay.skippedStepIds, order,
    mode + " final replay must skip all three operations.");
  equal(finalReplay.log, allSkipped,
    mode + " final replay contains only skip records.");
  equal(simulated.writes, lastWrites,
    mode + " final replay must perform zero additional writes.");
  equal(simulated.reads.postcondition - lastReads.postcondition, 3,
    mode + " final replay independently checks each postcondition.");
  equal(simulated.reads.catalog - lastReads.catalog, 1,
    mode + " final replay rereads the full issue catalog.");
  equal(simulated.issues.length, 1, mode + " final state has one issue.");
}
equal(JSON.stringify(plan), frozen, "Every replay must preserve the original plan.");
console.log("M8.1.5 successful rerun and two mid-run failure recovery fixtures passed.");
