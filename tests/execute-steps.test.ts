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
    body: { title: "Issue", milestone: { $ref: "M.number" } } });
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
const calls: Array<{ method: string; path: string; body?: unknown }> = [];
const original = plan([patch, issue, milestone]);
const before = JSON.stringify(original);
const result = await executePlanSteps(original, async (request) => {
  check(request.protocol === "rest", "Only REST fixture requests are expected.");
  calls.push({ method: request.method, path: request.path, body: request.body });
  return request.path.endsWith("/milestones")
    ? { id: 200, number: 7, node_id: "M_7" } :
    request.path.endsWith("/issues") ? { id: 800, number: 12, node_id: "I_12" } : {};
});
equal(result.completedStepIds, ["milestone.create:M", "issue.create:I", "issue.update:I"],
  "Unordered plan must execute in complete topological order.");
equal(result.bindings, { M: { id: 200, number: 7, nodeId: "M_7" },
  I: { id: 800, number: 12, nodeId: "I_12" } },
"Create responses populate only identity bindings.");
equal(calls, [
  { method: "POST", path: "/repos/a/b/milestones", body: { title: "Sprint" } },
  { method: "POST", path: "/repos/a/b/issues", body: { title: "Issue", milestone: 7 } },
  { method: "PATCH", path: "/repos/a/b/issues/12", body: { state: "closed" } },
], "Consumer body/path must use purely bound producer identities.");
equal(JSON.stringify(original), before, "Executor must not mutate the proposed plan.");

async function rejected(input: GithubPlan, why: string): Promise<void> {
  let writes = 0;
  let failed = false;
  try { await executePlanSteps(input, async () => { writes++; return {}; }); }
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
  });
} catch { failed = true; }
check(failed, "Invalid post-create identity must stop execution.");
equal(writes, 1, "No consumer may execute with an invalid producer identity.");

console.log("M8.1.1 ordered request execution fixtures passed.");
