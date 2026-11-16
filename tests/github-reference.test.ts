import { createGithubReferenceApplyOptions } from "../src/github-reference-adapter.ts";
import {
  createGithubReferenceHttp, GithubReferenceError,
} from "../src/github-reference-http.ts";
import { executeCallbackApplyPlan } from "../src/apply-lifecycle.ts";
import { ApplyPlanError } from "../src/index.ts";
import type { ApplyIntentManifest } from "../src/apply-preflight.ts";
import type {
  FetchLike, FetchRequestInitLike, FetchResponseLike,
  GithubPlan, PlanStep, PlanRequest, SafeApplyLogEntry,
} from "../src/index.ts";
function assert(x: unknown, why: string): asserts x { if (!x) throw Error(why); }
function equal(a: unknown, b: unknown, why: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(why + " expected=" + JSON.stringify(b) + " actual=" + JSON.stringify(a));
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



const SECRET = "DO_NOT_LOG_SIMULATED_PRIVATE_APP_TOKEN";
const BASE = "https://api.github.com";
const ROOT = BASE + "/repos/a/b";
const BASE_OID = "1".repeat(40);
const TREE = "2".repeat(40);
const ZERO = "0".repeat(40);
const REPO_NODE = "R_fixture_101";
type Row = Record<string, unknown>;
function response(url: string, data: unknown, status=200,
  headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300, status, url,
    statusText: status < 400 ? "ok" : "DO_NOT_LOG_UNSAFE_ERROR_TEXT",
    headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
    async json() { return structuredClone(data); },
    async text() { return JSON.stringify(data); },
  };
}
function issue(id: string, number: number, other: Row = {}): Row {
  return {
    number, id: number * 100, node_id: "I_" + (number * 100),
    title: id === "I2" ? "Existing" : "Ship", body: token(id),
    state: "open", milestone: { number: 2 }, ...other,
  };
}
function milestone(id: string, number: number, other: Row = {}): Row {
  return {
    number, id: number * 100, node_id: "M_" + (number * 100),
    title: id === "M" ? "Release" : "Old",
    description: id === "M" ? "" : "Previous description",
    state: "open", due_on: id === "M" ? "2027-01-03T00:00:00Z" :
      "2027-02-04T00:00:00Z",
    ...other,
  };
}
class FakeGithub {
  now = 100000;
  sleeps: number[] = [];
  calls: Array<{ url: string; method: string; when: number; body?: unknown }> = [];
  commits: Record<string, Row> = {
    [BASE_OID]: {
      sha: BASE_OID, tree: { sha: TREE }, message: "Initial default branch",
      parents: [],
    },
  };
  ownerOid: string | null = null;
  commitIndex = 0;
  issues: Row[] = [
    issue("I2", 15, { state: "open", milestone: { number: 2 }, title: "Existing" }),
    { ...issue("I", 13), pull_request: { url: "https://example.com/13" } },
  ];
  milestones: Row[] = [milestone("M2", 2)];
  push = true;
  deniedRepo = false;
  absentHidden = false;
  wrongRepo = false;
  driftDueDate = false;
  unknownWrite?: string;
  rateLimit?: (url: string, method: string, count: number) =>
    { status: number; headers: Record<string,string> } | undefined;
  failAudit?: (entry: SafeApplyLogEntry) => boolean;
  auditable: SafeApplyLogEntry[] = [];
  callsCount = new Map<string,number>();
  fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    assert(url.startsWith(BASE), "No external host requests.");
    assert(init?.redirect === "error", "No redirect following.");
    assert(init?.headers?.Authorization === "Bearer " + SECRET, "Token stays in runtime headers.");
    assert(init?.headers?.["X-GitHub-Api-Version"] === "2026-03-10", "Pinned API version.");
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    this.calls.push({ url, method, when: this.now, ...(body ? {body} : {}) });
    const key = method + " " + url;
    const count = (this.callsCount.get(key) ?? 0) + 1;
    this.callsCount.set(key, count);
    const throttled = this.rateLimit?.(url, method, count);
    if (throttled) return response(url, { message: SECRET }, throttled.status, throttled.headers);
    if (url === ROOT && method === "GET") {
      if (this.deniedRepo) return response(url, { message: SECRET }, 403);
      if (this.absentHidden) return response(url, { message: SECRET }, 404);
      return response(url, {
        full_name: this.wrongRepo ? "someone/else" : "a/b",
        id: 101, node_id: REPO_NODE, default_branch: "main",
        permissions: { push: this.push, pull: true },
      });
    }
    if (url === ROOT + "/git/ref/heads/main" && method === "GET")
      return response(url, { ref: "refs/heads/main",
        object: { type: "commit", sha: BASE_OID } });
    if (url === ROOT + "/git/ref/heads/gh-plan/locks/repository" && method === "GET")
      return this.ownerOid ? response(url, {
        ref: "refs/heads/gh-plan/locks/repository",
        object: { type: "commit", sha: this.ownerOid },
      }) : response(url, { message: "not found" }, 404);
    const commitPrefix = ROOT + "/git/commits/";
    if (url.startsWith(commitPrefix) && method === "GET") {
      const current = this.commits[url.slice(commitPrefix.length)];
      return current ? response(url, current) :
        response(url, { message: "not found" }, 404);
    }
    if (url === ROOT + "/git/commits" && method === "POST" && body) {
      this.commitIndex++;
      const oid = "a".repeat(39) + this.commitIndex.toString(16);
      const commit = { sha: oid, tree: { sha: body.tree }, message: body.message,
        parents: [{ sha: (body.parents as string[])[0] }] };
      this.commits[oid] = commit;
      return response(url, commit, 201);
    }
    if (url === BASE + "/graphql" && method === "POST" && body) {
      const input = (body.variables as { input: { refUpdates: Array<
        {beforeOid:string;afterOid:string;force:boolean}> } }).input;
      const update = input.refUpdates[0]!;
      const before = update.beforeOid === ZERO ? null : update.beforeOid;
      if (before !== this.ownerOid) return response(url, {
        errors: [{ message: "DO_NOT_LOG CAS refused" }], data: null,
      });
      this.ownerOid = update.afterOid === ZERO ? null : update.afterOid;
      return response(url, { data: { updateRefs: { clientMutationId: null } } }, 200);
    }
    const isList = method === "GET" && (
      url === ROOT + "/issues?state=all&per_page=100" ||
      url === ROOT + "/milestones?state=all&per_page=100");
    if (isList) return response(url, url.includes("/issues?") ?
      this.issues : this.milestones);
    const issuePrefix = ROOT + "/issues/", milestonePrefix = ROOT + "/milestones/";
    if (url.startsWith(issuePrefix) && method === "GET") {
      const row = this.issues.find((i) =>
        i.number === Number(url.slice(issuePrefix.length)));
      return row ? response(url, row) : response(url, { message: "hidden" }, 404);
    }
    if (url.startsWith(milestonePrefix) && method === "GET") {
      const row = this.milestones.find((m) =>
        m.number === Number(url.slice(milestonePrefix.length)));
      return row ? response(url, row) : response(url, { message: "hidden" }, 404);
    }
    if (this.unknownWrite && method !== "GET" &&
        url.includes(this.unknownWrite)) {
      // Model transport loss even when a write may have remotely committed.
      throw Error("DO_NOT_LOG network disconnected after write");
    }
    if (url === ROOT + "/milestones" && method === "POST" && body) {
      const row = milestone("M", 17, {
        title: body.title, description: body.description ?? "",
        due_on: this.driftDueDate ? "2027-01-02T00:00:00Z" :
          body.due_on ?? null,
      });
      this.milestones.push(row);
      return response(url, row, 201);
    }
    if (url === ROOT + "/issues" && method === "POST" && body) {
      const row = issue("I", 37, {
        title: body.title, body: body.body, milestone:
          body.milestone ? { number: body.milestone } : null,
      });
      this.issues.push(row);
      return response(url, row, 201);
    }
    if (url.startsWith(issuePrefix) && method === "PATCH" && body) {
      const row = this.issues.find((i) =>
        i.number === Number(url.slice(issuePrefix.length)));
      if (!row) return response(url, {message:"missing"},404);
      Object.assign(row, body);
      if (Object.hasOwn(body, "milestone"))
        row.milestone = body.milestone ? {number:body.milestone} : null;
      return response(url, row, 200);
    }
    if (url.startsWith(milestonePrefix) && method === "PATCH" && body) {
      const row = this.milestones.find((m) =>
        m.number === Number(url.slice(milestonePrefix.length)));
      if (!row) return response(url,{message:"missing"},404);
      Object.assign(row, body);
      return response(url,row,200);
    }
    throw Error("DO_NOT_LOG unexpected mock route " + method + " " + url);
  };
  sleep = async (ms:number) => {
    assert(ms >= 0 && ms <= 30000, "Bounded delay.");
    this.sleeps.push(ms);
    this.now += ms;
  };
  options(plan: GithubPlan = good) {
    return createGithubReferenceApplyOptions({
      plan: structuredClone(plan), auth: SECRET, fetch: this.fetch,
      now: () => this.now, sleep: this.sleep,
      onLog: async (entry) => {
        if (this.failAudit?.(entry)) throw Error("DO_NOT_LOG audit not durable");
        this.auditable.push({ ...entry });
      },
    });
  }
  mutations() { return this.calls.filter((x) => x.method !== "GET"); }
  resourceWrites() { return this.calls.filter((x) => x.method !== "GET" &&
    (x.url.includes("/issues") || x.url.includes("/milestones"))); }
}
async function denied(name: string, fn: () => Promise<unknown>,
  code?: GithubReferenceError["code"] | ApplyPlanError["code"]): Promise<Error> {
  let caught: unknown;
  try { await fn(); } catch (error) { caught = error; }
  assert(caught instanceof GithubReferenceError || caught instanceof ApplyPlanError,
    name + ": safe typed error expected.");
  if (code) equal(caught.code, code, name + ": code");
  assert(!JSON.stringify(caught).includes(SECRET) &&
    !caught.message.includes(SECRET) &&
    !caught.message.includes("https://"),
    name + ": secrets and unsafe error details not exposed");
  return caught;
}
const live = new FakeGithub();
const ready = live.options();
assert(!("auth" in ready), "Auth cannot be part of public C2 options.");
const success = await executeCallbackApplyPlan(ready);
equal(success.status, "applied", "Four B1 kinds execute through real A1/B1 interfaces.");
equal(success.completedStepIds.length, 5, "Five bound steps verified.");
equal(live.resourceWrites().length, 5, "No duplicate POST/PATCH in first run.");
equal(live.ownerOid, null, "Matching-owner CAS releases after confirmed reads.");
equal(success.bindings.M?.number, 17, "Milestone number only from verified postcondition.");
equal(success.bindings.I?.number, 37, "Issue number only from verified postcondition.");
equal(live.issues.find((i) => i.number === 37)?.state, "closed",
  "Issue-create followed by issue-close succeeded.");
