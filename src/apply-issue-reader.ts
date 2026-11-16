import { matchesMarker } from "./identity.ts";
import { GITHUB_REST_API_VERSION } from "./rest.ts";
import type { ApplyFieldPredicate, ApplyPostconditionSpec } from "./apply-preflight.ts";
import type { FetchLike, FetchResponseLike, PlanBindings, PlanValueRef } from "./types.ts";

/** Internal, GET-only, B1 issue verifier; does not acquire ownership or dispatch. */
export type IssueReadPhase = "before" | "after";
export type IssueReadErrorCode =
  | "INVALID_SPEC" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED"
  | "READ_FAILED" | "INCOMPLETE_CATALOG" | "INVALID_RESPONSE"
  | "AMBIGUOUS_MARKER" | "IDENTITY_MISMATCH" | "POSTCONDITION_MISMATCH"
  | "INDETERMINATE_WRITE";
export class IssueReadError extends Error {
  readonly code: IssueReadErrorCode;
  readonly phase: IssueReadPhase;
  constructor(code: IssueReadErrorCode, phase: IssueReadPhase) {
    super("Issue verification failed (" + code + ").");
    this.name = "IssueReadError";
    this.code = code;
    this.phase = phase;
  }
  toJSON(): { code: IssueReadErrorCode; phase: IssueReadPhase } {
    return { code: this.code, phase: this.phase };
  }
}
export interface IssueIdentity {
  number: number;
  id: number;
  nodeId: string;
}
export interface IssueSnapshot extends IssueIdentity {
  title: string;
  body: string | null;
  state: "open" | "closed";
  milestoneNumber: number | null;
}
export interface IssueBeforeRead {
  readonly status: "satisfied" | "unsatisfied";
  readonly snapshot?: Readonly<IssueSnapshot>;
}
export interface IssueAfterRead {
  readonly status: "satisfied";
  readonly snapshot: Readonly<IssueSnapshot>;
  readonly identity: Readonly<IssueIdentity>;
}
export interface IssueReadContext {
  /** Producer values from independently verified create responses/readbacks. */
  bindings?: Readonly<PlanBindings>;
  /** Optional explicit identity hints from the compiler/planner. */
  expectedIdentity?: Partial<IssueIdentity>;
}
export interface IssueReadTransportOptions {
  /** Runtime-only credential, never copied into returned results or errors. */
  auth: string;
  /** Caller-trusted injection is for deterministic internal tests only. */
  fetch?: FetchLike;
}
export interface IssuePostconditionReader {
  readBefore(spec: ApplyPostconditionSpec, context?: IssueReadContext): Promise<IssueBeforeRead>;
  readAfter(spec: ApplyPostconditionSpec, before: IssueBeforeRead,
    responseIdentity?: unknown): Promise<IssueAfterRead>;
}

