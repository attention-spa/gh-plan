import type { FetchLike, FetchResponseLike } from "./types.ts";
import { GITHUB_REST_API_VERSION } from "./rest.ts";

/**
 * Internal A1 owner protocol. This serializes *cooperating* GitHub writers.
 * It is not a fencing token for GitHub Issues, a lease, a recovery workflow,
 * or a public applyPlan export. See #164 (decision), #175 (implementation).
 */
export const GITHUB_CAS_LOCK_REF = "refs/heads/gh-plan/locks/repository";
export const GITHUB_CAS_ZERO_OID = "0000000000000000000000000000000000000000";

export type CasPhase =
  | "preflight" | "prepare" | "acquire" | "ownership" | "mutation" | "release";
export type CasLockState = "not_acquired" | "retained" | "released" | "unknown";
export type CasErrorCode =
  | "INVALID_TARGET" | "REPOSITORY_MISMATCH" | "EMPTY_REPOSITORY"
  | "INVALID_IDENTITY" | "AUTH_FAILED" | "PERMISSION_DENIED" | "RATE_LIMITED"
  | "INVALID_RESPONSE" | "TRANSPORT_FAILED" | "COMMIT_FAILED"
  | "LOCK_HELD" | "LOCK_LOST" | "ACQUIRE_UNCERTAIN"
  | "RELEASE_UNCERTAIN" | "RELEASE_FORBIDDEN"
  | "ABORTED" | "MUTATION_IN_FLIGHT" | "MUTATION_UNCERTAIN";

/** Never exposes token values, raw response bodies or arbitrary errors. */
export class CasLockError extends Error {
  readonly code: CasErrorCode;
  readonly phase: CasPhase;
  readonly lockState: CasLockState;
  constructor(code: CasErrorCode, phase: CasPhase, lockState: CasLockState) {
    super("GitHub CAS ownership failed (" + code + ").");
    this.name = "CasLockError";
    this.code = code;
    this.phase = phase;
    this.lockState = lockState;
  }
  toJSON(): { code: CasErrorCode; phase: CasPhase; lockState: CasLockState } {
    return { code: this.code, phase: this.phase, lockState: this.lockState };
  }
}
export interface CasRepository {
  fullName: string;
  id: number;
  nodeId: string;
  defaultBranch: string;
}
export interface CasRef {
  ref: string;
  oid: string;
  type: "commit";
}
export interface CasCommit {
  oid: string;
  treeOid: string;
  parentOids: string[];
  message: string;
}
/** Injection is internal/test-only. The real adapter below uses authenticated GitHub. */
export interface GithubCasBackend {
  repository(fullName: string): Promise<CasRepository>;
  branch(fullName: string, branch: string): Promise<CasRef>;
  commit(fullName: string, sha: string): Promise<CasCommit>;
  makeCommit(fullName: string, message: string, treeOid: string, parentOid: string):
    Promise<CasCommit>;
  lockRef(fullName: string): Promise<CasRef | null>;
  cas(repositoryNodeId: string, beforeOid: string, afterOid: string): Promise<void>;
}
export interface GithubCasLockOptions {
  /** Must come from the already-validated target plan, not a callback override. */
  repository: { fullName: string; id?: number; nodeId?: string };
  /** Opaque, nonsecret run identifier; never an authentication credential. */
  runId: string;
  backend: GithubCasBackend;
  signal?: AbortSignal;
  /**
   * Internal deterministic test hook ONLY. Production passes no nonceFactory
   * and uses cryptographically secure randomUUID() per acquisition.
   */
  nonceFactory?: () => string;
}
export interface GithubCasLockHandle {
  readonly ownerOid: string;
  readonly repository: string;
  readonly runId: string;
  readonly lockRef: typeof GITHUB_CAS_LOCK_REF;
  /** Fresh exact-ref and owner-commit validation before every resource write. */
  assertOwned(): Promise<void>;
  /**
   * Serializes a cooperating owner's resource mutations. Caller must perform
   * postcondition verification and audit within the callback before it resolves.
   * Throwing/aborting during a callback retains the ref for operator recovery.
   */
  guardResourceMutation<T>(mutation: () => Promise<T>): Promise<T>;
  /** Only the matching exact OID may be deleted by non-force GraphQL CAS. */
  release(): Promise<void>;
}

