import {
  acquireGithubCasLock, createGithubCasHttpBackend, CasLockError,
  GITHUB_CAS_LOCK_REF, GITHUB_CAS_ZERO_OID,
} from "../src/github-cas-lock.ts";
import type { CasCommit, CasRef, CasRepository, GithubCasBackend } from
  "../src/github-cas-lock.ts";
import type { FetchLike, FetchResponseLike } from "../src/types.ts";

function assert(v: unknown, message: string): asserts v { if (!v) throw Error(message); }
function equal(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(message + " expected=" + JSON.stringify(b) + " actual=" + JSON.stringify(a));
}
async function rejects(name: string, fn: () => Promise<unknown>,
  code: CasLockError["code"], state?: CasLockError["lockState"]) {
  let thrown: unknown;
  try { await fn(); } catch (error) { thrown = error; }
  assert(thrown instanceof CasLockError, name + " must return a sanitized CasLockError");
  equal(thrown.code, code, name + " code");
  if (state) equal(thrown.lockState, state, name + " state");
  assert(!thrown.message.includes("topsecret") &&
    !JSON.stringify(thrown).includes("topsecret"),
    name + " may not leak token or arbitrary exception");
}
const fullName = "acme/widgets";
const repo: CasRepository = {
  fullName, id: 101, nodeId: "R_101", defaultBranch: "main",
};
const baseOid = "1".repeat(40), treeOid = "2".repeat(40);
const firstOid = "a".repeat(40), secondOid = "b".repeat(40),
  foreignOid = "f".repeat(40);
const uuid = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const parent: CasCommit = {
  oid: baseOid, treeOid, parentOids: [], message: "Initial commit",
};
const fixed = { repository: { fullName, id: 101, nodeId: "R_101" } };
class FakeBackend implements GithubCasBackend {
  state: string | null = null;
  ownerCommits = new Map<string, CasCommit>([[parent.oid, parent]]);
  lastCommit = 0;
  calls: string[] = [];
  writes: Array<{ before: string; after: string }> = [];
  unknownAcquire: "before" | "after" | null = null;
  unknownRelease: "before" | "after" | null = null;
  foreignRef = false;
  permissionDenied = false;
  mismatchedRepo = false;
  async repository(name: string) {
    this.calls.push("repo");
    if (this.permissionDenied) throw new CasLockError("PERMISSION_DENIED", "preflight", "not_acquired");
    return { ...repo, fullName: this.mismatchedRepo ? "attacker/other" : name };
  }
  async branch(name: string, branch: string): Promise<CasRef> {
    this.calls.push("branch");
    return { ref: "refs/heads/" + branch, oid: baseOid, type: "commit" };
  }
  async commit(name: string, oid: string) {
    this.calls.push("commit");
    const found = this.ownerCommits.get(oid);
    if (!found) throw Error("topsecret missing commit");
    return { ...found, parentOids: [...found.parentOids] };
  }
  async makeCommit(name: string, message: string, tree: string, parentOid: string) {
    this.calls.push("makeCommit");
    const oid = ++this.lastCommit === 1 ? firstOid : secondOid;
    const commit: CasCommit = {
      oid, treeOid: tree, parentOids: [parentOid], message,
    };
    this.ownerCommits.set(oid, { ...commit, parentOids: [...commit.parentOids] });
    return { ...commit, parentOids: [...commit.parentOids] };
  }
  async lockRef(name: string): Promise<CasRef | null> {
    this.calls.push("lockRef");
    return this.state ? {
      ref: this.foreignRef ? "refs/heads/gh-plan/locks/malicious" : GITHUB_CAS_LOCK_REF,
      oid: this.state, type: "commit",
    } : null;
  }
  async cas(repoId: string, beforeOid: string, afterOid: string): Promise<void> {
    this.calls.push("cas");
    assert(repoId === repo.nodeId, "CAS may only target verified repository node ID");
    assert(beforeOid !== afterOid, "CAS must change ref");
    this.writes.push({ before: beforeOid, after: afterOid });
    const isRelease = afterOid === GITHUB_CAS_ZERO_OID;
    const unknown = isRelease ? this.unknownRelease : this.unknownAcquire;
    if (unknown === "before") throw Error("topsecret simulated lost request");
    if ((this.state ?? GITHUB_CAS_ZERO_OID) !== beforeOid)
      throw Error("topsecret GitHub GraphQL CAS rejected");
    this.state = isRelease ? null : afterOid;
    if (unknown === "after") throw Error("topsecret GraphQL reply lost");
  }
}
const fresh = new FakeBackend();
const a = await acquireGithubCasLock({
  ...fixed, runId: "run-a", backend: fresh, nonceFactory: () => uuid(1),
});
equal(a.ownerOid, firstOid, "First acquire owns unique commit OID");
equal(fresh.state, firstOid, "GraphQL non-force zero-CAS created lock ref");
equal(fresh.writes, [{ before: GITHUB_CAS_ZERO_OID, after: firstOid }],
  "Acquire only uses absent-ref precondition");