const ORIGIN = "https://api.github.com";
const MAX_PAGES = 1000;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
function positive(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0;
}
function record(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
function fail(code: IssueReadErrorCode, phase: IssueReadPhase): never {
  throw new IssueReadError(code, phase);
}
function sameId(a: IssueIdentity, b: IssueIdentity): boolean {
  return a.number === b.number && a.id === b.id && a.nodeId === b.nodeId;
}
function markerMatches(body: string | null, marker: string, custom: boolean): boolean {
  return typeof body === "string" &&
    body.split(marker).length === 2 && matchesMarker(body, marker, custom);
}
function identityClaim(input: unknown, phase: IssueReadPhase,
  partial: boolean): Partial<IssueIdentity> {
  if (!record(input)) fail("IDENTITY_MISMATCH", phase);
  const node = input.nodeId ?? input.node_id;
  if (input.nodeId !== undefined && input.node_id !== undefined &&
      input.nodeId !== input.node_id) fail("IDENTITY_MISMATCH", phase);
  if ((!partial || input.number !== undefined) && !positive(input.number) ||
      (!partial || input.id !== undefined) && !positive(input.id) ||
      (!partial || node !== undefined) && (typeof node !== "string" || !node))
    fail("IDENTITY_MISMATCH", phase);
  return {
    ...(input.number === undefined ? {} : { number: input.number as number }),
    ...(input.id === undefined ? {} : { id: input.id as number }),
    ...(node === undefined ? {} : { nodeId: node as string }),
  };
}
function claimMatches(actual: IssueIdentity, claim: Partial<IssueIdentity>): boolean {
  return (claim.number === undefined || claim.number === actual.number) &&
    (claim.id === undefined || claim.id === actual.id) &&
    (claim.nodeId === undefined || claim.nodeId === actual.nodeId);
}
function ref(value: unknown, resourceId: string): value is PlanValueRef {
  return record(value) && Object.keys(value).length === 1 &&
    value.$ref === resourceId + ".number";
}
type IssueDescriptor = ApplyPostconditionSpec & {
  kind: "issue.create" | "issue.update";
  identity:
    | { strategy: "unique_issue_marker"; marker: string }
    | { strategy: "issue_number"; number: number | PlanValueRef; marker: string };
};
function checkedSpec(value: ApplyPostconditionSpec, phase: IssueReadPhase): IssueDescriptor {
  if (!record(value) || value.version !== 1 ||
      (value.kind !== "issue.create" && value.kind !== "issue.update") ||
      !REPO.test(value.repository) ||
      !Array.isArray(value.predicates) || !value.predicates.length ||
      !Array.isArray(value.reads) || !record(value.identity) ||
      typeof value.stepId !== "string") fail("INVALID_SPEC", phase);

  const logicalId = value.stepId.slice(value.kind.length + 1);
  if (!value.stepId.startsWith(value.kind + ":") || !ID.test(logicalId))
    fail("INVALID_SPEC", phase);
  const create = value.kind === "issue.create";
  const identity = value.identity;
  const base = "/repos/" + value.repository + "/issues";
  if (create) {
    if (value.method !== "POST" || value.path !== base ||
        identity.strategy !== "unique_issue_marker" ||
        value.reads.join(",") !== "issues.catalog,issues.byNumber")
      fail("INVALID_SPEC", phase);
  } else {
    if (value.method !== "PATCH" || identity.strategy !== "issue_number" ||
        !(positive(identity.number) || ref(identity.number, logicalId)) ||
        value.reads.join(",") !== "issues.byNumber,issues.catalog" ||
        !(positive(identity.number) && value.path === base + "/" + identity.number ||
          ref(identity.number, logicalId) && Array.isArray(value.path) &&
          value.path.length === 2 && value.path[0] === base + "/" &&
          ref(value.path[1], logicalId))) fail("INVALID_SPEC", phase);
  }
  if (identity.strategy !== "unique_issue_marker" && identity.strategy !== "issue_number")
    fail("INVALID_SPEC", phase);
  const marker = identity.marker;
  if (typeof marker !== "string" || !marker.trim() || marker.length > 512 ||
      /[\r\n\0]/.test(marker)) fail("INVALID_SPEC", phase);
  const custom = marker !== "<!-- gh-plan:" + logicalId + " -->";
  const seen = new Set<string>();
  for (const p of value.predicates) {
    if (!record(p) || !["title", "body", "state", "milestone"].includes(p.field) ||
        seen.has(p.field)) fail("INVALID_SPEC", phase);
    seen.add(p.field);
    const { field, comparison, expected } = p as ApplyFieldPredicate;
    if (field === "title" &&
        (comparison !== "exact" || typeof expected !== "string" || !expected.trim()) ||
        field === "body" && (comparison !== "exact" ||
          typeof expected !== "string" || !markerMatches(expected, marker, custom)) ||
        field === "state" && (comparison !== "exact" ||
          (expected !== "open" && expected !== "closed")) ||
        field === "milestone" && (expected === null
          ? create || comparison !== "null"
          : comparison !== "exact" ||
            !(positive(expected) ||
              record(expected) && Object.keys(expected).length === 1 &&
                typeof expected.$ref === "string" &&
                /^[A-Za-z0-9][A-Za-z0-9._:/-]*\.number$/.test(expected.$ref))))
      fail("INVALID_SPEC", phase);
  }
  if (create && (!seen.has("title") || !seen.has("body") ||
      value.predicates.find((p) => p.field === "state")?.expected !== "open"))
    fail("INVALID_SPEC", phase);
  return value as IssueDescriptor;
}
interface Resolved {
  spec: IssueDescriptor;
  marker: string;
  custom: boolean;
  number?: number;
  expected: readonly ApplyFieldPredicate[];
  identityHint?: Partial<IssueIdentity>;
}
function resolve(spec: IssueDescriptor, context: IssueReadContext | undefined,
  phase: IssueReadPhase): Resolved {
  if (context !== undefined && !record(context)) fail("INVALID_SPEC", phase);
  if (context?.bindings !== undefined && !record(context.bindings))
    fail("INVALID_SPEC", phase);
  const binding = (value: PlanValueRef): number => {
    const [logicalId] = value.$ref.split(".number");
    const bindings: Readonly<PlanBindings> | undefined = context?.bindings;
    const actual = bindings ? bindings[logicalId!]?.number : undefined;
    if (!positive(actual)) return fail("INVALID_SPEC", phase);
    return actual;
  };
  const expected = spec.predicates.map((p) => {
    if (p.field === "milestone" && record(p.expected)) {
      const resolved = binding(p.expected as PlanValueRef);
      return Object.freeze({ ...p, expected: resolved });
    }
    return Object.freeze({ ...p });
  });
  const n = spec.identity.strategy === "issue_number"
    ? positive(spec.identity.number) ? spec.identity.number : binding(spec.identity.number)
    : undefined;
  const claim = context?.expectedIdentity === undefined ? undefined :
    identityClaim(context.expectedIdentity, phase, true);
  if (n !== undefined && claim?.number !== undefined && claim.number !== n)
    fail("IDENTITY_MISMATCH", phase);
  const id = spec.stepId.slice(spec.kind.length + 1);
  return { spec, marker: spec.identity.marker, custom:
    spec.identity.marker !== "<!-- gh-plan:" + id + " -->",
    ...(n === undefined ? {} : { number: n }), expected,
    ...(claim === undefined ? {} : { identityHint: claim }),
  };
}
function mapIssue(input: unknown, phase: IssueReadPhase): IssueSnapshot {
  if (!record(input) || input.pull_request !== undefined ||
      !positive(input.number) || !positive(input.id) ||
      typeof input.node_id !== "string" || !input.node_id ||
      typeof input.title !== "string" || !input.title.trim() ||
      input.body !== null && typeof input.body !== "string" ||
      input.state !== "open" && input.state !== "closed" ||
      !Object.hasOwn(input, "milestone")) fail("INVALID_RESPONSE", phase);
  let milestoneNumber: number | null = null;
  if (input.milestone !== null) {
    if (!record(input.milestone) || !positive(input.milestone.number))
      fail("INVALID_RESPONSE", phase);
    milestoneNumber = input.milestone.number;
  }
  return Object.freeze({
    number: input.number, id: input.id, nodeId: input.node_id,
    title: input.title, body: input.body, state: input.state, milestoneNumber,
  } as IssueSnapshot);
}
function fieldsSame(a: IssueSnapshot, b: IssueSnapshot): boolean {
  return a.title === b.title && a.body === b.body &&
    a.state === b.state && a.milestoneNumber === b.milestoneNumber;
}
function satisfied(checked: Resolved, observed: IssueSnapshot): boolean {
  return checked.expected.every(({ field, expected }) => {
    if (field === "title") return observed.title === expected;
    if (field === "body") return observed.body === expected;
    if (field === "state") return observed.state === expected;
    if (field === "milestone") return observed.milestoneNumber === expected;
    return false;
  });
}
function preserved(checked: Resolved, before: IssueSnapshot, after: IssueSnapshot): boolean {
  const fields = new Set(checked.expected.map((p) => p.field));
  return (fields.has("title") || before.title === after.title) &&
    (fields.has("body") || before.body === after.body) &&
    (fields.has("state") || before.state === after.state) &&
    (fields.has("milestone") || before.milestoneNumber === after.milestoneNumber);
}
function statusCode(status: number, headers: FetchResponseLike["headers"]): IssueReadErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 429 || status === 403 &&
      (headers.get("retry-after") !== null || headers.get("x-ratelimit-remaining") === "0"))
    return "RATE_LIMITED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND"; // Hidden 404 is not evidence of absence.
  return "READ_FAILED";
}
function nextPage(link: string | null, path: string, page: number,
  phase: IssueReadPhase): string | undefined {
  if (link === null || link === "") return undefined;
  const next = link.split(",").filter((p) => /rel\s*=\s*"?next"?/i.test(p));
  if (!next.length) return undefined;
  if (next.length !== 1) fail("INCOMPLETE_CATALOG", phase);
  const match = /^\s*<([^<>]+)>\s*;\s*rel\s*=\s*"?next"?\s*$/i.exec(next[0]!);
  if (!match) fail("INCOMPLETE_CATALOG", phase);
  let parsed: URL;
  try { parsed = new URL(match[1]!); }
  catch { return fail("INCOMPLETE_CATALOG", phase); }
  const params = parsed.searchParams;
  const keys = [...params.keys()];
  if (parsed.origin !== ORIGIN || parsed.pathname !== path ||
      parsed.username || parsed.password || parsed.hash ||
      keys.length !== 3 || new Set(keys).size !== 3 ||
      params.get("state") !== "all" || params.get("per_page") !== "100" ||
      params.get("page") !== String(page + 1))
    fail("INCOMPLETE_CATALOG", phase);
  return parsed.toString();
}
export function createRestIssuePostconditionReader(
  options: IssueReadTransportOptions,
): IssuePostconditionReader {
  if (!options || typeof options.auth !== "string" || !options.auth.trim() ||
      options.fetch !== undefined && typeof options.fetch !== "function")
    throw new IssueReadError("INVALID_SPEC", "before");
  const fetcher: FetchLike = options.fetch ?? globalThis.fetch as FetchLike;
  if (typeof fetcher !== "function") throw new IssueReadError("READ_FAILED", "before");

  async function get(url: string, phase: IssueReadPhase):
    Promise<{ data: unknown; link: string | null }> {
    let response: FetchResponseLike;
    try {
      response = await fetcher(url, { method: "GET", redirect: "error", headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + options.auth,
        "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
      } });
    } catch { return fail("READ_FAILED", phase); }
    if (!response || typeof response.status !== "number" || !response.headers ||
        typeof response.headers.get !== "function") fail("INVALID_RESPONSE", phase);
    if (response.url && response.url !== url) fail("READ_FAILED", phase);
    if (response.status !== 200) fail(statusCode(response.status, response.headers), phase);
    let data: unknown, link: string | null;
    try {
      data = await response.json();
      link = response.headers.get("link");
      if (link !== null && typeof link !== "string") fail("INVALID_RESPONSE", phase);
    } catch { return fail("INVALID_RESPONSE", phase); }
    return { data, link };
  }
  const checkedBefore = new WeakMap<IssueBeforeRead, {
    fingerprint: string; resolved: Resolved; snapshot?: IssueSnapshot;
  }>();
  async function catalog(item: Resolved, phase: IssueReadPhase): Promise<IssueSnapshot[]> {
    const base = "/repos/" + item.spec.repository + "/issues";
    let url: string | undefined = ORIGIN + base + "?state=all&per_page=100";
    let page = 1;
    const result: IssueSnapshot[] = [];
    const seenNumbers = new Set<number>(), seenIds = new Set<number>();
    const seenNodes = new Set<string>();
    while (url !== undefined) {
      if (page > MAX_PAGES) fail("INCOMPLETE_CATALOG", phase);
      const res = await get(url, phase);
      if (!Array.isArray(res.data) || res.data.length > 100)
        fail("INCOMPLETE_CATALOG", phase);
      for (const entry of res.data) {
        if (!record(entry) || !positive(entry.number) || !positive(entry.id) ||
            typeof entry.node_id !== "string" || !entry.node_id)
          fail("INVALID_RESPONSE", phase);
        if (seenNumbers.has(entry.number) || seenIds.has(entry.id) ||
            seenNodes.has(entry.node_id))
          fail("INCOMPLETE_CATALOG", phase);
        seenNumbers.add(entry.number); seenIds.add(entry.id); seenNodes.add(entry.node_id);
        if (entry.pull_request !== undefined) {
          if (!record(entry.pull_request)) fail("INVALID_RESPONSE", phase);
          continue; // GitHub's /issues listing includes PRs; they cannot own issue markers.
        }
        result.push(mapIssue(entry, phase));
      }
      url = nextPage(res.link, base, page, phase);
      if (url !== undefined && res.data.length === 0)
        fail("INCOMPLETE_CATALOG", phase);
      page++;
    }
    return result;
  }
  async function detail(item: Resolved, number: number, phase: IssueReadPhase):
    Promise<IssueSnapshot> {
    const response = await get(ORIGIN + "/repos/" + item.spec.repository +
      "/issues/" + number, phase);
    if (response.link) fail("INVALID_RESPONSE", phase);
    const observed = mapIssue(response.data, phase);
    if (observed.number !== number) fail("IDENTITY_MISMATCH", phase);
    return observed;
  }
  async function verify(item: Resolved, phase: IssueReadPhase):
    Promise<IssueSnapshot | undefined> {
    const all = await catalog(item, phase);
    const matches = all.filter((issue) =>
      markerMatches(issue.body, item.marker, item.custom));
    if (matches.length > 1) fail("AMBIGUOUS_MARKER", phase);
    const byMarker = matches[0];
    if (item.spec.kind === "issue.create") {
      if (!byMarker) return undefined;
      const found = await detail(item, byMarker.number, phase);
      if (!sameId(byMarker, found) || !fieldsSame(byMarker, found) ||
          !markerMatches(found.body, item.marker, item.custom))
        fail("IDENTITY_MISMATCH", phase);
      return found;
    }
    if (item.number === undefined) fail("INVALID_SPEC", phase);
    const observed = await detail(item, item.number, phase);
    if (!markerMatches(observed.body, item.marker, item.custom) ||
        !byMarker || !sameId(byMarker, observed) || !fieldsSame(byMarker, observed))
      fail("IDENTITY_MISMATCH", phase);
    if (item.identityHint && !claimMatches(observed, item.identityHint))
      fail("IDENTITY_MISMATCH", phase);
    return observed;
  }
  function fingerprint(spec: IssueDescriptor): string {
    return JSON.stringify(spec);
  }
  async function doBefore(spec: ApplyPostconditionSpec, context?: IssueReadContext):
    Promise<IssueBeforeRead> {
    const checked = resolve(checkedSpec(spec, "before"), context, "before");
    const found = await verify(checked, "before");
    if (found && checked.identityHint && !claimMatches(found, checked.identityHint))
      fail("IDENTITY_MISMATCH", "before");
    if (spec.kind === "issue.create" && found && !satisfied(checked, found))
      fail("POSTCONDITION_MISMATCH", "before"); // Marker exists; never blind POST.
    const result: IssueBeforeRead = Object.freeze({
      status: found && satisfied(checked, found) ? "satisfied" : "unsatisfied",
      ...(found === undefined ? {} : { snapshot: found }),
    });
    checkedBefore.set(result, {
      fingerprint: fingerprint(checked.spec), resolved: checked,
      ...(found === undefined ? {} : { snapshot: found }),
    });
    return result;
  }
  async function doAfter(spec: ApplyPostconditionSpec, before: IssueBeforeRead,
    responseIdentity?: unknown): Promise<IssueAfterRead> {
    const checked = checkedSpec(spec, "after");
    const proof = checkedBefore.get(before);
    if (!proof || proof.fingerprint !== fingerprint(checked) ||
        checked.kind === "issue.update" && !proof.snapshot)
      fail("INVALID_SPEC", "after");
    const found = await verify(proof.resolved, "after");
    if (!found) fail("INDETERMINATE_WRITE", "after");
    if (proof.snapshot && !sameId(proof.snapshot, found))
      fail("IDENTITY_MISMATCH", "after");
    if (proof.snapshot && checked.kind === "issue.update" &&
        !preserved(proof.resolved, proof.snapshot, found))
      fail("POSTCONDITION_MISMATCH", "after");
    if (responseIdentity !== undefined &&
        !claimMatches(found, identityClaim(responseIdentity, "after", false)))
      fail("IDENTITY_MISMATCH", "after");
    if (!satisfied(proof.resolved, found))
      fail("POSTCONDITION_MISMATCH", "after");
    return Object.freeze({
      status: "satisfied" as const, snapshot: found,
      identity: Object.freeze({
        number: found.number, id: found.id, nodeId: found.nodeId,
      }),
    });
  }
  // A malformed plan/transport result may contain getters/cycles. Keep errors
  // closed and remove arbitrary callback/exception text from the API boundary.
  async function safe<T>(phase: IssueReadPhase, action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof IssueReadError) throw error;
      return fail("INVALID_RESPONSE", phase);
    }
  }
  return {
    readBefore(spec, context) {
      return safe("before", () => doBefore(spec, context));
    },
    readAfter(spec, before, responseIdentity) {
      return safe("after", () => doAfter(spec, before, responseIdentity));
    },
  };
}
