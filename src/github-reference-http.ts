import { GITHUB_REST_API_VERSION } from "./rest.ts";
import { GITHUB_CAS_LOCK_REF } from "./github-cas-lock.ts";
import type {
  FetchLike, FetchRequestInitLike, FetchResponseLike,
  ObservedIssue, ObservedMilestone, RepositoryRef,
} from "./types.ts";

/**
 * INTERNAL reference transport (#189). Canonical GitHub origin and repository
 * only; no arbitrary redirects, writes, GraphQL operations or credential export.
 * Mutation pacing includes off-ref CAS commits and GraphQL ref updates.
 */
export type GithubReferenceErrorCode =
  | "INVALID_CONFIG" | "UNSAFE_REQUEST" | "REPOSITORY_MISMATCH"
  | "AUTH_FAILED" | "PERMISSION_DENIED" | "NOT_FOUND"
  | "RATE_LIMITED" | "TRANSPORT_FAILED" | "INVALID_RESPONSE"
  | "INCOMPLETE_CATALOG" | "WRITE_UNCERTAIN" | "ABORTED";
export class GithubReferenceError extends Error {
  readonly code: GithubReferenceErrorCode;
  constructor(code: GithubReferenceErrorCode) {
    super("GitHub reference adapter stopped (" + code + ").");
    this.name = "GithubReferenceError";
    this.code = code;
  }
  toJSON(): { code: GithubReferenceErrorCode } { return { code: this.code }; }
}
function fail(code: GithubReferenceErrorCode): never { throw new GithubReferenceError(code); }
const BASE = "https://api.github.com";
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const NUM = /^[1-9]\d*$/;
const OID = /^[0-9a-f]{40}$/;
const MAX_PAGES = 1000;
const MIN_MUTATION_INTERVAL_MS = 1000;
const MAX_GET_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30000;
const OWNER_CAS_QUERY =
  "mutation ApplyOwnerCas($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function readableUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { return fail("UNSAFE_REQUEST"); }
  if (url.origin !== BASE || url.username || url.password || url.hash ||
      url.protocol !== "https:" || url.toString() !== input ||
      url.pathname.includes("%") || url.pathname.includes("//"))
    fail("UNSAFE_REQUEST");
  return url;
}
function params(page: URL, path: string): void {
  const args = [...page.searchParams.entries()];
  if (page.pathname !== path || ![2, 3].includes(args.length) ||
      page.searchParams.get("state") !== "all" ||
      page.searchParams.get("per_page") !== "100")
    fail("UNSAFE_REQUEST");
  const keys = args.map(([key]) => key);
  if (new Set(keys).size !== keys.length ||
      keys.some((k) => !["state", "per_page", "page"].includes(k)))
    fail("UNSAFE_REQUEST");
  const number = page.searchParams.get("page");
  if (number !== null && (!NUM.test(number) || Number(number) < 2))
    fail("UNSAFE_REQUEST");
}
function resourceBody(kind: "issues" | "milestones", create: boolean,
  payload: unknown): boolean {
  if (!record(payload) || !Object.keys(payload).length) return false;
  const fields = kind === "issues"
    ? create ? ["title", "body", "milestone"] : ["title", "body", "state", "milestone"]
    : ["title", "description", "state", "due_on"];
  if (Object.keys(payload).some((key) => !fields.includes(key))) return false;
  if (create && (typeof payload.title !== "string" || !payload.title.trim()))
    return false;
  if (create && kind === "issues" && typeof payload.body !== "string")
    return false;
  return Object.entries(payload).every(([field, value]) => {
    if (field === "title") return typeof value === "string" && !!value.trim();
    if (field === "body" || field === "description")
      return typeof value === "string";
    if (field === "state") return value === "open" || value === "closed";
    if (field === "milestone") return kind === "issues" &&
      (positive(value) || !create && value === null);
    if (field === "due_on") return typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value) ||
      !create && value === null;
    return false;
  });
}
function requestAllowed(repository: string, url: URL, method: string,
  payload: unknown): void {
  const base = "/repos/" + repository, path = url.pathname;
  if (path === "/graphql") {
    if (method !== "POST" || url.search || !record(payload) ||
        Object.keys(payload).length !== 2 ||
        payload.query !== OWNER_CAS_QUERY || !record(payload.variables) ||
        !record(payload.variables.input) ||
        !Array.isArray(payload.variables.input.refUpdates) ||
        payload.variables.input.refUpdates.length !== 1 ||
        typeof payload.variables.input.repositoryId !== "string" ||
        !payload.variables.input.repositoryId ||
        !record(payload.variables.input.refUpdates[0]))
      fail("UNSAFE_REQUEST");
    const update = payload.variables.input.refUpdates[0];
    if (update.name !== GITHUB_CAS_LOCK_REF || update.force !== false ||
        typeof update.beforeOid !== "string" ||
        typeof update.afterOid !== "string" ||
        !OID.test(update.beforeOid) || !OID.test(update.afterOid) ||
        update.beforeOid === update.afterOid)
      fail("UNSAFE_REQUEST");
    return;
  }
  if (!path.startsWith(base + "/") && path !== base)
    fail("UNSAFE_REQUEST");
  if (method === "GET") {
    if (path === base && !url.search) return;
    const gitRef = base + "/git/ref/heads/";
    if (path.startsWith(gitRef) && !url.search) {
      const branch = path.slice(gitRef.length);
      if (branch && /^[A-Za-z0-9._/-]+$/.test(branch) &&
          branch.split("/").every((p) => p && p !== "." && p !== "..")) return;
    }
    const gitCommit = base + "/git/commits/";
    if (path.startsWith(gitCommit) && OID.test(path.slice(gitCommit.length)) &&
        !url.search) return;
    if (path === base + "/issues" || path === base + "/milestones") {
      params(url, path); return;
    }
    if (!url.search && ["/issues/", "/milestones/"].some((prefix) => {
      const head = base + prefix;
      return path.startsWith(head) && NUM.test(path.slice(head.length));
    })) return;
    fail("UNSAFE_REQUEST");
  }
  if (url.search) fail("UNSAFE_REQUEST");
  if (method === "POST") {
    if (path === base + "/git/commits" && record(payload) &&
        Object.keys(payload).length === 3 &&
        typeof payload.message === "string" &&
        payload.message.startsWith("gh-plan-cas/v1\nrepository=" + repository + "\n") &&
        typeof payload.tree === "string" && OID.test(payload.tree) &&
        Array.isArray(payload.parents) && payload.parents.length === 1 &&
        typeof payload.parents[0] === "string" && OID.test(payload.parents[0])) return;
    if (path === base + "/issues" && resourceBody("issues", true, payload) ||
        path === base + "/milestones" && resourceBody("milestones", true, payload))
      return;
    fail("UNSAFE_REQUEST");
  }
  if (method === "PATCH" &&
      (path.startsWith(base + "/issues/") &&
        NUM.test(path.slice((base + "/issues/").length)) &&
        resourceBody("issues", false, payload) ||
       path.startsWith(base + "/milestones/") &&
        NUM.test(path.slice((base + "/milestones/").length)) &&
        resourceBody("milestones", false, payload))) return;
  fail("UNSAFE_REQUEST");
}
function parseNext(link: string | null, path: string, page: number): string | undefined {
  if (link === null || link === "") return undefined;
  const segments = link.split(",").filter((part) => /rel\s*=\s*"?next"?/i.test(part));
  if (segments.length === 0) return undefined;
  if (segments.length !== 1) fail("INCOMPLETE_CATALOG");
  const next = /^\s*<([^<>]+)>\s*;\s*rel\s*=\s*"?next"?\s*$/i.exec(segments[0]!);
  if (!next) fail("INCOMPLETE_CATALOG");
  const url = readableUrl(next[1]!);
  params(url, path);
  if (url.searchParams.get("page") !== String(page + 1))
    fail("INCOMPLETE_CATALOG");
  return url.toString();
}
function header(response: FetchResponseLike, name: string): string | null {
  try {
    const value = response.headers.get(name);
    return value === null || typeof value === "string" ? value : fail("INVALID_RESPONSE");
  } catch { return fail("INVALID_RESPONSE"); }
}
function retryMillis(response: FetchResponseLike, now: number): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retry = header(response, "retry-after");
  const remaining = header(response, "x-ratelimit-remaining");
  if (retry !== null) {
    const seconds = Number(retry);
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.ceil(seconds * 1000) : null;
  }
  if (remaining === "0") {
    const reset = header(response, "x-ratelimit-reset");
    const seconds = reset === null ? NaN : Number(reset);
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.max(0, Math.ceil(seconds * 1000 - now + 1000)) : null;
  }
  // Secondary limits without headers call for >=60s; refuse beyond 30s budget.
  return response.status === 429 ? 60000 : null;
}
export interface ReferenceHttpOptions {
  repository: RepositoryRef;
  auth: string;
  /** Deterministic tests only; no public transport override. */
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}
export interface GithubReferenceHttp {
  fetch: FetchLike;
  assertRepository(requirePush: boolean): Promise<void>;
  issuesCatalog(): Promise<readonly ObservedIssue[]>;
  milestonesCatalog(): Promise<readonly ObservedMilestone[]>;
}

