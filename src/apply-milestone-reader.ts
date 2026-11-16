import { fromGithubMilestoneDueOn } from "./milestone-due-date.ts";
import { GITHUB_REST_API_VERSION } from "./rest.ts";
import type { ApplyPostconditionSpec, ApplyFieldPredicate } from "./apply-preflight.ts";
import type { FetchLike, FetchResponseLike } from "./types.ts";

/**
 * Internal, GET-only GitHub milestone verification. It does not dispatch a
 * mutation, acquire a lock, implement a public apply API or retry unknown POSTs.
 * The caller must complete whole-plan B1 preflight before acquiring ownership.
 */
export type MilestoneReadPhase = "before" | "after";
export type MilestoneReadErrorCode =
  | "INVALID_SPEC" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED"
  | "READ_FAILED" | "INCOMPLETE_CATALOG" | "INVALID_RESPONSE"
  | "AMBIGUOUS_TITLE" | "IDENTITY_MISMATCH" | "POSTCONDITION_MISMATCH"
  | "INDETERMINATE_WRITE";

export class MilestoneReadError extends Error {
  readonly code: MilestoneReadErrorCode;
  readonly phase: MilestoneReadPhase;

  constructor(code: MilestoneReadErrorCode, phase: MilestoneReadPhase) {
    super("Milestone verification failed (" + code + ").");
    this.name = "MilestoneReadError";
    this.code = code;
    this.phase = phase;
  }

  toJSON(): { code: MilestoneReadErrorCode; phase: MilestoneReadPhase } {
    return { code: this.code, phase: this.phase };
  }
}

export interface MilestoneIdentity {
  number: number;
  id: number;
  nodeId: string;
}

export interface MilestoneSnapshot extends MilestoneIdentity {
  title: string;
  state: "open" | "closed";
  description: string | null;
  due_on: string | null;
}

export interface MilestoneBeforeRead {
  readonly status: "satisfied" | "unsatisfied";
  readonly snapshot?: Readonly<MilestoneSnapshot>;
}
export interface MilestoneAfterRead {
  readonly status: "satisfied";
  readonly snapshot: Readonly<MilestoneSnapshot>;
  readonly identity: Readonly<MilestoneIdentity>;
}
export interface MilestoneReadTransportOptions {
  /** Runtime-only token; never stored in returned results or errors. */
  auth: string;
  /** Injection supports deterministic GET-only tests, not a public transport override. */
  fetch?: FetchLike;
}
export interface MilestonePostconditionReader {
  readBefore(
    spec: ApplyPostconditionSpec,
    expectedIdentity?: Partial<MilestoneIdentity>,
  ): Promise<MilestoneBeforeRead>;
  readAfter(
    spec: ApplyPostconditionSpec,
    before: MilestoneBeforeRead,
    responseIdentity?: unknown,
  ): Promise<MilestoneAfterRead>;
}

const ORIGIN = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const POSITIVE = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const MAX_PAGES = 1000;

function fail(code: MilestoneReadErrorCode, phase: MilestoneReadPhase): never {
  throw new MilestoneReadError(code, phase);
}
function fieldsEqual(a: MilestoneSnapshot, b: MilestoneSnapshot): boolean {
  return a.title === b.title && a.state === b.state &&
    (a.description ?? "") === (b.description ?? "") &&
    calendarDay(a.due_on) === calendarDay(b.due_on);
}
function calendarDay(value: string | null): string | null | undefined {
  return value === null ? null : fromGithubMilestoneDueOn(value);
}
function sameIdentity(a: MilestoneIdentity, b: MilestoneIdentity): boolean {
  return a.number === b.number && a.id === b.id && a.nodeId === b.nodeId;
}
function validateClaim(raw: unknown, phase: MilestoneReadPhase, partial = false): Partial<MilestoneIdentity> {
  if (!isRecord(raw)) fail("IDENTITY_MISMATCH", phase);
  const nodeId = raw.node_id ?? raw.nodeId;
  if ((!partial || raw.number !== undefined) && !POSITIVE(raw.number) ||
      (!partial || raw.id !== undefined) && !POSITIVE(raw.id) ||
      (!partial || nodeId !== undefined) && (typeof nodeId !== "string" || !nodeId))
    fail("IDENTITY_MISMATCH", phase);
  return {
    ...(raw.number === undefined ? {} : { number: raw.number as number }),
    ...(raw.id === undefined ? {} : { id: raw.id as number }),
    ...(nodeId === undefined ? {} : { nodeId: nodeId as string }),
  };
}
function matchesClaim(actual: MilestoneIdentity, claim: Partial<MilestoneIdentity>): boolean {
  return (claim.number === undefined || claim.number === actual.number) &&
    (claim.id === undefined || claim.id === actual.id) &&
    (claim.nodeId === undefined || claim.nodeId === actual.nodeId);
}