const OID = /^[0-9a-f]{40}$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE = "https://api.github.com";
function validOid(value: unknown): value is string {
  return typeof value === "string" && OID.test(value) &&
    value !== GITHUB_CAS_ZERO_OID;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function error(code: CasErrorCode, phase: CasPhase, lockState: CasLockState): never {
  throw new CasLockError(code, phase, lockState);
}
function withState(err: unknown, phase: CasPhase, state: CasLockState): never {
  if (err instanceof CasLockError) {
    throw new CasLockError(err.code, phase, state);
  }
  return error("TRANSPORT_FAILED", phase, state);
}
function sameCommit(a: CasCommit, b: CasCommit): boolean {
  return a.oid === b.oid && a.treeOid === b.treeOid &&
    a.message === b.message && a.parentOids.length === b.parentOids.length &&
    a.parentOids.every((oid, i) => oid === b.parentOids[i]);
}
function checkRef(value: CasRef | null, oid: string, phase: CasPhase,
  state: CasLockState): void {
  if (!value || value.ref !== GITHUB_CAS_LOCK_REF || value.type !== "commit" ||
    !validOid(value.oid) || value.oid !== oid)
    error("LOCK_LOST", phase, state);
}
function validateCommit(commit: CasCommit, expected: CasCommit, phase: CasPhase,
  state: CasLockState): void {
  if (!validOid(commit?.oid) || !validOid(commit?.treeOid) ||
      !Array.isArray(commit?.parentOids) || !sameCommit(commit, expected))
    error("INVALID_IDENTITY", phase, state);
}
/**
 * Creates an off-ref commit first. A success from GraphQL alone is insufficient:
 * acquisition requires fresh exact ref/commit readback to the same owner.
 *
 * A lost GraphQL response is never retried; readback can prove the one owner
 * was acquired but cannot authorize another CAS attempt.
 */
export async function acquireGithubCasLock(options: GithubCasLockOptions):
  Promise<GithubCasLockHandle> {
  const target = options?.repository;
  const fullName = target?.fullName;
  const signal = options?.signal;
  if (!object(target) || typeof fullName !== "string" || !REPOSITORY.test(fullName) ||
      !RUN_ID.test(options.runId) || !options.backend ||
      typeof options.backend.repository !== "function" ||
      typeof options.backend.branch !== "function" ||
      typeof options.backend.commit !== "function" ||
      typeof options.backend.makeCommit !== "function" ||
      typeof options.backend.lockRef !== "function" ||
      typeof options.backend.cas !== "function" ||
      target.id !== undefined && !positive(target.id) ||
      target.nodeId !== undefined && (typeof target.nodeId !== "string" || !target.nodeId))
    error("INVALID_TARGET", "preflight", "not_acquired");
  if (signal?.aborted) error("ABORTED", "preflight", "not_acquired");
  const backend = options.backend;
  let repo: CasRepository, branch: CasRef, parent: CasCommit;
  try {
    repo = await backend.repository(fullName);
    if (repo.fullName !== fullName || !positive(repo.id) || !repo.nodeId ||
        target.id !== undefined && target.id !== repo.id ||
        target.nodeId !== undefined && target.nodeId !== repo.nodeId)
      error("REPOSITORY_MISMATCH", "preflight", "not_acquired");
    if (typeof repo.defaultBranch !== "string" || !BRANCH.test(repo.defaultBranch) ||
        repo.defaultBranch.startsWith("/") || repo.defaultBranch.endsWith("/") ||
        repo.defaultBranch.split("/").some((part) => !part || part === "." || part === ".."))
      error("EMPTY_REPOSITORY", "preflight", "not_acquired");
    branch = await backend.branch(fullName, repo.defaultBranch);
    if (branch.ref !== "refs/heads/" + repo.defaultBranch ||
        branch.type !== "commit" || !validOid(branch.oid))
      error("INVALID_IDENTITY", "preflight", "not_acquired");
    parent = await backend.commit(fullName, branch.oid);
    if (parent.oid !== branch.oid || !validOid(parent.treeOid) ||
        !Array.isArray(parent.parentOids)) error("INVALID_IDENTITY", "preflight", "not_acquired");
    const current = await backend.lockRef(fullName);
    if (current) {
      if (current.ref !== GITHUB_CAS_LOCK_REF || current.type !== "commit" ||
          !validOid(current.oid)) error("INVALID_IDENTITY", "preflight", "not_acquired");
      error("LOCK_HELD", "preflight", "not_acquired");
    }
  } catch (err) { return withState(err, "preflight", "not_acquired"); }
  if (signal?.aborted) error("ABORTED", "prepare", "not_acquired");
  let nonce: string;
  try { nonce = options.nonceFactory ? options.nonceFactory() : globalThis.crypto.randomUUID(); }
  catch { return error("INVALID_IDENTITY", "prepare", "not_acquired"); }
  if (!UUID.test(nonce)) error("INVALID_IDENTITY", "prepare", "not_acquired");
  const message = [
    "gh-plan-cas/v1", "repository=" + fullName,
    "repository-id=" + repo.id, "repository-node-id=" + repo.nodeId,
    "run-id=" + options.runId, "nonce=" + nonce,
    "base=" + parent.oid,
  ].join("\n");
  let candidate: CasCommit;
  try {
    candidate = await backend.makeCommit(fullName, message, parent.treeOid, parent.oid);
    if (!validOid(candidate.oid) || candidate.oid === parent.oid ||
        candidate.message !== message || candidate.treeOid !== parent.treeOid ||
        candidate.parentOids.length !== 1 || candidate.parentOids[0] !== parent.oid)
      error("INVALID_IDENTITY", "prepare", "not_acquired");
    const reread = await backend.commit(fullName, candidate.oid);
    validateCommit(reread, candidate, "prepare", "not_acquired");
  } catch (err) { return withState(err, "prepare", "not_acquired"); }
  if (signal?.aborted) error("ABORTED", "acquire", "not_acquired");

  let mutationFailed = false;
  try {
    await backend.cas(repo.nodeId, GITHUB_CAS_ZERO_OID, candidate.oid);
  } catch { mutationFailed = true; }

  let obtained: CasRef | null;
  try { obtained = await backend.lockRef(fullName); }
  catch { return error("ACQUIRE_UNCERTAIN", "acquire", "unknown"); }
  if (!obtained) error("ACQUIRE_UNCERTAIN", "acquire", "unknown");
  if (obtained.ref !== GITHUB_CAS_LOCK_REF || obtained.type !== "commit" ||
      !validOid(obtained.oid)) error("ACQUIRE_UNCERTAIN", "acquire", "unknown");
  if (obtained.oid !== candidate.oid)
    error(mutationFailed ? "LOCK_HELD" : "LOCK_LOST", "acquire", "not_acquired");
  try {
    const checked = await backend.commit(fullName, candidate.oid);
    validateCommit(checked, candidate, "acquire", "unknown");
  } catch { return error("ACQUIRE_UNCERTAIN", "acquire", "unknown"); }

  let released = false;
  let inflight = false;
  let unknownEffect = false;
  async function assertOwned(): Promise<void> {
    if (released) error("LOCK_LOST", "ownership", "released");
    if (signal?.aborted) error("ABORTED", "ownership", "retained");
    let current: CasRef | null, checked: CasCommit;
    try {
      current = await backend.lockRef(fullName);
      checkRef(current, candidate.oid, "ownership", "unknown");
      checked = await backend.commit(fullName, candidate.oid);
      validateCommit(checked, candidate, "ownership", "unknown");
    } catch (err) { return withState(err, "ownership", "unknown"); }
  }
  async function guardResourceMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (inflight) error("MUTATION_IN_FLIGHT", "mutation", "retained");
    if (unknownEffect) error("MUTATION_UNCERTAIN", "mutation", "retained");
    if (typeof mutation !== "function") error("INVALID_TARGET", "mutation", "retained");
    inflight = true;
    let started = false;
    try {
      await assertOwned();
      if (signal?.aborted) error("ABORTED", "mutation", "retained");
      started = true;
      const outcome = await mutation();
      if (signal?.aborted) error("ABORTED", "mutation", "retained");
      return outcome;
    } catch (err) {
      if (started) {
        unknownEffect = true; // even a thrown callback may have committed remotely
        return error("MUTATION_UNCERTAIN", "mutation", "retained");
      }
      return withState(err, "mutation", "retained");
    } finally {
      inflight = false;
    }
  }
  async function release(): Promise<void> {
    if (released) error("LOCK_LOST", "release", "released");
    if (inflight || unknownEffect) error("RELEASE_FORBIDDEN", "release", "retained");
    try { await assertOwned(); } catch (err) {
      return withState(err, "release", "unknown");
    }
    let casFailed = false;
    try { await backend.cas(repo.nodeId, candidate.oid, GITHUB_CAS_ZERO_OID); }
    catch { casFailed = true; }
    let current: CasRef | null;
    try { current = await backend.lockRef(fullName); }
    catch { return error("RELEASE_UNCERTAIN", "release", "unknown"); }
    // Even when the zero-ref is observed, a lost CAS reply cannot establish
    // that *our* release succeeded, as opposed to an external actor removing it.
    if (casFailed) error("RELEASE_UNCERTAIN", "release", current ? "retained" : "unknown");
    if (current) {
      if (current.oid !== candidate.oid)
        error("LOCK_LOST", "release", "unknown");
      error("RELEASE_UNCERTAIN", "release", "retained");
    }
    released = true;
  }
  return Object.freeze({
    ownerOid: candidate.oid, repository: fullName,
    runId: options.runId, lockRef: GITHUB_CAS_LOCK_REF,
    assertOwned, guardResourceMutation, release,
  });
}

