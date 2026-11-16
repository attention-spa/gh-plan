import { executePlanSteps, PlanExecutionError } from "../src/execute-steps.ts";
import type { PlanApplyLogEntry } from "../src/execute-steps.ts";
import type { GithubPlan, PlanStep } from "../src/types.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(message + "\nexpected: " + JSON.stringify(expected) +
      "\nactual: " + JSON.stringify(actual));
  }
}
const SECRET = "Bearer secret-token-should-never-appear-in-logs";
const create: PlanStep = {
  id: "milestone.create:M", kind: "milestone.create", logicalId: "M",
  status: "planned", current: null, desired: null,
  reason: SECRET, preconditions: [], expectedPostconditions: ["Created"],
  dependsOn: [], destructive: false, reversible: "partial",
  request: { protocol: "rest", method: "POST", path: "/repos/a/b/milestones",
    body: { title: "Sprint", description: SECRET } },
};
const update: PlanStep = {
  ...create, id: "milestone.update:M", kind: "milestone.update", reversible: true,
  dependsOn: [create.id], request: {
    protocol: "rest", method: "PATCH",
    path: ["/repos/a/b/milestones/", { $ref: "M.number" }],
    body: { state: "closed" },
  },
};
function plan(steps: PlanStep[] = [update, create]): GithubPlan {
  return {
    metadata: { planner: "gh-plan", version: "0.1.0", mode: "rest" },
    repository: { fullName: "a/b" },
    desired: { resourceCount: 1, relationshipCount: 0 },
    resolutions: [], steps, noops: [], warnings: [], blockers: [],
    unsupported: [], readiness: "ready",
    summary: { planned: steps.length, noops: 0, blocked: 0,
      unsupported: 0, warnings: 0 },
  };
}
const successfulLog: PlanApplyLogEntry[] = [
  { stepIndex: 0, outcome: "applied", phase: "verification" },
  { stepIndex: 1, outcome: "applied", phase: "verification" },
];
const steps: string[] = [];
const persisted: PlanApplyLogEntry[] = [];
let exists = false, closed = false, writes = 0;
const happy = await executePlanSteps(plan(), async (request, step) => {
  writes++;
  steps.push("dispatch:" + step.kind);
  check(request.protocol === "rest", "Fixture requests must be REST.");
  if (step.kind === "milestone.create") {
    exists = true;
    return { id: 50, number: 7, node_id: "M_7" };
  }
  equal(request.path, "/repos/a/b/milestones/7",
    "Dependent update must bind the independently verified milestone number.");
  closed = true;
  return {};
}, async (step, request, bindings) => {
  const isCreate = step.kind === "milestone.create";
  steps.push("read:" + step.kind + ":" + (isCreate ? exists : closed));
  if (isCreate) {
    if (exists) {
      equal(bindings.M?.number, 7,
        "After-create verification must see a valid provisional identity.");
      return { status: "satisfied", identity: {
        id: 50, number: 7, node_id: "M_7",
      } };
    }
    return { status: "unsatisfied" };
  }
  equal(bindings.M?.number, 7, "Consumer reads only confirmed producer identities.");
  equal(request.protocol === "rest" && request.path, "/repos/a/b/milestones/7",
    "Fresh reads must use the bound consumer path.");
  return closed ? { status: "satisfied" } : { status: "unsatisfied" };
}, undefined, async (entry) => {
  persisted.push(entry);
});
equal(writes, 2, "Two unsatisfied steps must be written.");
equal(steps, [
  "read:milestone.create:false", "dispatch:milestone.create",
  "read:milestone.create:true",
  "read:milestone.update:false", "dispatch:milestone.update",
  "read:milestone.update:true",
], "Each write must have a before and after read, before the next step.");
equal(happy.completedStepIds, [create.id, update.id],
  "Verified steps are completed in dependency order.");
equal(happy.skippedStepIds, [], "No writes were skipped.");
equal(happy.log, successfulLog, "Verification log is deterministic and minimal.");
equal(persisted, successfulLog, "Sink receives only verified write records.");
check(!JSON.stringify(happy.log).includes(SECRET) &&
      !JSON.stringify(persisted).includes(SECRET),
  "Apply logs must not contain injected request secrets.");
check(happy.bindings.M?.number === 7,
  "Only verified create identities become final bindings.");

// A fully satisfied rerun only reads state and records skipped steps.
const rerun = await executePlanSteps(plan(), async () => {
  throw Error("Already-applied steps may not dispatch.");
}, async (step) => step.kind === "milestone.create"
  ? { status: "satisfied", identity: { id: 50, number: 7, node_id: "M_7" } }
  : { status: "satisfied" });