/** Reject unrecognized or mutated descriptor shapes before making any requests. */
function checkSpec(spec: ApplyPostconditionSpec, phase: MilestoneReadPhase): void {
  if (!isRecord(spec) || spec.version !== 1 ||
      (spec.kind !== "milestone.create" && spec.kind !== "milestone.update") ||
      typeof spec.stepId !== "string" || !spec.stepId.startsWith(spec.kind + ":") ||
      !REPOSITORY.test(spec.repository) ||
      !Array.isArray(spec.predicates) || spec.predicates.length === 0 ||
      !Array.isArray(spec.reads) || !isRecord(spec.identity)) fail("INVALID_SPEC", phase);

  const create = spec.kind === "milestone.create";
  const base = "/repos/" + spec.repository + "/milestones";
  if (create) {
    if (spec.method !== "POST" || spec.path !== base ||
        spec.identity.strategy !== "unique_milestone_title" ||
        typeof spec.identity.title !== "string" || !spec.identity.title.trim() ||
        spec.reads.join(",") !== "milestones.catalog,milestones.byNumber")
      fail("INVALID_SPEC", phase);
  } else {
    if (spec.method !== "PATCH" || spec.identity.strategy !== "milestone_number" ||
        !POSITIVE(spec.identity.number) ||
        spec.path !== base + "/" + spec.identity.number ||
        spec.reads.join(",") !== "milestones.byNumber")
      fail("INVALID_SPEC", phase);
  }

  const seen = new Set<string>();
  for (const predicate of spec.predicates) {
    if (!isRecord(predicate) || typeof predicate.field !== "string" ||
        !["title", "description", "state", "due_on"].includes(predicate.field) ||
        seen.has(predicate.field)) fail("INVALID_SPEC", phase);
    seen.add(predicate.field);
    const { field, expected, comparison } = predicate as ApplyFieldPredicate;
    if (field === "title" && (comparison !== "exact" ||
        typeof expected !== "string" || !expected.trim()) ||
        field === "description" && (comparison !== "exact" || typeof expected !== "string") ||
        field === "state" && (comparison !== "exact" ||
          expected !== "open" && expected !== "closed") ||
        field === "due_on" && (expected === null
          ? create || comparison !== "null"
          : comparison !== "utc_day" || typeof expected !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(expected) ||
            fromGithubMilestoneDueOn(expected) === undefined))
      fail("INVALID_SPEC", phase);
  }
  if (create && spec.identity.strategy === "unique_milestone_title" &&
      (!seen.has("title") || spec.predicates.find((p) =>
        p.field === "title")?.expected !== spec.identity.title))
    fail("INVALID_SPEC", phase);
}
function readSnapshot(raw: unknown, phase: MilestoneReadPhase): MilestoneSnapshot {
  if (!isRecord(raw) || !POSITIVE(raw.number) || !POSITIVE(raw.id) ||
      typeof raw.node_id !== "string" || !raw.node_id ||
      typeof raw.title !== "string" || !raw.title.trim() ||
      (raw.state !== "open" && raw.state !== "closed") ||
      (raw.description !== null && typeof raw.description !== "string") ||
      (raw.due_on !== null && (typeof raw.due_on !== "string" ||
        calendarDay(raw.due_on) === undefined)))
    fail("INVALID_RESPONSE", phase);
  return Object.freeze({
    number: raw.number, id: raw.id, nodeId: raw.node_id,
    title: raw.title, state: raw.state,
    description: raw.description, due_on: raw.due_on,
  } as MilestoneSnapshot);
}
function checkPredicates(spec: ApplyPostconditionSpec, observed: MilestoneSnapshot): boolean {
  return spec.predicates.every((predicate) => {
    const { field, expected } = predicate;
    if (field === "title") return observed.title === expected;
    if (field === "description")
      return expected === "" ? (observed.description ?? "") === "" :
        observed.description === expected;
    if (field === "state") return observed.state === expected;
    if (field === "due_on")
      return expected === null ? observed.due_on === null :
        calendarDay(observed.due_on) === calendarDay(expected as string);
    return false;
  });
}
function classify(status: number, headers: FetchResponseLike["headers"]): MilestoneReadErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 429 || status === 403 && (headers.get("retry-after") !== null ||
    headers.get("x-ratelimit-remaining") === "0")) return "RATE_LIMITED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND"; // Never treat hidden 404 as absence.
  return "READ_FAILED";
}