/** GETs and writes share a single FIFO, with >=1000ms between mutations. */
export function createGithubReferenceHttp(options: ReferenceHttpOptions): GithubReferenceHttp {
  const target = options?.repository;
  if (!record(target) || typeof target.fullName !== "string" ||
      !REPO.test(target.fullName) || typeof options.auth !== "string" ||
      !options.auth.trim() ||
      (target.id !== undefined && !positive(target.id)) ||
      (target.nodeId !== undefined &&
        (typeof target.nodeId !== "string" || !target.nodeId)) ||
      (options.fetch !== undefined && typeof options.fetch !== "function") ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.sleep !== undefined && typeof options.sleep !== "function"))
    fail("INVALID_CONFIG");
  const name = target.fullName;
  const fetcher: FetchLike = options.fetch ?? globalThis.fetch as FetchLike;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (typeof fetcher !== "function") fail("INVALID_CONFIG");
  let pending: Promise<void> = Promise.resolve();
  let lastMutation = -Infinity;
  let verifiedRepo: { id: number; nodeId: string } | undefined;

  async function execute(input: string, init?: FetchRequestInitLike): Promise<FetchResponseLike> {
    const url = readableUrl(input);
    const method = init?.method ?? "GET";
    if (!["GET", "POST", "PATCH"].includes(method) || init?.redirect !== "error" ||
        !record(init.headers) ||
        init.headers.Authorization !== "Bearer " + options.auth ||
        init.headers.Accept !== "application/vnd.github+json" ||
        init.headers["X-GitHub-Api-Version"] !== GITHUB_REST_API_VERSION)
      fail("UNSAFE_REQUEST");
    let payload: unknown;
    if (method !== "GET") {
      if (typeof init.body !== "string" || init.headers["Content-Type"] !== "application/json")
        fail("UNSAFE_REQUEST");
      try { payload = JSON.parse(init.body); }
      catch { return fail("UNSAFE_REQUEST"); }
    } else if (init.body !== undefined) fail("UNSAFE_REQUEST");
    requestAllowed(name, url, method, payload);
    // GraphQL CAS is repository-node-scoped, NOT REST path-scoped.
    // Require the exact previously authenticated canonical node ID.
    if (url.pathname === "/graphql") {
      if (!verifiedRepo || !record(payload) || !record(payload.variables) ||
          !record(payload.variables.input) ||
          payload.variables.input.repositoryId !== verifiedRepo.nodeId)
        fail("UNSAFE_REQUEST");
    }
    // Release the FIFO even on malformed response, denied write or abort.
    let unblock!: () => void;
    const prior = pending;
    pending = new Promise<void>((resolve) => { unblock = resolve; });
    await prior;
    try {
      if (options.signal?.aborted) fail("ABORTED");
      const mutating = method !== "GET";
      if (mutating && Number.isFinite(lastMutation)) {
        const gap = Math.max(0, MIN_MUTATION_INTERVAL_MS - (now() - lastMutation));
        if (gap) await sleep(gap);
      }
      if (options.signal?.aborted) fail("ABORTED");
      for (let attempt = 0; attempt <= MAX_GET_RETRIES; attempt++) {
        if (mutating) lastMutation = now();
        let response: FetchResponseLike;
        try { response = await fetcher(input, init); }
        catch { return fail(mutating ? "WRITE_UNCERTAIN" : "TRANSPORT_FAILED"); }
        if (!response || typeof response.status !== "number" ||
            !response.headers || typeof response.headers.get !== "function" ||
            (response.url && response.url !== input))
          fail(mutating ? "WRITE_UNCERTAIN" : "INVALID_RESPONSE");
        // Hidden 404 is never evidence of absent *repository*. For A1's
        // unique lock ref, independently re-read canonical repo before 404.
        if (response.status === 404 &&
            url.pathname === "/repos/" + name + "/git/ref/heads/gh-plan/locks/repository") {
          if (!verifiedRepo) fail("NOT_FOUND");
          let probe: FetchResponseLike;
          try {
            probe = await fetcher(BASE + "/repos/" + name, {
              method: "GET", redirect: "error", headers: init!.headers!,
            });
          } catch { return fail("TRANSPORT_FAILED"); }
          if (!probe || probe.status !== 200 ||
              (probe.url && probe.url !== BASE + "/repos/" + name))
            fail("NOT_FOUND");
          let raw: unknown;
          try { raw = await probe.json(); } catch { return fail("INVALID_RESPONSE"); }
          if (!record(raw) || raw.full_name !== name ||
              raw.id !== verifiedRepo.id || raw.node_id !== verifiedRepo.nodeId)
            fail("REPOSITORY_MISMATCH");
          return response;
        }
        const delay = retryMillis(response, now());
        if (delay !== null) {
          if (mutating) fail("WRITE_UNCERTAIN"); // No POST/PATCH retry, ever.
          if (attempt === MAX_GET_RETRIES || delay > MAX_RETRY_DELAY_MS)
            fail("RATE_LIMITED");
          if (options.signal?.aborted) fail("ABORTED");
          try { await sleep(delay); }
          catch { return fail("RATE_LIMITED"); }
          continue;
        }
        if (response.status === 401) fail("AUTH_FAILED");
        if (response.status === 403) fail("PERMISSION_DENIED");
        if (response.status === 404) fail("NOT_FOUND");
        if (mutating && response.status !== (method === "PATCH" ? 200 :
          url.pathname === "/graphql" ? 200 : 201))
          fail("WRITE_UNCERTAIN");
        if (!mutating && response.status !== 200) fail("TRANSPORT_FAILED");
        return response;
      }
      return fail("RATE_LIMITED");
    } finally { unblock(); }
  }

  async function get(path: string): Promise<{ raw: unknown; link: string | null }> {
    const response = await execute(BASE + path, {
      method: "GET", redirect: "error", headers: {
        Authorization: "Bearer " + options.auth,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
      },
    });
    let raw: unknown;
    try { raw = await response.json(); }
    catch { return fail("INVALID_RESPONSE"); }
    return { raw, link: header(response, "link") };
  }
  async function assertRepository(requirePush: boolean): Promise<void> {
    const { raw } = await get("/repos/" + name);
    if (!record(raw) || raw.full_name !== name || !positive(raw.id) ||
        typeof raw.node_id !== "string" || !raw.node_id ||
        (target.id !== undefined && raw.id !== target.id) ||
        (target.nodeId !== undefined && raw.node_id !== target.nodeId))
      fail("REPOSITORY_MISMATCH");
    verifiedRepo = { id: raw.id, nodeId: raw.node_id };
    // GitHub App installation tokens can be authorized for milestone-on-create
    // even when the repository's user-role permissions.push is false. #181
    // observed a real pinned-API GITHUB_TOKEN POST /issues?milestone returning
    // 201 despite that flag being false. Do NOT infer App write capability from
    // this role field. Verify repository identity here; GitHub enforces actual
    // Contents:write on A1 CAS and Issues:write on the B1 mutation. A 403 or
    // hidden 404 still fails closed without repeating a possible write.
    if (requirePush && !record(raw.permissions))
      fail("PERMISSION_DENIED"); // Missing authority metadata is uncertain.
  }
  async function paginate(kind: "issues" | "milestones"): Promise<unknown[]> {
    const base = "/repos/" + name + "/" + kind;
    let url: string | undefined = BASE + base + "?state=all&per_page=100";
    const result: unknown[] = [];
    let page = 1;
    while (url !== undefined) {
      if (page > MAX_PAGES) fail("INCOMPLETE_CATALOG");
      const response = await execute(url, { method: "GET", redirect: "error", headers: {
        Authorization: "Bearer " + options.auth,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
      } });
      let raw: unknown;
      try { raw = await response.json(); }
      catch { return fail("INVALID_RESPONSE"); }
      if (!Array.isArray(raw) || raw.length > 100) fail("INCOMPLETE_CATALOG");
      result.push(...raw);
      url = parseNext(header(response, "link"), base, page);
      if (url && raw.length === 0) fail("INCOMPLETE_CATALOG");
      page++;
    }
    return result;
  }
  async function issuesCatalog(): Promise<readonly ObservedIssue[]> {
    const seenNumber = new Set<number>(), seenId = new Set<number>(),
      seenNode = new Set<string>();
    const entries: ObservedIssue[] = [];
    for (const row of await paginate("issues")) {
      if (!record(row) || !positive(row.number) || !positive(row.id) ||
          typeof row.node_id !== "string" || !row.node_id ||
          seenNumber.has(row.number) || seenId.has(row.id) || seenNode.has(row.node_id))
        fail("INCOMPLETE_CATALOG");
      seenNumber.add(row.number); seenId.add(row.id); seenNode.add(row.node_id);
      if (row.pull_request !== undefined) {
        if (!record(row.pull_request)) fail("INVALID_RESPONSE");
        continue;
      }
      if (typeof row.title !== "string" ||
          (row.body !== null && typeof row.body !== "string") ||
          (row.state !== "open" && row.state !== "closed") ||
          (row.milestone !== null &&
            (!record(row.milestone) || !positive(row.milestone.number))))
        fail("INVALID_RESPONSE");
      entries.push({
        kind: "issue", number: row.number, id: row.id, nodeId: row.node_id,
        title: row.title, body: row.body, state: row.state,
        milestoneNumber: row.milestone === null ? null : (row.milestone as {number:number}).number,
      });
    }
    return entries;
  }
  async function milestonesCatalog(): Promise<readonly ObservedMilestone[]> {
    const seenNumber = new Set<number>(), seenId = new Set<number>(),
      seenNode = new Set<string>();
    const entries: ObservedMilestone[] = [];
    for (const row of await paginate("milestones")) {
      if (!record(row) || !positive(row.number) || !positive(row.id) ||
          typeof row.node_id !== "string" || !row.node_id ||
          seenNumber.has(row.number) || seenId.has(row.id) || seenNode.has(row.node_id) ||
          typeof row.title !== "string" ||
          (row.state !== "open" && row.state !== "closed") ||
          (row.description !== null && typeof row.description !== "string") ||
          (row.due_on !== null && typeof row.due_on !== "string"))
        fail("INCOMPLETE_CATALOG");
      seenNumber.add(row.number); seenId.add(row.id); seenNode.add(row.node_id);
      entries.push({
        kind: "milestone", number: row.number, id: row.id, nodeId: row.node_id,
        title: row.title, state: row.state, description: row.description,
        due_on: row.due_on,
      });
    }
    return entries;
  }
  return Object.freeze({ fetch: execute, assertRepository, issuesCatalog, milestonesCatalog });
}
