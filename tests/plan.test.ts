import { GITHUB_PLAN_VERSION, planGithub } from "../src/index.ts";
import type { FetchLike, FetchResponseLike, GithubPlan } from "../src/index.ts";

function check(condition: unknown, text: string): asserts condition {
  if (!condition) throw Error(text);
}
function equal(a: unknown, b: unknown, text: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(text + "\nexpected: " + JSON.stringify(b) + "\nactual: " + JSON.stringify(a));
  }
}
const repo = "alice/plan";
const base = "https://api.github.com/repos/" + repo;
const marker = (id: string) => "<!-- gh-plan:" + id + " -->";
const schema = {
  repository: repo,
  milestones: [{ logicalId: "M", title: "Iteration" }],
  issues: [
    { logicalId: "P", title: "Parent", milestone: "M" },
    { logicalId: "C", title: "Child", milestone: "M", blockedBy: ["P"], relatesTo: ["P"] },
  ],
  relationships: [{ kind: "parent", parent: "P", child: "C" }],
};
type Mode = "empty" | "applied" | "invalid_type" | "error";
function response(status: number, data: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300, status,
    statusText: status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Mock",
    headers: { get(key) { return headers[key.toLowerCase()] ?? null; } },
    async json() { return data; }, async text() { return JSON.stringify(data); },
  };
}
function mock(mode: Mode, calls: string[], status = 401): FetchLike {
  return async (url, options) => {
    calls.push(url);
    check(options?.method === "GET", "Orchestrator can only GET; no live mutation.");
    check(options?.headers?.Authorization === "Bearer fixture-secret", "REST receives injected authorization.");
    if (mode === "error") return response(status, { message: "not authorized" },
      status === 403 ? { "x-ratelimit-remaining": "1" } : {});
    if (url === base) return response(200, {
      id: 20, node_id: "R_20", full_name: repo, owner: { type: "User", login: "alice" },
    });
    if (url === base + "/milestones?state=all&per_page=100") {
      return response(200, mode === "empty" || mode === "invalid_type" ? [] :
        [{ id: 100, number: 1, title: "Iteration", state: "open" }]);
    }
    if (url === base + "/issue-types") return response(200, []);
    if (url === base + "/issues?state=all&per_page=100") {
      if (mode !== "applied") return response(200, []);
      return response(200, [
        { id: 1000, number: 10, node_id: "I_10", title: "Parent",
          body: marker("P"), state: "open", milestone: { number: 1 } },
        { id: 1100, number: 11, node_id: "I_11", title: "Child",
          body: marker("C"), state: "open", milestone: { number: 1 } },
      ]);
    }
    const match = url.match(/\/issues\/(10|11)\/(parent|dependencies\/blocked_by\?per_page=100|relates_to\?per_page=100)$/);
    if (match) {
      const num = Number(match[1]), part = match[2];
      if (part === "parent") return num === 11 ?
        response(200, { number: 10 }) : response(404, { message: "Not Found" });
      if (part === "dependencies/blocked_by?per_page=100")
        return response(200, num === 11 ? [{ number: 10 }] : []);
      if (part === "relates_to?per_page=100")
        return response(200, [{ number: num === 11 ? 10 : 11 }]);
    }
    throw Error("Unexpected fixture URL: " + url);
  };
}
const make = async (mode: Mode, calls: string[], otherSchema: object = schema, status?: number) =>
  planGithub({ schema: otherSchema, auth: "fixture-secret", fetch: mock(mode, calls, status) });

const calls: string[] = [];
let plan = await make("empty", calls);
equal(plan.readiness, "ready", "Empty repo should have ready plan.");
equal(plan.metadata, { planner: "gh-plan", version: GITHUB_PLAN_VERSION, mode: "rest" },
  "Metadata derives version from the one exported constant.");
equal(plan.desired, { resourceCount: 3, relationshipCount: 3 },
  "Normalization includes inline and explicit relationships.");