const mutations = live.mutations();
assert(mutations.length === 8, "CAS create, acquire, five resource writes, release.");
for (let i=1; i<mutations.length; i++) {
  assert(mutations[i]!.when - mutations[i-1]!.when >= 1000,
    "All REST/GraphQL mutations require >=1s spacing, including A1 CAS.");
}
equal(live.auditable.length, success.log.length,
  "Every returned audit record was acknowledged by caller sink.");
const mutationTotal = live.resourceWrites().length;
const replay = await executeCallbackApplyPlan(live.options());
equal(replay.status, "already_satisfied", "Create→close full rerun is zero-write.");
equal(live.resourceWrites().length, mutationTotal,
  "Fresh rerun must not POST/PATCH existing uniquely verified identities.");
equal(replay.skippedStepIds.length, 5, "All replay steps verified skipped.");
equal(replay.bindings.I?.number, 37, "Closed create marker retains identity.");
equal(live.ownerOid, null, "Replay releases its independently acquired CAS owner.");

const immutable = new FakeGithub();
const externalPlan = structuredClone(good);
const inputConfig = {
  plan: externalPlan, auth: SECRET, fetch: immutable.fetch,
  now: () => immutable.now, sleep: immutable.sleep,
  onLog: async (entry: SafeApplyLogEntry) => {
    immutable.auditable.push({ ...entry });
  },
};
const pinned = createGithubReferenceApplyOptions(inputConfig);
assert(Object.isFrozen(pinned.plan) &&
  Object.isFrozen(pinned.plan.repository) &&
  Object.isFrozen(pinned.plan.steps) &&
  Object.isFrozen(pinned.plan.steps[0]),
  "Reference adapter must deep-freeze its captured plan.");