function parseNext(link: string | null, base: string, page: number, phase: MilestoneReadPhase):
  string | undefined {
  if (link === null || link === "") return undefined;
  const links = link.split(",").filter((part) => /rel\s*=\s*"?next"?/i.test(part));
  if (links.length === 0) return undefined;
  if (links.length !== 1) fail("INCOMPLETE_CATALOG", phase);
  const match = /^\s*<([^<>]+)>\s*;\s*rel\s*=\s*"?next"?\s*$/i.exec(links[0]!);
  if (!match) fail("INCOMPLETE_CATALOG", phase);
  let parsed: URL;
  try { parsed = new URL(match[1]!); } catch { return fail("INCOMPLETE_CATALOG", phase); }
  const search = parsed.searchParams;
  const keys = [...search.keys()];
  if (parsed.origin !== ORIGIN || parsed.pathname !== base ||
      keys.length !== 3 || new Set(keys).size !== 3 ||
      search.get("state") !== "all" || search.get("per_page") !== "100" ||
      search.get("page") !== String(page + 1) || parsed.hash || parsed.username ||
      parsed.password) fail("INCOMPLETE_CATALOG", phase);
  return parsed.toString();
}

export function createRestMilestonePostconditionReader(
  options: MilestoneReadTransportOptions,
): MilestonePostconditionReader {
  if (!options || typeof options.auth !== "string" || !options.auth.trim() ||
      options.fetch !== undefined && typeof options.fetch !== "function")
    throw new MilestoneReadError("INVALID_SPEC", "before");
  const fetcher: FetchLike = options.fetch ?? globalThis.fetch as FetchLike;
  if (typeof fetcher !== "function")
    throw new MilestoneReadError("READ_FAILED", "before");

  async function get(url: string, phase: MilestoneReadPhase): Promise<{ data: unknown; link: string | null }> {
    let response: FetchResponseLike;
    try {
      response = await fetcher(url, { method: "GET", redirect: "error", headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + options.auth,
        "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
      } });
    } catch { return fail("READ_FAILED", phase); }
    if (!response || typeof response.status !== "number" || !response.headers ||
        typeof response.headers.get !== "function")
      fail("INVALID_RESPONSE", phase);
    if (response.url && response.url !== url) fail("READ_FAILED", phase);
    if (response.status !== 200) fail(classify(response.status, response.headers), phase);
    let data: unknown;
    try { data = await response.json(); } catch { return fail("INVALID_RESPONSE", phase); }
    let link: string | null;
    try {
      link = response.headers.get("link");
      if (link !== null && typeof link !== "string")
        fail("INVALID_RESPONSE", phase);
    } catch {
      return fail("INVALID_RESPONSE", phase);
    }
    return { data, link };
  }

  async function catalog(spec: ApplyPostconditionSpec, phase: MilestoneReadPhase):
    Promise<MilestoneSnapshot[]> {
    const base = "/repos/" + spec.repository + "/milestones";
    let next: string | undefined = ORIGIN + base + "?state=all&per_page=100";
    const all: MilestoneSnapshot[] = [];
    let page = 1;
    const ids = new Set<number>(), numbers = new Set<number>(), nodes = new Set<string>();
    while (next) {
      if (page > MAX_PAGES) fail("INCOMPLETE_CATALOG", phase);
      const response = await get(next, phase);
      if (!Array.isArray(response.data) || response.data.length > 100)
        fail("INCOMPLETE_CATALOG", phase);
      for (const row of response.data) {
        const milestone = readSnapshot(row, phase);
        if (ids.has(milestone.id) || numbers.has(milestone.number) ||
            nodes.has(milestone.nodeId)) fail("INCOMPLETE_CATALOG", phase);
        ids.add(milestone.id); numbers.add(milestone.number); nodes.add(milestone.nodeId);
        all.push(milestone);
      }
      next = parseNext(response.link, base, page, phase);
      if (next && response.data.length === 0) fail("INCOMPLETE_CATALOG", phase);
      page++;
    }
    return all;
  }
  async function byNumber(spec: ApplyPostconditionSpec, number: number,
    phase: MilestoneReadPhase): Promise<MilestoneSnapshot> {
    const response = await get(ORIGIN + "/repos/" + spec.repository +
      "/milestones/" + number, phase);
    if (response.link) fail("INVALID_RESPONSE", phase);
    const observed = readSnapshot(response.data, phase);
    if (observed.number !== number) fail("IDENTITY_MISMATCH", phase);
    return observed;
  }
  const issued = new WeakMap<MilestoneBeforeRead, {
    signature: string; snapshot?: MilestoneSnapshot;
  }>();
  function signature(spec: ApplyPostconditionSpec): string {
    return JSON.stringify(spec);
  }
  async function verify(spec: ApplyPostconditionSpec, phase: MilestoneReadPhase):
    Promise<MilestoneSnapshot | undefined> {
    if (spec.kind === "milestone.update") {
      const identity = spec.identity;
      if (identity.strategy !== "milestone_number") fail("INVALID_SPEC", phase);
      return byNumber(spec, identity.number, phase);
    }
    const identity = spec.identity;
    if (identity.strategy !== "unique_milestone_title") fail("INVALID_SPEC", phase);
    const found = (await catalog(spec, phase)).filter((x) => x.title === identity.title);
    if (found.length > 1) fail("AMBIGUOUS_TITLE", phase);
    if (!found.length) return undefined;
    const detailed = await byNumber(spec, found[0]!.number, phase);
    if (!sameIdentity(found[0]!, detailed) || !fieldsEqual(found[0]!, detailed))
      fail("IDENTITY_MISMATCH", phase);
    return detailed;
  }
  return {
    async readBefore(spec, expectedIdentity) {
      checkSpec(spec, "before");
      if (expectedIdentity !== undefined) validateClaim(expectedIdentity, "before", true);
      const snapshot = await verify(spec, "before");
      if (snapshot && expectedIdentity && !matchesClaim(snapshot, expectedIdentity))
        fail("IDENTITY_MISMATCH", "before");
      if (spec.kind === "milestone.create" && snapshot && !checkPredicates(spec, snapshot))
        fail("POSTCONDITION_MISMATCH", "before"); // title exists, never duplicate POST.
      const result: MilestoneBeforeRead = Object.freeze({
        status: snapshot && checkPredicates(spec, snapshot) ? "satisfied" : "unsatisfied",
        ...(snapshot === undefined ? {} : { snapshot }),
      });
      issued.set(result, { signature: signature(spec), ...(snapshot ? { snapshot } : {}) });
      return result;
    },
    async readAfter(spec, before, responseIdentity) {
      checkSpec(spec, "after");
      const proof = issued.get(before);
      if (!proof || proof.signature !== signature(spec) ||
          spec.kind === "milestone.update" && !proof.snapshot)
        fail("INVALID_SPEC", "after");
      const observed = await verify(spec, "after");
      if (!observed) fail("INDETERMINATE_WRITE", "after");
      if (proof.snapshot && !sameIdentity(proof.snapshot, observed))
        fail("IDENTITY_MISMATCH", "after");
      if (proof.snapshot && spec.kind === "milestone.update" &&
          !preservesUnmanaged(spec, proof.snapshot, observed))
        fail("POSTCONDITION_MISMATCH", "after");
      if (responseIdentity !== undefined) {
        const claim = validateClaim(responseIdentity, "after");
        if (!matchesClaim(observed, claim)) fail("IDENTITY_MISMATCH", "after");
      }
      if (!checkPredicates(spec, observed))
        fail("POSTCONDITION_MISMATCH", "after");
      return Object.freeze({
        status: "satisfied" as const,
        snapshot: observed,
        identity: Object.freeze({
          number: observed.number, id: observed.id, nodeId: observed.nodeId,
        }),
      });
    },
  };
}
function preservesUnmanaged(spec: ApplyPostconditionSpec,
  prior: MilestoneSnapshot, observed: MilestoneSnapshot): boolean {
  const managed = new Set(spec.predicates.map((p) => p.field));
  return (!managed.has("title") && prior.title !== observed.title ? false : true) &&
    (!managed.has("state") && prior.state !== observed.state ? false : true) &&
    (!managed.has("description") &&
      (prior.description ?? "") !== (observed.description ?? "") ? false : true) &&
    (!managed.has("due_on") && calendarDay(prior.due_on) !== calendarDay(observed.due_on)
      ? false : true);
}