equal(plan.summary.blocked, 0, "New resource DAG is unblocked.");
equal(plan.summary.planned, 6, "Milestone and two issues plus three relationships.");
equal(plan.steps.map((s) => s.kind), [
  "milestone.create", "issue.create", "issue.create",
  "issue.dependency.add", "issue.parent.set", "issue.relates_to.add",
], "Operation DAG is topologically ordered and complete.");
for (const s of plan.steps) {
  for (const dep of s.dependsOn)
    check(plan.steps.findIndex((x) => x.id === dep) < plan.steps.indexOf(s),
      "Every dependency must precede consumer " + s.id);
}
check(calls.length === 5, "Empty repo discovery must use only five GET requests.");
check(plan.steps.every((s) => s.status === "planned" && !!s.request),
  "All pending operations must include actionable request specifications.");
check(!JSON.stringify(plan).includes("fixture-secret"), "No secret may leak into output.");

const again: string[] = [];
const repeated = await make("empty", again);
equal(plan, repeated, "Same desired and observed states produce byte-stable plans.");
equal(calls, again, "Read-only discovery calls are deterministic.");

const appliedCalls: string[] = [];
plan = await make("applied", appliedCalls);
equal(plan.readiness, "ready", "Already applied desired state should be ready.");
equal(plan.steps, [], "Applied desired state must contain no write steps.");
check(plan.summary.noops >= 5, "Applied plan should report existing resources and edges as noops.");
equal(plan.resolutions.map((x) => x.status), ["existing", "existing", "existing"],
  "Identities resolve from canonical markers or milestone title.");
check(appliedCalls.length === 11, "Applied state only enriches two relevant issues.");
check(plan.noops.every((s) => s.status === "noop"), "Noops are not executable.");

const badSchema = {
  repository: repo, issues: [
    { logicalId: "GOOD", title: "Good" },
    { logicalId: "BAD", title: "Bad", type: "NotKnown" },
  ],
};
plan = await make("invalid_type", [], badSchema);
equal(plan.readiness, "blocked", "Invalid issue type must block entire plan.");
check(plan.blockers.some((b) => b.code === "UNKNOWN_ISSUE_TYPE"),
  "Mixed blockers retain type validation.");
check(plan.summary.planned > 0, "Candidate operations may be included for review.");
check(plan.blockers.every((b) => b.blocking), "All blockers are strictly blocking.");

const malformed = await planGithub({
  schema: { repository: repo, issues: [{ logicalId: "X", title: { op: "invalid" } }] },
  auth: "fixture-secret",
  fetch: mock("empty", []),
});
equal(malformed.readiness, "blocked", "Bad normalized schema blocks before transport.");
check(malformed.blockers.some((b) => b.code === "INVALID_SCHEMA"),
  "Schema diagnostics retained.");

const noGraphCalls: string[] = [];
const noGraph = await planGithub({
  schema, auth: "fixture-secret", mode: "graphql", fetch: mock("empty", noGraphCalls),
});
equal(noGraph.readiness, "blocked", "GraphQL planning is unsupported.");
equal(noGraph.blockers[0]?.code, "NO_GRAPHQL_TRANSPORT", "Unsupported mode diagnostic.");
equal(noGraphCalls.length, 0, "GraphQL mode must not trigger REST discovery.");

for (const [status, expected] of [
  [401, "AUTH_FAILED"], [403, "INSUFFICIENT_PERMISSION"],
  [404, "REPOSITORY_NOT_FOUND"], [429, "RATE_LIMITED"],
] as const) {
  const failures: string[] = [];
  const errorPlan = await make("error", failures, schema, status);
  equal(errorPlan.readiness, "blocked", "Transport failure marks plan blocked.");
  equal(errorPlan.blockers[0]?.code, expected, "Mapped transport failure " + status);
  check(!JSON.stringify(errorPlan).includes("fixture-secret"), "Failure must not leak secret.");
}
const noSchemaCalls: string[] = [];
const permission = await planGithub({
  schema, auth: "fixture-secret", fetch: async (url, opts) => {
    noSchemaCalls.push(url);
    return response(403, {}, { "x-ratelimit-remaining": "0" });
  },
});
equal(permission.blockers[0]?.code, "RATE_LIMITED", "403 rate limit is distinct from permission error.");

check(!("octokit" in ({ schema, auth: "fixture-secret" } satisfies Parameters<typeof planGithub>[0])),
  "No SDK instance is required in planner config.");
console.log("End-to-end planGithub fixtures passed.");
