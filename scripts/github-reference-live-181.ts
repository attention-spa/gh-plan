/**
 * #181 EXPLICIT OPT-IN LIVE acceptance, disposable private repository ONLY.
 * Never run from npm test/CI on the production repository.
 * Run manually in the temporary private repo's dedicated dispatch workflow.
 */
import { mkdir, open, writeFile } from "node:fs/promises";
import { createGithubReferenceApplyOptions } from "../src/github-reference-adapter.ts";
import { executeCallbackApplyPlan } from "../src/apply-lifecycle.ts";
import { ApplyPlanError } from "../src/apply-contract.ts";
import type { ApplyIntentManifest } from "../src/apply-preflight.ts";
import type {
  FetchLike, GithubPlan, PlanStep, PlanRequest,
} from "../src/types.ts";
import type { SafeApplyLogEntry } from "../src/apply-contract.ts";


async function main(): Promise<void> {
const TARGET = "agent-hachi/gh-plan-acceptance-181-20261117-b";
const BASE = "https://api.github.com";
const ROOT = BASE + "/repos/" + TARGET;
const MARK = (id: string) => "<!-- gh-plan:" + id + " -->";
const EXPECTED_APPROVAL = "private-disposable-181-only";
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("181 ACCEPTANCE: " + reason);
}
const auth = process.env.GH_PLAN_181_TOKEN;
if (process.env.GH_PLAN_181_APPROVED !== EXPECTED_APPROVAL ||
    process.env.GITHUB_REPOSITORY !== TARGET ||
    typeof auth !== "string" || auth.length < 15)
  throw new Error("Live #181 refused: exact disposable repository and explicit approval required.");
const durableDir = "evidence";
await mkdir(durableDir, { recursive: true });
const evidence: Record<string, unknown> = {
  issue: 181, target: TARGET, apiVersion: "2026-03-10",
  mode: "real GitHub token via private workflow, internal TypeScript adapter",
  phases: [],
};
const completed = evidence.phases as Array<Record<string, unknown>>;
async function checkpoint(name: string, details: Record<string, unknown>) {
  completed.push({ name, ...details });
  await writeFile(durableDir + "/live-181.json",
    JSON.stringify({ ...evidence, timestamp: new Date().toISOString() }, null, 2) + "\n");
}
const journal = durableDir + "/durable-audit-181.ndjson";
async function onLog(entry: Readonly<SafeApplyLogEntry>): Promise<void> {
  const fd = await open(journal, "a");
  try {
    await fd.writeFile(JSON.stringify(entry) + "\n");
    await fd.sync();
  } finally { await fd.close(); }
}
type NetworkCall = { method: string; path: string; at: number; status?: number };
const network: NetworkCall[] = [];
const originalFetch = globalThis.fetch;
const monitored: FetchLike = async (url, init) => {
  check(url.startsWith(ROOT) || url === BASE + "/graphql",
    "network attempt outside disposable repository");
  check(init?.redirect === "error", "HTTP redirect must be blocked");
  check(init.headers?.["X-GitHub-Api-Version"] === "2026-03-10",
    "wrong REST version in live adapter");
  check(init.headers?.Authorization === "Bearer " + auth,
    "reference transport token header inconsistent");
  const log: NetworkCall = {
    method: init.method ?? "GET",
    path: url.replace(ROOT, "/repos/THIS-DISPOSABLE"),
    at: Date.now(),
  };
  network.push(log);
  const response = await originalFetch(url, init);
  log.status = response.status;
  return response;
};
const rawHeaders = {
  Authorization: "Bearer " + auth,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "Content-Type": "application/json",
  "User-Agent": "gh-plan-acceptance-181",
};
async function get(path: string): Promise<Record<string, unknown>> {
  const res = await originalFetch(ROOT + path, {
    headers: rawHeaders, method: "GET", redirect: "error",
  });
  check(res.status === 200, "readback GET failed");
  const json: unknown = await res.json();
  check(json !== null && typeof json === "object" && !Array.isArray(json),
    "GitHub returned invalid JSON");
  return json as Record<string, unknown>;
}
function step(kind: PlanStep["kind"], id: string, request: PlanRequest,
  dependsOn: string[] = []): PlanStep {
  return {
    id: kind + ":" + id, logicalId: id, kind,
    status: "planned", dependsOn, current: null,
    desired: request.protocol === "rest" ? request.body as PlanStep["desired"] : null,
    reason: "live acceptance", preconditions: [], expectedPostconditions: [],
    destructive: false, reversible: "partial", request,
  };
}
const repo = await get("");
await checkpoint("authenticated_repo_read", {
  repositoryId: repo.id, repositoryNode: repo.node_id,
  private: repo.private,
  permissionsPresent: typeof repo.permissions === "object",
  push: typeof repo.permissions === "object" && repo.permissions !== null
    ? (repo.permissions as Record<string, unknown>).push : "missing",
});
check(repo.full_name === TARGET && repo.private === true &&
  typeof repo.id === "number" && typeof repo.node_id === "string",
  "wrong or non-private repository identity");