externalPlan.repository.fullName = "different/repository";
externalPlan.steps[0]!.kind = "label.create";
inputConfig.auth = "DO_NOT_LOG_CHANGED_TOKEN";
const isolated = await executeCallbackApplyPlan(pinned);
equal(isolated.status,"applied",
  "Changes to caller config/plan after construction cannot redirect GitHub writes.");
equal(immutable.resourceWrites().length,5,
  "Original validated B1 plan remains operative despite external mutation.");
assert(immutable.calls.every((call) => call.url.startsWith(BASE)),
  "No caller mutation can change canonical target.");

const malicious = new FakeGithub();
const options = malicious.options();
await denied("dispatch directly before owner/pre-read", () =>
  options.dispatch({protocol:"rest",method:"POST",
    path:"/repos/a/b/issues",body:{title:"bad"}},
    malicious.options().plan.steps[1]!), "UNSAFE_REQUEST");
equal(malicious.resourceWrites().length,0,"Direct dispatch cannot bypass owner.");

const otherRepo = new FakeGithub();
const foreign = otherRepo.options();
await denied("arbitrary host is never allowed", () =>
  createGithubReferenceHttp({ repository: {fullName:"a/b"}, auth:SECRET,
    fetch: otherRepo.fetch }).fetch("https://evil.example/issue", {
      method:"GET", redirect:"error",
      headers:{Authorization:"Bearer "+SECRET,
        Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10"},
    }), "UNSAFE_REQUEST");
equal(otherRepo.calls.length, 0, "Cross-origin unsafe request never reaches transport.");
await denied("no anonymous REST paths", () =>
  createGithubReferenceHttp({ repository: {fullName:"a/b"}, auth:SECRET,
    fetch: otherRepo.fetch }).fetch(BASE+"/repos/a/b/issues/15/comments", {
      method:"GET", redirect:"error",
      headers:{Authorization:"Bearer "+SECRET,
        Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10"},
    }), "UNSAFE_REQUEST");
equal(otherRepo.calls.length, 0, "Non-B1 path cannot reach network.");

const noPush = new FakeGithub();
noPush.push=false;
await denied("milestone-on-issue-create requires push access", () =>
  executeCallbackApplyPlan(noPush.options()), "OWNER_UNCERTAIN");
equal(noPush.mutations().length, 0, "Push-access rejection precedes A1 owner writes.");

const wrong = new FakeGithub();
wrong.wrongRepo=true;
await denied("canonical repository identity mismatch", () =>
  executeCallbackApplyPlan(wrong.options()), "OWNER_UNCERTAIN");
equal(wrong.mutations().length,0,"Wrong repo refuses before CAS.");

const hidden = new FakeGithub();
hidden.absentHidden=true;
await denied("private repository 404 cannot mean empty", () =>
  executeCallbackApplyPlan(hidden.options()), "OWNER_UNCERTAIN");
equal(hidden.mutations().length,0,"Hidden private repo cannot cause writes.");

const dueDrift = new FakeGithub();
dueDrift.driftDueDate = true;
const rejectedDue = await denied("GitHub milestone due_on one-day drift is not verified",
  () => executeCallbackApplyPlan(dueDrift.options()), "VERIFICATION_FAILED");
assert(rejectedDue instanceof ApplyPlanError && rejectedDue.ownerState === "retained",
  "Mismatched UTC due date fails closed with owner held for review.");
equal(dueDrift.resourceWrites().length, 1,
  "No downstream issue is created after due-date drift.");
assert(dueDrift.ownerOid !== null,
  "Failed due-date verification prohibits CAS release and retries.");

const uncertain = new FakeGithub();
uncertain.unknownWrite="/milestones";
const error = await denied("lost POST response must never retry", () =>
  executeCallbackApplyPlan(uncertain.options()), "INDETERMINATE_WRITE");
assert(error instanceof ApplyPlanError && error.ownerState==="retained",
  "Unknown write retains A1 owner for manual recovery.");
equal(uncertain.resourceWrites().length,1,"Ambiguous POST sent once.");
assert(uncertain.ownerOid !== null, "No automatic CAS release/steal after unknown POST.");

const auditDown = new FakeGithub();
auditDown.failAudit=(entry)=>entry.outcome==="started" && entry.phase==="dispatch";
await denied("failed audit-before-dispatch stops all writes", () =>
  executeCallbackApplyPlan(auditDown.options()), "AUDIT_FAILED");
equal(auditDown.resourceWrites().length,0,"No write without durable audit.");

const origPlan = structuredClone(good);
origPlan.repository={fullName:"another/repo"};
const badPlan = new FakeGithub();
await denied("preflight cross-repo rejected without any callbacks", async () => {
  badPlan.options(origPlan);
}, "INVALID_CONFIG");
equal(badPlan.calls.length,0,"No HTTP before whole-plan B1 preflight.");

const retry = new FakeGithub();
retry.rateLimit=(url,method,count)=>
  url===ROOT && method==="GET" && count===1
    ? {status:403, headers:{"retry-after":"2"}}:undefined;
const retryHttp=createGithubReferenceHttp({repository:{fullName:"a/b"},
  auth:SECRET,fetch:retry.fetch,now:()=>retry.now,sleep:retry.sleep});
await retryHttp.assertRepository(false);
equal(retry.sleeps,[2000],"GET retry honors explicit Retry-After once.");
equal(retry.callsCount.get("GET "+ROOT),2,"Only bounded GET retry allowed.");

const denial=new FakeGithub();
denial.rateLimit=(url,method)=>url===ROOT && method==="GET"
  ? {status:403,headers:{}}:undefined;
await denied("ordinary permission 403 never retried", () =>
  createGithubReferenceHttp({repository:{fullName:"a/b"},auth:SECRET,
    fetch:denial.fetch}).assertRepository(false),"PERMISSION_DENIED");
equal(denial.callsCount.get("GET "+ROOT),1,"Permission 403 never retried.");

const reset=new FakeGithub();
reset.rateLimit=(url,method,count)=>url===ROOT && method==="GET" && count===1
  ? {status:429,headers:{"x-ratelimit-remaining":"0",
    "x-ratelimit-reset":String(Math.ceil((reset.now+3000)/1000))}}:undefined;
const resetHttp=createGithubReferenceHttp({repository:{fullName:"a/b"},auth:SECRET,
  fetch:reset.fetch,now:()=>reset.now,sleep:reset.sleep});
await resetHttp.assertRepository(false);
assert(reset.sleeps.some((ms)=>ms>=3000),
  "Primary reset epoch respected before bounded GET retry.");
const overLimit=new FakeGithub();
overLimit.rateLimit=(url,method)=>url===ROOT && method==="GET"
  ? {status:429,headers:{"retry-after":"90"}}:undefined;
await denied("over-budget retry fails closed", () =>
  createGithubReferenceHttp({repository:{fullName:"a/b"},auth:SECRET,
    fetch:overLimit.fetch}).assertRepository(false),"RATE_LIMITED");
equal(overLimit.callsCount.get("GET "+ROOT),1,"No retry after >30-second wait.");
const noHeader=new FakeGithub();
noHeader.rateLimit=(url,method)=>url===ROOT && method==="GET"
  ? {status:429,headers:{}}:undefined;
await denied("secondary-limit without bounded headers refuses", () =>
  createGithubReferenceHttp({repository:{fullName:"a/b"},auth:SECRET,
    fetch:noHeader.fetch}).assertRepository(false),"RATE_LIMITED");

const pagination = new FakeGithub();
pagination.fetch=async (url,init) => {
  if (url===ROOT+"/issues?state=all&per_page=100")
    return response(url,[issue("I2",15)],200,{
      link:'<'+ROOT+'/issues?state=all&per_page=100&page=2>; rel="next"',
    });
  if (url===ROOT+"/issues?state=all&per_page=100&page=2")
    return response(url,[issue("I",37,{milestone:null})]);
  throw Error("DO_NOT_LOG unexpected pagination route");
};
const full=createGithubReferenceHttp({repository:{fullName:"a/b"},auth:SECRET,
  fetch:pagination.fetch});
equal((await full.issuesCatalog()).map((i)=>i.number),[15,37],
  "All open/closed issues pages are fully traversed.");
const badPage=new FakeGithub();
badPage.fetch=async(url,init)=>response(url,[issue("I2",15)],200,{
  link:'<https://evil.example/steal>; rel="next"',
});
await denied("cross-origin Link next fails closed",() =>
  createGithubReferenceHttp({repository:{fullName:"a/b"},auth:SECRET,
    fetch:badPage.fetch}).issuesCatalog(),"UNSAFE_REQUEST");


const competing = new FakeGithub();
const firstOwner = competing.options();
const acquired = await firstOwner.ownership.acquire("a/b");
const contender = await denied("two reference owners cannot acquire the same A1 ref",
  () => executeCallbackApplyPlan(competing.options()),"OWNER_UNCERTAIN");
assert(contender instanceof ApplyPlanError && contender.ownerState === "unknown",
  "Concurrent losing owner cannot claim any resource success.");
equal(competing.resourceWrites().length,0,
  "Competing runner never writes an issue or milestone.");
assert(competing.ownerOid !== null,
  "Failed contender may not release or steal another owner's CAS.");
await firstOwner.ownership.release("a/b",acquired.ownerId);
equal(competing.ownerOid,null,"Original verified owner releases its own lock.");

const failedWrite = new FakeGithub();
failedWrite.rateLimit=(url,method)=>url===ROOT+"/milestones" && method==="POST"
  ? {status:429,headers:{"retry-after":"3"}}:undefined;
const failedWriteTransport=createGithubReferenceHttp({
  repository:{fullName:"a/b"},auth:SECRET,fetch:failedWrite.fetch,
  now:()=>failedWrite.now,sleep:failedWrite.sleep,
});
await denied("a rate-limited mutation must never be blindly retried",
  ()=>failedWriteTransport.fetch(ROOT+"/milestones",{
    method:"POST",redirect:"error",headers:{
      Authorization:"Bearer "+SECRET,
      Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2026-03-10",
      "Content-Type":"application/json",
    },body:JSON.stringify({title:"Safe"}),
  }),"WRITE_UNCERTAIN");
equal(failedWrite.callsCount.get("POST "+ROOT+"/milestones"),1,
  "429 on POST causes one attempt, not a rate-limit retry.");

const invalidWrite = new FakeGithub();
const invalidTransport=createGithubReferenceHttp({
  repository:{fullName:"a/b"},auth:SECRET,fetch:invalidWrite.fetch,
});
await denied("unsupported issue mutation fields fail before network",()=>
  invalidTransport.fetch(ROOT+"/issues",{
    method:"POST",redirect:"error",
    headers:{Authorization:"Bearer "+SECRET,
      Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2026-03-10",
      "Content-Type":"application/json"},
    body:JSON.stringify({title:"Unsafe",body:token("I"),labels:["DO_NOT_LOG"]}),
  }),"UNSAFE_REQUEST");
await denied("arbitrary GraphQL mutations are never allowed",()=>
  invalidTransport.fetch(BASE+"/graphql",{
    method:"POST",redirect:"error",
    headers:{Authorization:"Bearer "+SECRET,
      Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2026-03-10",
      "Content-Type":"application/json"},
    body:JSON.stringify({query:"mutation { deleteIssue(input:{}){clientMutationId} }"}),
  }),"UNSAFE_REQUEST");
equal(invalidWrite.calls.length,0,"Unsupported mutations never reach GitHub.");

const nodeGuard = new FakeGithub();
const pinned = createGithubReferenceHttp({
  repository:{fullName:"a/b"},auth:SECRET,fetch:nodeGuard.fetch,
});
await pinned.assertRepository(false);
const beforeWrongNode = nodeGuard.calls.length;
await denied("GraphQL CAS cannot target another repository node ID",() =>
  pinned.fetch(BASE+"/graphql",{
    method:"POST",redirect:"error",
    headers:{Authorization:"Bearer "+SECRET,
      Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2026-03-10",
      "Content-Type":"application/json"},
    body:JSON.stringify({
      query:"mutation ApplyOwnerCas($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
      variables:{input:{
        repositoryId:"R_UNRELATED_PRIVATE_REPO",
        refUpdates:[{name:"refs/heads/gh-plan/locks/repository",
          beforeOid:ZERO,afterOid:"a".repeat(40),force:false}],
      }},
    }),
  }),"UNSAFE_REQUEST");
equal(nodeGuard.calls.length,beforeWrongNode,
  "Foreign GraphQL CAS must be stopped before sending any mutation.");


console.log("#189 reference GitHub transport: pinned/allowlisted A1+B1, serial pacing, private-repo guards, full catalog pagination and safe rerun passed.");