const prepared = fresh.ownerCommits.get(firstOid)!;
assert(prepared.message.includes("run-id=run-a") &&
  prepared.message.includes("nonce=" + uuid(1)) &&
  prepared.message.includes("repository-id=101") &&
  prepared.message.includes("repository-node-id=R_101"),
  "Owner commit uniquely identifies expected repo and opaque owner");
equal(prepared.treeOid, treeOid, "Owner commit reuses default-tree verbatim");
equal(prepared.parentOids, [baseOid], "Owner commit derives from default head");
await a.assertOwned();
await rejects("B loses held lock", () => acquireGithubCasLock({
  ...fixed, runId: "run-b", backend: fresh, nonceFactory: () => uuid(2),
}), "LOCK_HELD", "not_acquired");
assert(fresh.lastCommit === 1, "Already held ref must not create second owner commit.");
await a.release();
equal(fresh.state, null, "Released ref removed by CAS zero OID");
equal(fresh.writes[1], { before: firstOid, after: GITHUB_CAS_ZERO_OID },
  "Release must use exact old owner as conditional before OID");
await rejects("old handle cannot release twice", () => a.release(), "LOCK_LOST", "released");
const b = await acquireGithubCasLock({
  ...fixed, runId: "run-b", backend: fresh, nonceFactory: () => uuid(2),
});
assert(b.ownerOid === secondOid && b.ownerOid !== a.ownerOid,
  "Subsequent owner gets distinct commit OID");
await rejects("old owner cannot regain ownership", () => a.assertOwned(), "LOCK_LOST");
await b.release();

const lost = new FakeBackend();
lost.unknownAcquire = "after";
const recovered = await acquireGithubCasLock({
  ...fixed, runId: "lost-reply", backend: lost, nonceFactory: () => uuid(1),
});
equal(lost.state, recovered.ownerOid, "Unknown acquire response must read back exact owner");
await recovered.assertOwned();
lost.unknownRelease = "before";
await rejects("lost release reply must not claim success", () => recovered.release(),
  "RELEASE_UNCERTAIN", "retained");
equal(lost.state, recovered.ownerOid, "Ref retained on rejected release");
lost.unknownRelease = "after";
await rejects("lost release reply after deletion remains uncertain", () => recovered.release(),
  "RELEASE_UNCERTAIN", "unknown");
equal(lost.state, null, "Unknown release may have deleted ref; do not retry.");

const absent = new FakeBackend();
absent.unknownAcquire = "before";
await rejects("lost acquire before mutation", () => acquireGithubCasLock({
  ...fixed, runId: "lost-before", backend: absent, nonceFactory: () => uuid(1),
}), "ACQUIRE_UNCERTAIN", "unknown");
equal(absent.state, null, "No second CAS retry after unknown acquisition.");

const held = new FakeBackend();
const first = await acquireGithubCasLock({
  ...fixed, runId: "initial", backend: held, nonceFactory: () => uuid(1),
});
held.state = foreignOid;
await rejects("foreign ref tamper", () => first.assertOwned(), "LOCK_LOST", "unknown");
await rejects("foreign ref must not be released", () => first.release(), "LOCK_LOST");
equal(held.state, foreignOid, "Cannot delete another owner's ref");
const tamper = new FakeBackend();
const owner = await acquireGithubCasLock({
  ...fixed, runId: "tamper", backend: tamper, nonceFactory: () => uuid(1),
});
tamper.foreignRef = true;
await rejects("wrong ref name not accepted", () => owner.assertOwned(), "LOCK_LOST");
tamper.foreignRef = false;
tamper.ownerCommits.get(owner.ownerOid)!.message = "altered owner marker";
await rejects("owner commit tamper detected", () => owner.assertOwned(), "INVALID_IDENTITY");

const permission = new FakeBackend(); permission.permissionDenied = true;
await rejects("permissions fail closed", () => acquireGithubCasLock({
  ...fixed, runId: "perm", backend: permission, nonceFactory: () => uuid(1),
}), "PERMISSION_DENIED", "not_acquired");
const mismatch = new FakeBackend(); mismatch.mismatchedRepo = true;
await rejects("redirected/wrong repository", () => acquireGithubCasLock({
  ...fixed, runId: "wrong", backend: mismatch, nonceFactory: () => uuid(1),
}), "REPOSITORY_MISMATCH");
await rejects("path injection blocked before any call", () => acquireGithubCasLock({
  repository: { fullName: "acme/widgets/evil" },
  runId: "invalid", backend: new FakeBackend(), nonceFactory: () => uuid(1),
}), "INVALID_TARGET");
const empty = new FakeBackend();
empty.repository = async () => ({ ...repo, defaultBranch: "" });
await rejects("empty/uninitialized repository", () => acquireGithubCasLock({
  ...fixed, runId: "empty", backend: empty, nonceFactory: () => uuid(1),
}), "EMPTY_REPOSITORY");
const invalidNonce = new FakeBackend();
await rejects("short or reused nonce forbidden", () => acquireGithubCasLock({
  ...fixed, runId: "invalid-nonce", backend: invalidNonce, nonceFactory: () => "weak",
}), "INVALID_IDENTITY");
equal(invalidNonce.lastCommit, 0, "Bad nonce cannot create owner commit");

