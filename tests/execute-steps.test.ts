import { executePlanSteps } from "../src/execute-steps.ts";
import type { GithubPlan, PlanRequest, PlanStep } from "../src/types.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + "\nExpected: " + JSON.stringify(expected) +
      "\nActual: " + JSON.stringify(actual));
  }
}
function step(
  id: string, kind: PlanStep["kind"], logicalId: string, dependsOn: string[],
  request: PlanRequest,
): PlanStep {
  return {
    id, kind, logicalId, dependsOn, request, status: "planned",
    current: null, desired: null, reason: "fixture", preconditions: [],
    expectedPostconditions: ["state matches"], destructive: false, reversible: "partial",
  };
}
const milestone = step("milestone.create:M", "milestone.create", "M", [],
  { protocol: "rest", method: "POST", path: "/repos/a/b/milestones",
    body: { title: "Sprint" } });
const issue = step("issue.create:I", "issue.create", "I", ["milestone.create:M"],
  { protocol: "rest", method: "POST", path: "/repos/a/b/issues",
    body: { title: "Issue", body: "<!-- gh-plan:I -->", milestone: { $ref: "M.number" } } });
const patch = step("issue.update:I", "issue.update", "I", ["issue.create:I"],
  { protocol: "rest", method: "PATCH",
    path: ["/repos/a/b/issues/", { $ref: "I.number" }],
    body: { state: "closed" } });
function plan(steps: PlanStep[], readiness: GithubPlan["readiness"] = "ready"): GithubPlan {
  return {
    metadata: { planner: "gh-plan", version: "0.1.0", mode: "rest" },
    repository: { fullName: "a/b" }, desired: { resourceCount: 2, relationshipCount: 0 },
    resolutions: [], steps, noops: [], warnings: [], blockers: [], unsupported: [],
    summary: { planned: steps.length, noops: 0, warnings: 0, blocked: 0, unsupported: 0 },
    readiness,
  };
}
const marked = {
  kind: "issue" as const, number: 12, id: 800,
  title: "Issue", body: "<!-- gh-plan:I -->", state: "open" as const,
  nodeId: "I_12",
};
const calls: Array<{ method: string; path: string; body?: unknown }> = [];
const events: string[] = [];
const original = plan([patch, issue, milestone]);
const before = JSON.stringify(original);
const result = await executePlanSteps(original, async (request, s) => {
  check(request.protocol === "rest", "Only REST fixture requests are expected.");
  events.push("write:" + s.id);
  calls.push({ method: request.method, path: request.path, body: request.body });
  return request.path.endsWith("/milestones")
    ? { id: 200, number: 7, node_id: "M_7" } :
    request.path.endsWith("/issues") ? { id: 800, number: 12, node_id: "I_12" } : {};
}, async (s, request, bindings) => {
  events.push("read:" + s.id);
  check(request.protocol === "rest", "Every read receives the bound REST request.");
  if (s.id === "issue.create:I") {
    equal(bindings.M?.number, 7, "Reader receives the previous producer binding.");
    equal(request.body, { title: "Issue", body: "<!-- gh-plan:I -->", milestone: 7 },
      "Reader receives resolved body, never unresolved references.");
  }
  if (s.id === "issue.update:I") {
    equal(bindings.I?.number, 12, "Reader sees issue identity after create.");
    equal(request.path, "/repos/a/b/issues/12", "Reader sees resolved update path.");
  }
  return { status: "unsatisfied" };
}, async () => []);

equal(result.completedStepIds, ["milestone.create:M", "issue.create:I", "issue.update:I"],
  "Unordered plan must execute in complete topological order.");
equal(result.skippedStepIds, [], "Unsatisfied reads must not be classified as skips.");
equal(events, [
  "read:milestone.create:M", "write:milestone.create:M",
  "read:issue.create:I", "write:issue.create:I",
  "read:issue.update:I", "write:issue.update:I",
], "Every step must have a fresh read immediately before its write.");
equal(result.bindings, { M: { id: 200, number: 7, nodeId: "M_7" },
  I: { id: 800, number: 12, nodeId: "I_12" } },
"Create responses populate only identity bindings.");
equal(calls, [
  { method: "POST", path: "/repos/a/b/milestones", body: { title: "Sprint" } },
  { method: "POST", path: "/repos/a/b/issues", body: { title: "Issue", body: "<!-- gh-plan:I -->", milestone: 7 } },
  { method: "PATCH", path: "/repos/a/b/issues/12", body: { state: "closed" } },
], "Consumer body/path must use purely bound producer identities.");
equal(JSON.stringify(original), before, "Executor must not mutate the proposed plan.");

async function rejected(input: GithubPlan, why: string): Promise<void> {
  let writes = 0;
  let failed = false;
  try { await executePlanSteps(input, async () => { writes++; return {}; },
    async () => ({ status: "unsatisfied" }), async () => []); }
  catch { failed = true; }
  check(failed, why + ": must reject.");
  equal(writes, 0, why + ": complete preflight must prevent writes.");
}
await rejected(plan([issue, milestone], "blocked"), "Blocked readiness");
await rejected(plan([patch]), "Missing producing step");
await rejected(plan([{ ...patch, request: undefined }, issue, milestone]), "Missing request");
await rejected(plan([milestone, milestone]), "Duplicate IDs");
await rejected(plan([{ ...milestone, dependsOn: ["issue.create:I"] }, issue]), "Dependency cycle");
await rejected(plan([{ ...milestone, dependsOn: ["missing"] }]), "Unknown dependency");
await rejected(plan([{ ...milestone, status: "noop" }]), "Non-planned step");
await rejected(plan([{ ...issue, dependsOn: [] }, milestone]), "Missing explicit ref dependency");