check(typeof repo.permissions === "object" && repo.permissions !== null,
  "missing token permission metadata");
// The real GITHUB_TOKEN has permissions.push=false yet the pinned endpoint
// successfully created an issue with milestone in an independent probe.
// Do not replace GitHub's actual server-side POST authorization with that
// role hint. The A1/B1 writer will fail closed on any denied write.
const preexistingIssue = await get("/issues/1");
check(preexistingIssue.body === "Existing issue\n" + MARK("I2") &&
  preexistingIssue.state === "open" && preexistingIssue.milestone !== null,
  "seed issue is missing or altered; refusing live plan");
const originalMilestone = await get("/milestones/1");
check(originalMilestone.title === "Pinned due day probe #181",
  "seed milestone absent/altered");
await checkpoint("preflight_repo", {
  repositoryId: repo.id, repositoryNode: repo.node_id,
  issuesPushRoleHint:
    (repo.permissions as Record<string,unknown>).push,
  serverPermissionVerifiedByIndependentPinnedProbe: true,
  issueNumber: preexistingIssue.number,
  oldMilestoneNumber: originalMilestone.number,
});
const mCreate = step("milestone.create", "M", {
  protocol: "rest", method: "POST", path: "/repos/" + TARGET + "/milestones",
  body: {
    title: "Verified live milestone #181", description: "",
    due_on: "2027-01-07T00:00:00Z",
  },
});
const mUpdate = step("milestone.update", "M2", {
  protocol: "rest", method: "PATCH", path: "/repos/" + TARGET + "/milestones/1",
  body: { description: "", due_on: null },
});
const iCreate = step("issue.create", "I", {
  protocol: "rest", method: "POST", path: "/repos/" + TARGET + "/issues",
  body: {
    title: "Verified live issue #181",
    body: "Created by approved B1 acceptance\n" + MARK("I"),
    milestone: { $ref: "M.number" },
  },
}, ["milestone.create:M"]);
const iUpdate = step("issue.update", "I2", {
  protocol: "rest", method: "PATCH", path: "/repos/" + TARGET + "/issues/1",
  body: { state: "closed", milestone: null },
});
const iClose = step("issue.update", "I", {
  protocol: "rest", method: "PATCH",
  path: ["/repos/" + TARGET + "/issues/", { $ref: "I.number" }],
  body: { state: "closed" },
}, ["issue.create:I"]);
const manifest: ApplyIntentManifest = {
  version: 1, repository: TARGET, resourceCount: 4, relationshipCount: 0,
  managed: [
    { logicalId:"I", kind:"issue",
      fields:["milestone","state","title"], removes:[], desiredState:"closed" },
    { logicalId:"I2", kind:"issue",
      fields:["milestone","state"], removes:["milestone"], desiredState:"closed" },
    { logicalId:"M", kind:"milestone",
      fields:["description","due_on","title"], removes:[] },
    { logicalId:"M2", kind:"milestone",
      fields:["description","due_on"], removes:["description","due_on"] },
  ],
  unsupported: [],
};
const plan: GithubPlan = {
  metadata:{ planner:"gh-plan", version:"0.1.0", mode:"rest" },
  repository:{fullName:TARGET,id:repo.id as number,nodeId:repo.node_id as string},
  desired:{resourceCount:4,relationshipCount:0},applyIntent:manifest,
  resolutions:[
    {logicalId:"M",kind:"milestone",status:"new"},
    {logicalId:"M2",kind:"milestone",status:"existing",identity:{number:1}},
    {logicalId:"I",kind:"issue",status:"new",identity:{marker:MARK("I")}},
    {logicalId:"I2",kind:"issue",status:"existing",
      identity:{number:1,id:preexistingIssue.id as number,
        nodeId:preexistingIssue.node_id as string,marker:MARK("I2")}},
  ],
  steps:[iClose,iCreate,mUpdate,mCreate,iUpdate], noops:[],
  warnings:[],blockers:[],unsupported:[],readiness:"ready",
  summary:{planned:5,noops:0,warnings:0,blocked:0,unsupported:0},
};
function liveOptions(input: GithubPlan = plan) {
  return createGithubReferenceApplyOptions({
    plan: structuredClone(input), auth, fetch: monitored, onLog,
  });
}
async function assertRefGone(): Promise<void> {
  const res = await originalFetch(ROOT + "/git/ref/heads/gh-plan/locks/repository",
    { method:"GET",headers:rawHeaders,redirect:"error" });
  check(res.status === 404, "A1 owner ref unexpectedly remains after success");
}
const result = await executeCallbackApplyPlan(liveOptions());
check(result.status === "applied" && result.completedStepIds.length === 5 &&
  result.bindings.M?.number !== undefined && result.bindings.I?.number !== undefined,
  "first live application did not verify all five steps");