const abort = new AbortController();abort.abort();
const canceled = new FakeBackend();
await rejects("cancelled preflight zero writes", () => acquireGithubCasLock({
  ...fixed, runId: "aborted", backend: canceled,
  nonceFactory: () => uuid(1), signal: abort.signal,
}), "ABORTED", "not_acquired");
equal(canceled.calls, [], "Cancel before acquire does no backend I/O");
const abortedDuring = new FakeBackend();
const controller = new AbortController();
const active = await acquireGithubCasLock({
  ...fixed, runId: "cancel-during", backend: abortedDuring,
  nonceFactory: () => uuid(1), signal: controller.signal,
});
controller.abort();
await rejects("cancellation prohibits new mutation", () =>
  active.guardResourceMutation(async () => "not-called"), "ABORTED");
await rejects("cancellation preserves ref for manual investigation", () =>
  active.release(), "ABORTED");
assert(abortedDuring.state === active.ownerOid, "Canceled process must not steal or discard lock");

const serial = new FakeBackend();
const h = await acquireGithubCasLock({
  ...fixed, runId: "serial", backend: serial, nonceFactory: () => uuid(1),
});
let started!: () => void, finish!: () => void;
const entered = new Promise<void>((resolve) => { started = resolve; });
const ending = new Promise<void>((resolve) => { finish = resolve; });
let maxInFlight = 0, inFlight = 0;
const firstTask = h.guardResourceMutation(async () => {
  maxInFlight = Math.max(maxInFlight, ++inFlight);
  started();
  await ending;
  inFlight--;
  return 42;
});
await entered;
await rejects("same owner cannot issue concurrent writes", () =>
  h.guardResourceMutation(async () => { maxInFlight++; }), "MUTATION_IN_FLIGHT");
await rejects("cannot release while request in flight", () => h.release(), "RELEASE_FORBIDDEN");
finish();
equal(await firstTask, 42, "Guarded verified work returned to caller");
equal(maxInFlight, 1, "Only one owner resource mutation in flight");
const beforeGuardCalls = serial.calls.length;
equal(await h.guardResourceMutation(async () => "second"), "second",
  "Second mutation allowed only after fresh owner recheck");
assert(serial.calls.length >= beforeGuardCalls + 2,
  "Every guarded mutation must reread both exact ref and owner commit");
await h.release();

const ambiguous = new FakeBackend();
const g = await acquireGithubCasLock({
  ...fixed, runId: "unknown-post", backend: ambiguous, nonceFactory: () => uuid(1),
});
await rejects("possible remote write with lost response remains unknown", () =>
  g.guardResourceMutation(async () => { throw Error("topsecret lost POST"); }),
  "MUTATION_UNCERTAIN", "retained");
await rejects("cannot dispatch after unknown resource mutation", () =>
  g.guardResourceMutation(async () => true), "MUTATION_UNCERTAIN");
await rejects("cannot release with unknown write still possible", () =>
  g.release(), "RELEASE_FORBIDDEN", "retained");
assert(ambiguous.state === g.ownerOid, "Unknown write must retain ownership for #176");

const concurrent = new FakeBackend();
const [contenderA, contenderB] = await Promise.allSettled([
  acquireGithubCasLock({ ...fixed, runId: "raceA", backend: concurrent,
    nonceFactory: () => uuid(1) }),
  acquireGithubCasLock({ ...fixed, runId: "raceB", backend: concurrent,
    nonceFactory: () => uuid(2) }),
]);
const settled = [contenderA, contenderB];
equal(settled.filter((p) => p.status === "fulfilled").length, 1,
  "Two concurrent zero-CAS contenders must produce exactly one owner");
const winner = settled.find((p) => p.status === "fulfilled");
assert(winner?.status === "fulfilled", "Exactly one winner");
await winner.value.assertOwned();
await winner.value.release();