export interface GithubCasHttpOptions {
  /** Runtime-only GitHub bearer; never included in return values. */
  auth: string;
  /** Internal deterministic transport injection only. */
  fetch?: FetchLike;
}
function codeForStatus(response: FetchResponseLike): CasErrorCode {
  if (response.status === 401) return "AUTH_FAILED";
  if (response.status === 403 && (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.get("retry-after") !== null) || response.status === 429)
    return "RATE_LIMITED";
  if (response.status === 403) return "PERMISSION_DENIED";
  return "TRANSPORT_FAILED";
}
/** Trusted GitHub REST+GraphQL transport implementation, not a public writer. */
export function createGithubCasHttpBackend(options: GithubCasHttpOptions): GithubCasBackend {
  if (!options || typeof options.auth !== "string" || !options.auth.trim() ||
      options.fetch !== undefined && typeof options.fetch !== "function")
    error("INVALID_TARGET", "preflight", "not_acquired");
  const fetcher = options.fetch ?? globalThis.fetch as FetchLike;
  if (typeof fetcher !== "function") error("TRANSPORT_FAILED", "preflight", "not_acquired");

  async function request(path: string, method: "GET" | "POST", body?: unknown,
    absentRef = false): Promise<unknown | null> {
    const url = BASE + path;
    let response: FetchResponseLike;
    try {
      response = await fetcher(url, {
        method, redirect: "error",
        headers: {
          Authorization: "Bearer " + options.auth,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { return error("TRANSPORT_FAILED", "preflight", "unknown"); }
    if (!response || !response.headers || typeof response.headers.get !== "function" ||
        typeof response.status !== "number")
      error("INVALID_RESPONSE", "preflight", "unknown");
    if (response.url && response.url !== url)
      error("TRANSPORT_FAILED", "preflight", "unknown");
    if (absentRef && method === "GET" && response.status === 404) return null;
    if (response.status !== (method === "GET" ? 200 : 201) &&
        !(method === "POST" && path === "/graphql" && response.status === 200))
      error(codeForStatus(response), "preflight", "unknown");
    let data: unknown;
    try { data = await response.json(); }
    catch { return error("INVALID_RESPONSE", "preflight", "unknown"); }
    return data;
  }
  function repoPath(fullName: string): string {
    if (!REPOSITORY.test(fullName)) error("INVALID_TARGET", "preflight", "not_acquired");
    return "/repos/" + fullName;
  }
  function parseRef(raw: unknown, name: string): CasRef {
    if (!object(raw) || raw.ref !== name || !object(raw.object) ||
        raw.object.type !== "commit" || !validOid(raw.object.sha))
      return error("INVALID_RESPONSE", "preflight", "unknown");
    return { ref: name, oid: raw.object.sha, type: "commit" };
  }
  function parseCommit(raw: unknown, oid?: string): CasCommit {
    if (!object(raw) || !validOid(raw.sha) ||
        oid !== undefined && raw.sha !== oid || !object(raw.tree) ||
        !validOid(raw.tree.sha) || !Array.isArray(raw.parents) ||
        !raw.parents.every((p: unknown) => object(p) && validOid(p.sha)) ||
        typeof raw.message !== "string")
      return error("INVALID_RESPONSE", "prepare", "unknown");
    return {
      oid: raw.sha, treeOid: raw.tree.sha,
      parentOids: raw.parents.map((p: { sha: string }) => p.sha),
      message: raw.message,
    };
  }
  return {
    async repository(fullName) {
      const raw = await request(repoPath(fullName), "GET");
      if (!object(raw) || raw.full_name !== fullName ||
          !positive(raw.id) || typeof raw.node_id !== "string" || !raw.node_id ||
          typeof raw.default_branch !== "string")
        return error("REPOSITORY_MISMATCH", "preflight", "not_acquired");
      return {
        fullName: raw.full_name, id: raw.id,
        nodeId: raw.node_id, defaultBranch: raw.default_branch,
      };
    },
    async branch(fullName, name) {
      if (!BRANCH.test(name) || name.split("/").some((p) => !p || p === "." || p === ".."))
        return error("INVALID_TARGET", "preflight", "not_acquired");
      const path = repoPath(fullName) + "/git/ref/heads/" + name;
      return parseRef(await request(path, "GET"), "refs/heads/" + name);
    },
    async commit(fullName, oid) {
      if (!validOid(oid)) return error("INVALID_TARGET", "prepare", "not_acquired");
      return parseCommit(await request(repoPath(fullName) + "/git/commits/" + oid, "GET"), oid);
    },
    async makeCommit(fullName, message, treeOid, parentOid) {
      if (!validOid(treeOid) || !validOid(parentOid) ||
          typeof message !== "string" || !message.startsWith("gh-plan-cas/v1\n"))
        return error("INVALID_TARGET", "prepare", "not_acquired");
      const raw = await request(repoPath(fullName) + "/git/commits", "POST",
        { message, tree: treeOid, parents: [parentOid] });
      return parseCommit(raw);
    },
    async lockRef(fullName) {
      const raw = await request(repoPath(fullName) +
        "/git/ref/heads/gh-plan/locks/repository", "GET", undefined, true);
      return raw === null ? null : parseRef(raw, GITHUB_CAS_LOCK_REF);
    },
    async cas(repositoryNodeId, beforeOid, afterOid) {
      if (typeof repositoryNodeId !== "string" || !repositoryNodeId ||
          (beforeOid !== GITHUB_CAS_ZERO_OID && !validOid(beforeOid)) ||
          (afterOid !== GITHUB_CAS_ZERO_OID && !validOid(afterOid)) ||
          beforeOid === afterOid)
        return error("INVALID_TARGET", "acquire", "not_acquired");
      const input = {
        repositoryId: repositoryNodeId,
        refUpdates: [{
          name: GITHUB_CAS_LOCK_REF,
          beforeOid, afterOid, force: false,
        }],
      };
      const raw = await request("/graphql", "POST", {
        query: "mutation ApplyOwnerCas($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
        variables: { input },
      });
      if (!object(raw) || !object(raw.data) ||
          !object(raw.data.updateRefs) || !Array.isArray(raw.errors) && raw.errors !== undefined)
        return error("INVALID_RESPONSE", "acquire", "unknown");
      if (raw.errors !== undefined && raw.errors.length > 0)
        return error("TRANSPORT_FAILED", "acquire", "unknown");
    },
  };
}