const mNum = result.bindings.M.number as number;
const iNum = result.bindings.I.number as number;
const createdM = await get("/milestones/" + mNum);
const createdI = await get("/issues/" + iNum);
const updatedM = await get("/milestones/1");
const updatedI = await get("/issues/1");
check(createdM.title === "Verified live milestone #181" &&
  typeof createdM.due_on === "string" &&
  (createdM.due_on as string).startsWith("2027-01-07") &&
  createdI.state === "closed" &&
  typeof createdI.milestone === "object" &&
  (createdI.milestone as Record<string, unknown>).number === mNum &&
  updatedM.due_on === null && updatedI.state === "closed" &&
  updatedI.milestone === null,
  "one or more live B1 terminal states mismatched");
await assertRefGone();
const countResources = () => network.filter((item) =>
  item.method !== "GET" &&
  /\/(issues|milestones)(\/|$)/.test(item.path)).length;
check(countResources() === 5, "unexpected number of initial B1 resource writes");
const dueWire = network.find((item) =>
  item.method === "POST" && item.path.endsWith("/milestones"));
check(dueWire?.status === 201, "milestone creation not accepted");
await checkpoint("four_kinds_applied", {
  milestoneNumber:mNum, issueNumber:iNum,
  milestoneDue:createdM.due_on, createdIssueClosed:createdI.state,
  existingIssueClosed:updatedI.state, resourceMutations:countResources(),
  auditEvents:result.log.length, ownerReleased:true,
});
const beforeReplay = countResources();
const replay = await executeCallbackApplyPlan(liveOptions());
check(replay.status === "already_satisfied" &&
  replay.skippedStepIds.length === 5 &&
  result.bindings.M.number === replay.bindings.M?.number &&
  result.bindings.I.number === replay.bindings.I?.number &&
  countResources() === beforeReplay,
  "real GitHub zero-write rerun failed");
await assertRefGone();
await checkpoint("zero_write_replay", {
  verifiedSkips: replay.skippedStepIds.length,
  resourceMutations:countResources(), ownerReleased:true,
});
await checkpoint("complete_initial", {
  totalObservedHttpRequests:network.length,
  mutationMethods:network.filter(x=>x.method!=="GET")
    .map(x=>({method:x.method,path:x.path,status:x.status})),
});
console.log("LIVE #181 initial four-kind A1/B1/C2 apply and zero-resource-write rerun passed.");

}
try {
  await main();
} catch (error) {
  const row = error && typeof error === "object"
    ? error as { code?: unknown; phase?: unknown; ownerState?: unknown; name?: unknown;
        message?: unknown } : {};
  const safe = typeof row.message === "string" &&
    /^(181 ACCEPTANCE:|Live #181 refused:)/.test(row.message)
    ? row.message : undefined;
  const failure = {
    issue: 181, result: "failed",
    kind: typeof row.name === "string" ? row.name : "unknown",
    ...(typeof row.code === "string" ? { code: row.code } : {}),
    ...(typeof row.phase === "string" ? { phase: row.phase } : {}),
    ...(typeof row.ownerState === "string" ? { ownerState: row.ownerState } : {}),
    ...(safe ? { diagnostic: safe } : {}),
  };
  await mkdir("evidence", { recursive: true });
  await writeFile("evidence/live-181-error.json",
    JSON.stringify(failure, null, 2) + "\n");
  console.error("Live #181 stopped:", failure.kind,
    "code" in failure ? failure.code : "unknown");
  process.exitCode = 1;
}