equal(rerun.skippedStepIds, [create.id, update.id], "Rerun skips both writes.");
equal(rerun.log, [
  { stepIndex: 0, outcome: "skipped", phase: "precondition" },
  { stepIndex: 1, outcome: "skipped", phase: "precondition" },
], "Every skip has a secret-free log entry.");
equal(writes, 2, "Rerun performed zero additional writes.");

async function failing(
  label: string,
  dispatch: Parameters<typeof executePlanSteps>[1],
  read: Parameters<typeof executePlanSteps>[2],
  expectedPhase: PlanExecutionError["phase"],
  expectedWrites: number,
  onLog?: Parameters<typeof executePlanSteps>[4],
): Promise<void> {
  const events: PlanApplyLogEntry[] = [];
  let dispatchCount = 0;
  try {
    await executePlanSteps(plan(), async (request, step) => {
      dispatchCount++;
      return dispatch(request, step);
    }, read, undefined, async (entry) => {
      events.push(entry);
      await onLog?.(entry);
    });
    throw Error("Expected failure for " + label);
  } catch (e) {
    check(e instanceof PlanExecutionError,
      label + " must throw a structured, sanitized PlanExecutionError.");
    equal(e.code, "PLAN_STEP_FAILED", label + " error code.");
    equal(e.phase, expectedPhase, label + " error phase.");
    equal(e.stepIndex, 0, label + " stops on the first operation.");
    equal(e.log.map((entry) => entry.outcome).at(-1), "failed",
      label + " records the terminal failure.");
    const full = JSON.stringify({
      message: e.message, code: e.code, phase: e.phase, log: e.log,
    });
    check(!full.includes(SECRET), label + " must not leak response/error secrets.");
  }
  equal(dispatchCount, expectedWrites,
    label + " must never dispatch the dependent operation.");
  if (expectedPhase !== "logging") {
    equal(events.at(-1)?.outcome, "failed",
      label + " must emit failure to the sink.");
  }
}

await failing("Dispatch transport throws", async () => {
  throw Error(SECRET);
}, async () => ({ status: "unsatisfied" }), "dispatch", 1);
await failing("Verifier reports stale state", async () => ({ number: 7 }), (() => {
  let reads = 0;
  return async () => (++reads === 1
    ? { status: "unsatisfied" } : { status: "unsatisfied" });
})(), "verification", 1);
await failing("Verifier throws credentials", async () => ({ number: 7 }), (() => {
  let reads = 0;
  return async () => {
    if (++reads === 2) throw Error(SECRET);
    return { status: "unsatisfied" };
  };
})(), "verification", 1);
await failing("Post-create identity mismatch", async () => ({ number: 7 }), (() => {
  let reads = 0;
  return async () => ++reads === 1 ? { status: "unsatisfied" } :
    { status: "satisfied", identity: { number: 8 } };
})(), "verification", 1);
await failing("Post-create identity absent", async () => ({ number: 7 }), (() => {
  let reads = 0;
  return async () => ++reads === 1 ? { status: "unsatisfied" } :
    { status: "satisfied" };
})(), "verification", 1);
await failing("Sink refuses verified record", async () => ({ number: 7 }), (() => {
  let reads = 0;
  return async () => ++reads === 1 ? { status: "unsatisfied" } :
    { status: "satisfied", identity: { number: 7 } };
})(), "logging", 1, () => { throw Error(SECRET); });

// Verify a previously completed step remains in a partial safe log when the
// second step cannot be verified after being written.
let dispatched = 0, readCount = 0;
const partialLog: PlanApplyLogEntry[] = [];
try {
  await executePlanSteps(plan(), async (request, step) => {
    dispatched++;
    check(request.protocol === "rest", "Expected REST fixture.");
    return step.kind === "milestone.create"
      ? { number: 7 } : {};
  }, async (step) => {
    readCount++;
    if (step.kind === "milestone.create") {
      return readCount === 1 ? { status: "unsatisfied" } :
        { status: "satisfied", identity: { number: 7 } };
    }
    return { status: "unsatisfied" };
  }, undefined, async (entry) => { partialLog.push(entry); });
  throw Error("Second-step verification should fail.");
} catch (e) {
  check(e instanceof PlanExecutionError && e.stepIndex === 1 &&
    e.phase === "verification", "Second-step failed verification should stop.");
  equal(e.log, [
    { stepIndex: 0, outcome: "applied", phase: "verification" },
    { stepIndex: 1, outcome: "failed", phase: "verification" },
  ], "A failure must retain successfully verified prior steps.");
  equal(partialLog, e.log,
    "Sink receives verified successes and terminal failure in order.");
}
equal(dispatched, 2, "Failure stops after second write.");
equal(readCount, 4, "Post-write verification ran for both mutations.");

console.log("M8.1.4 post-write verification, stop-first-failure and secret-free logs passed.");