class Headers {
  readonly headers: Record<string, string>;
  constructor(headers: Record<string, string> = {}) { this.headers = headers; }
  get(name: string): string | null { return this.headers[name.toLowerCase()] ?? null; }
}
function response(status: number, body: unknown, url?: string): FetchResponseLike {
  return {
    status, ok: status >= 200 && status < 300,
    statusText: "Secret topsecret",
    ...(url ? { url } : {}),
    headers: new Headers(),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}
const requests: Array<{ url: string; method: string; body?: unknown }> = [];
let graphqlError = false;
const fetch: FetchLike = async (url, init) => {
  requests.push({ url, method: init?.method ?? "",
    ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) });
  assert(init?.redirect === "error", "CAS never follows redirects with credentials");
  assert(init?.headers?.Authorization === "Bearer topsecret", "Auth only in request headers");
  assert(init?.headers?.["X-GitHub-Api-Version"] === "2026-03-10", "Pinned REST version");
  if (url.endsWith("/graphql")) return response(200, graphqlError
    ? { errors: [{ message: "topsecret ambiguous CAS" }] }
    : { data: { updateRefs: { clientMutationId: null } } });
  if (url.endsWith("/git/ref/heads/gh-plan/locks/repository"))
    return response(404, { message: "not found" });
  if (url.endsWith("/repos/acme/widgets")) return response(200, {
    id: repo.id, node_id: repo.nodeId, full_name: repo.fullName,
    default_branch: repo.defaultBranch,
  });
  if (url.endsWith("/git/ref/heads/main")) return response(200, {
    ref: "refs/heads/main", object: { sha: baseOid, type: "commit" },
  });
  if (url.endsWith("/git/commits/" + baseOid)) return response(200, {
    sha: parent.oid, tree: { sha: treeOid }, parents: [], message: parent.message,
  });
  if (url.endsWith("/git/commits") && init?.method === "POST") {
    const input = JSON.parse(init.body ?? "{}");
    return response(201, {
      sha: firstOid, tree: { sha: treeOid }, parents: [{ sha: baseOid }],
      message: input.message,
    });
  }
  if (url.endsWith("/git/commits/" + firstOid)) {
    const msg = requests.find((x) =>
      x.method === "POST" && x.url.endsWith("/git/commits"))?.body as { message?: string };
    return response(200, {
      sha: firstOid, tree: { sha: treeOid }, parents: [{ sha: baseOid }],
      message: msg.message,
    });
  }
  throw Error("topsecret unexpected endpoint " + url);
};
const backend = createGithubCasHttpBackend({ auth: "topsecret", fetch });
equal((await backend.repository(fullName)).id, 101, "HTTP repo parsed");
equal((await backend.branch(fullName, "main")).oid, baseOid, "Exact branch ref parsed");
equal((await backend.commit(fullName, baseOid)).treeOid, treeOid, "Tree inspected");
equal(await backend.lockRef(fullName), null, "404 exact lock ref means absent under accessible repo");
const built = await backend.makeCommit(fullName, "gh-plan-cas/v1\nrun-id=fixture", treeOid, baseOid);
equal(built.oid, firstOid, "Create off-ref commit, don't change branches");
await backend.cas(repo.nodeId, GITHUB_CAS_ZERO_OID, firstOid);
const casRequest = requests.find((x) => x.url.endsWith("/graphql"))!;
const operation = casRequest.body as { query: string; variables: {
  input: { repositoryId: string; refUpdates: Array<{
    name: string; beforeOid: string; afterOid: string; force: boolean;
  }> } } };
equal(operation.variables.input, {
  repositoryId: repo.nodeId,
  refUpdates: [{
    name: GITHUB_CAS_LOCK_REF, beforeOid: GITHUB_CAS_ZERO_OID,
    afterOid: firstOid, force: false,
  }],
}, "Real adapter enforces exact ref, zero-CAS and force:false");
await backend.cas(repo.nodeId, firstOid, GITHUB_CAS_ZERO_OID);
assert(requests.every((q) => q.method !== "DELETE" && new URL(q.url).origin === "https://api.github.com"),
  "No REST DELETE, external host or unknown method.");
graphqlError = true;
await rejects("GraphQL HTTP 200 errors are not success", () =>
  backend.cas(repo.nodeId, GITHUB_CAS_ZERO_OID, firstOid),
  "TRANSPORT_FAILED");
const deniedFetch: FetchLike = async () => response(403, { message: "topsecret" });
await rejects("backend token scope denied", () =>
  createGithubCasHttpBackend({ auth: "topsecret", fetch: deniedFetch }).repository(fullName),
  "PERMISSION_DENIED");
const badRepoFetch: FetchLike = async () => response(200, {
  ...repo, full_name: "other/repo", node_id: repo.nodeId, default_branch: "main",
});
await rejects("HTTP wrong target identity", () =>
  createGithubCasHttpBackend({ auth: "topsecret", fetch: badRepoFetch }).repository(fullName),
  "REPOSITORY_MISMATCH");

console.log("A1 CAS lock: cooperative contention, owner rechecks, safe unknown outcomes, forbidden release, and exact GitHub API contract passed.");