let writes = 0;
let failed = false;
try {
  await executePlanSteps(plan([issue, milestone]), async (request) => {
    writes++;
    if (request.protocol === "rest" && request.path.endsWith("/milestones")) {
      return { number: "not an integer" };
    }
    return {};
  }, async () => ({ status: "unsatisfied" }), async () => []);
} catch { failed = true; }
check(failed, "Invalid post-create identity must stop execution.");
equal(writes, 1, "No consumer may execute with an invalid producer identity.");

// Preflight rejects an omitted verifier before even asking the write transport.
let noReaderWrites = 0;
await executePlanSteps(plan([]), async () => { noReaderWrites++; return {}; },
  undefined as unknown as Parameters<typeof executePlanSteps>[2]).then(
  () => { throw new Error("A missing reader must fail closed."); },
  () => {},
);
equal(noReaderWrites, 0, "Missing read dependency must not permit writes.");

// A newly satisfied postcondition must cause a no-write skip, not be checked
// only once at the start against the planner's stale snapshot.
const rerunEvents: string[] = [];
const resumed = await executePlanSteps(original, async (_request, s) => {
  rerunEvents.push("write:" + s.id);
  return {};
}, async (s, bound, prior) => {
  rerunEvents.push("read:" + s.id);
  if (s.id === "milestone.create:M") {
    return { status: "satisfied", identity: { number: 7, id: 200, node_id: "M_7" } };
  }
  if (s.id === "issue.create:I") {
    equal(prior.M?.number, 7, "Skipped milestone must supply future binding.");
    equal(bound.protocol === "rest" && bound.body, { title: "Issue", body: "<!-- gh-plan:I -->", milestone: 7 },
      "The read after a skipped milestone must receive the fully bound request.");
    return { status: "satisfied", identity: { number: 12, id: 800 } };
  }
  equal(prior.I?.id, 800, "Skipped issue must supply verified identity.");
  return { status: "satisfied" };
}, async () => [marked]);
equal(resumed.completedStepIds, ["milestone.create:M", "issue.create:I", "issue.update:I"],
  "All verified skips remain completed.");
equal(resumed.skippedStepIds, ["milestone.create:M", "issue.create:I", "issue.update:I"],
  "Already-applied operations must be recorded as skipped.");
equal(resumed.bindings, result.bindings, "Skipped creates must yield the same identities.");
equal(rerunEvents, ["read:milestone.create:M", "read:issue.create:I", "read:issue.update:I"],
  "Fully satisfied plan must perform three fresh reads but zero writes.");

const mixedEvents: string[] = [];
const mixed = await executePlanSteps(original, async (bound, s) => {
  mixedEvents.push("write:" + s.id);
  if (s.id === "issue.create:I") {
    check(bound.protocol === "rest", "REST create expected.");
    equal(bound.body, { title: "Issue", body: "<!-- gh-plan:I -->", milestone: 7 },
      "A skipped milestone still binds the issue create request.");
    return { number: 12, id: 800 };
  }
  return {};
}, async (s) => {
  mixedEvents.push("read:" + s.id);
  if (s.id === "milestone.create:M") {
    return { status: "satisfied", identity: { number: 7 } };
  }
  return s.id === "issue.update:I"
    ? { status: "satisfied" } : { status: "unsatisfied" };
}, async () => []);

equal(mixed.skippedStepIds, ["milestone.create:M", "issue.update:I"],
  "Only satisfied steps should be skipped.");
equal(mixedEvents, [
  "read:milestone.create:M",
  "read:issue.create:I", "write:issue.create:I",
  "read:issue.update:I",
], "Read-after-prerequisite changes must be authoritative and per step.");

async function unreadable(
  checked: unknown, label: string,
): Promise<void> {
  let reads = 0, writes = 0;
  try {
    await executePlanSteps(plan([milestone]), async () => {
      writes++; return { number: 1 };
    }, async () => {
      reads++;
      return checked as Awaited<ReturnType<Parameters<typeof executePlanSteps>[2]>>;
    });
    throw new Error("Expected read failure: " + label);
  } catch (error) {
    check(error instanceof Error, "Read failures must throw.");
    check(error.message !== "Expected read failure: " + label,
      "Unknown or malformed reader result must fail closed.");
  }
  equal(reads, 1, label + ": one read must precede any write.");
  equal(writes, 0, label + ": no writes on inconclusive read.");
}
await unreadable(undefined, "Missing result");
await unreadable({ status: "unknown" }, "Unknown result");
await unreadable({ status: "satisfied" }, "Skipped create without observed identity");
await unreadable({ status: "satisfied", identity: { number: "7" } },
  "Malformed observed identity");
await unreadable({ status: "unsatisfied", identity: { number: 7 } },
  "Contradictory unsatisfied result");

let readsBeforeFailure = 0, writesBeforeFailure = 0;
try {
  await executePlanSteps(plan([milestone, issue]), async () => {
    writesBeforeFailure++; return { number: 7 };
  }, async () => {
    readsBeforeFailure++;
    if (readsBeforeFailure === 2) throw new Error("Read failed after earlier write.");
    return { status: "unsatisfied" };
  }, async () => []);
  throw new Error("Expected second reader failure.");
} catch (error) {
  check(error instanceof Error && error.message === "Read failed after earlier write.",
    "Fresh-read transport failure must immediately stop subsequent writes.");
}
equal(readsBeforeFailure, 2, "Read must be retried on each step.");
equal(writesBeforeFailure, 1, "Second step cannot write when its read fails.");

console.log("M8.1.2 fresh pre-step postcondition reads and skip fixtures passed.");
