import { fromGithubMilestoneDueOn } from "./milestone-due-date.ts";
import type {
  FetchLike,
  DesiredProjectReference,
  FetchResponseLike,
  DesiredPullRequestResource,
  GithubDiscoveryTransport,
  GithubStateSnapshot,
  JsonValue,
  NormalizedDesiredStateGraph,
  ObservedIssue,
  ObservedProject,
  ObservedProjectField,
  ObservedProjectItem,
  ObservedPullRequest,
  PullRequestBranchCheck,
  ObservedIssueField,
  ObservedLabel,
  ObservedIssueFieldOption,
  ObservedIssueType,
  ObservedMilestone,
  RepositoryRef,
} from "./types.ts";

const API_BASE = "https://api.github.com";
const API_VERSION = "2026-03-10";

/** Stable GET discovery failure codes. Authentication, permission, rate limit,
 * unsafe pagination and malformed HTTP responses are differentiated. */
export type GithubRestTransportErrorCode =
  | "NO_REST_TRANSPORT"
  | "AUTH_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_RESPONSE"
  | "PAGINATION_CYCLE"
  | "UNSAFE_PAGINATION_URL"
  | "REST_FAILURE";

/** Sanitized transport error data: method/path/status only, never credentials. */
export interface GithubRestTransportErrorData {
  code: GithubRestTransportErrorCode;
  method: "GET";
  path: string;
  status?: number;
  statusText?: string;
}

/**
 * Typed exception from the read-only transport. The planner maps expected
 * failures to blockers, without copying response bodies or bearer tokens.
 * Direct transport consumers may catch this error and inspect code/status.
 */
export class GithubRestTransportError extends Error {
  readonly code: GithubRestTransportErrorCode;
  readonly method = "GET" as const;
  readonly path: string;
  readonly status?: number;
  readonly statusText?: string;

  constructor(
    code: GithubRestTransportErrorCode,
    path: string,
    options: { status?: number; statusText?: string } = {},
  ) {
    const statusSuffix = options.status === undefined ? "" : ` (${options.status})`;
    super(`GitHub REST ${code}${statusSuffix}.`);
    this.name = "GithubRestTransportError";
    this.code = code;
    this.path = path;
    this.status = options.status;
    this.statusText = options.statusText;
  }

  toJSON(): GithubRestTransportErrorData {
    return {
      code: this.code,
      method: this.method,
      path: this.path,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.statusText === undefined ? {} : { statusText: this.statusText }),
    };
  }
}

/** Runtime-only REST transport options; bearer auth is not stored in snapshots.
 * An injected fetch can intercept GET requests for deterministic tests. */
export interface RestDiscoveryTransportConfig {
  /** Bearer credential used exclusively in outgoing GET headers. */
  auth: string;
  /** Optional injected GET reader; otherwise uses globalThis.fetch. */
  fetch?: FetchLike;
  /** Maximum concurrent issue enrichments (default 4). */
  enrichConcurrency?: number;
}

type RecordLike = Record<string, unknown>;

interface GithubRestClient {
  getJson<T>(pathOrUrl: string): Promise<T>;
  getJsonOptional404<T>(pathOrUrl: string): Promise<T | undefined>;
  getPaginated<T>(pathOrUrl: string): Promise<T[]>;
  isAssigneeEligible(path: string): Promise<boolean>;
}

interface JsonResponse<T> {
  data: T;
  response: FetchResponseLike;
}

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function safePath(urlOrPath: string): string {
  if (urlOrPath.startsWith(API_BASE)) {
    const stripped = urlOrPath.slice(API_BASE.length);
    return stripped.length > 0 ? stripped : "/";
  }
  return urlOrPath;
}

function apiUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("/")) return `${API_BASE}${pathOrUrl}`;
  if (pathOrUrl.startsWith(`${API_BASE}/`)) return pathOrUrl;
  throw new GithubRestTransportError("UNSAFE_PAGINATION_URL", "/<unsafe-pagination-url>");
}

function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected;
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new GithubRestTransportError("NO_REST_TRANSPORT", "/");
  }
  return candidate as FetchLike;
}

function classifyHttpFailure(response: FetchResponseLike): GithubRestTransportErrorCode {
  if (response.status === 401) return "AUTH_FAILED";
  if (response.status === 429) return "RATE_LIMITED";
  if (response.status === 403) {
    if (
      response.headers.get("x-ratelimit-remaining") === "0"
      || response.headers.get("retry-after") !== null
    ) {
      return "RATE_LIMITED";
    }
    return "FORBIDDEN";
  }
  if (response.status === 404) return "NOT_FOUND";
  return "REST_FAILURE";
}

function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel=(?:"next"|next)/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function createRestClient(auth: string, fetch: FetchLike): GithubRestClient {
  async function requestJson<T>(pathOrUrl: string, allow404 = false): Promise<JsonResponse<T> | undefined> {
    const url = apiUrl(pathOrUrl);
    let response: FetchResponseLike;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${auth}`,
          "X-GitHub-Api-Version": API_VERSION,
        },
      });
    } catch {
      throw new GithubRestTransportError("REST_FAILURE", safePath(url));
    }

    if (!response.ok) {
      if (allow404 && response.status === 404) return undefined;
      throw new GithubRestTransportError(
        classifyHttpFailure(response),
        safePath(url),
        { status: response.status, statusText: response.statusText },
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GithubRestTransportError(
        "INVALID_RESPONSE",
        safePath(url),
        { status: response.status, statusText: response.statusText },
      );
    }
    return { data: data as T, response };
  }

  return {
    async isAssigneeEligible(path: string): Promise<boolean> {
      const url = apiUrl(path);
      let response: FetchResponseLike;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${auth}`,
            "X-GitHub-Api-Version": API_VERSION,
          },
        });
      } catch {
        throw new GithubRestTransportError("REST_FAILURE", safePath(url));
      }
      // GitHub returns 204 without a JSON body on success, 404 if ineligible.
      if (response.status === 204) return true;
      if (response.status === 404) return false;
      if (!response.ok) throw new GithubRestTransportError(
        classifyHttpFailure(response), safePath(url),
        { status: response.status, statusText: response.statusText },
      );
      throw new GithubRestTransportError("INVALID_RESPONSE", safePath(url),
        { status: response.status, statusText: response.statusText });
    },

    async getJson<T>(pathOrUrl: string): Promise<T> {
      const result = await requestJson<T>(pathOrUrl);
      if (!result) throw new GithubRestTransportError("NOT_FOUND", safePath(pathOrUrl), { status: 404 });
      return result.data;
    },

    async getJsonOptional404<T>(pathOrUrl: string): Promise<T | undefined> {
      return (await requestJson<T>(pathOrUrl, true))?.data;
    },

    async getPaginated<T>(pathOrUrl: string): Promise<T[]> {
      const items: T[] = [];
      let current: string | undefined = pathOrUrl;
      const visited = new Set<string>();

      while (current) {
        const url = apiUrl(current);
        if (visited.has(url)) {
          throw new GithubRestTransportError("PAGINATION_CYCLE", safePath(url));
        }
        visited.add(url);

        const page = await requestJson<unknown>(url);
        if (!page || !Array.isArray(page.data)) {
          throw new GithubRestTransportError(
            "INVALID_RESPONSE",
            safePath(url),
            page ? { status: page.response.status, statusText: page.response.statusText } : {},
          );
        }
        items.push(...page.data as T[]);
        current = nextLink(page.response.headers.get("link"));
      }

      return items;
    },
  };
}

function invalidResponse(path: string): never {
  throw new GithubRestTransportError("INVALID_RESPONSE", path);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") invalidResponse(path);
  return value;
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidResponse(path);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalidResponse(path);
  return value;
}

function splitRepository(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1 || fullName.indexOf("/", slash + 1) !== -1) {
    throw new GithubRestTransportError("INVALID_RESPONSE", "/repository");
  }
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

function sortByNameThenId<T extends { name: string; id?: string | number }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

function mapRepository(raw: unknown): { repository: RepositoryRef; ownerType: string } {
  if (!isRecord(raw)) invalidResponse("/repository");
  const fullName = requiredString(raw.full_name, "/repository.full_name");
  const id = requiredNumber(raw.id, "/repository.id");
  const owner = raw.owner;
  if (!isRecord(owner)) invalidResponse("/repository.owner");
  const ownerType = requiredString(owner.type, "/repository.owner.type");
  const nodeId = optionalString(raw.node_id, "/repository.node_id");
  return {
    repository: {
      fullName,
      id,
      ...(nodeId === undefined ? {} : { nodeId }),
    },
    ownerType,
  };
}

/** A PR is an issue entry in the broad list but not an ordinary issue mutation target. */
function mapPullRequestIssueNumber(raw: unknown): number | undefined {
  if (!isRecord(raw)) invalidResponse("/issues");
  if (raw.pull_request === undefined) return undefined;
  if (!isRecord(raw.pull_request)) invalidResponse("/issues.pull_request");
  return requiredNumber(raw.number, "/issues.pull_request.number");
}

/** Convert targeted GET /pulls/{number} response to a complete PR snapshot. */
function mapPullRequest(raw: unknown): ObservedPullRequest {
  if (!isRecord(raw)) invalidResponse("/pulls");
  const number = requiredNumber(raw.number, "/pulls.number");
  const id = requiredNumber(raw.id, "/pulls.id");
  const state = raw.state;
  if (state !== "open" && state !== "closed") invalidResponse("/pulls.state");
  if (typeof raw.draft !== "boolean") invalidResponse("/pulls.draft");
  if (!isRecord(raw.head) || !isRecord(raw.base)) invalidResponse("/pulls.head-base");
  const head = requiredString(raw.head.ref, "/pulls.head.ref");
  const base = requiredString(raw.base.ref, "/pulls.base.ref");
  const parseLogins = (list: unknown, key: string): string[] => {
    if (!Array.isArray(list)) invalidResponse("/pulls." + key);
    return list.map((entry, i) => {
      if (!isRecord(entry)) invalidResponse("/pulls." + key + "." + i);
      return requiredString(entry.login, "/pulls." + key + ".login");
    }).sort((a, b) => a.localeCompare(b));
  };
  if (!Array.isArray(raw.labels)) invalidResponse("/pulls.labels");
  const labels = raw.labels.map((x, i) => {
    if (!isRecord(x)) invalidResponse("/pulls.labels." + i);
    return requiredString(x.name, "/pulls.labels.name");
  }).sort((a, b) => a.localeCompare(b));
  const body = raw.body;
  if (body !== undefined && body !== null && typeof body !== "string") invalidResponse("/pulls.body");
  const nodeId = optionalString(raw.node_id, "/pulls.node_id");
  return {
    kind: "pull_request", number, id,
    ...(nodeId === undefined ? {} : { nodeId }),
    title: requiredString(raw.title, "/pulls.title"),
    ...(body === undefined ? {} : { body: body as string | null }),
    state, head, base, draft: raw.draft,
    merged: raw.merged === true || raw.merged_at != null,
    labels, assignees: parseLogins(raw.assignees, "assignees"),
    requestedReviewers: parseLogins(raw.requested_reviewers ?? [], "requested_reviewers"),
  };
}

function mapIssue(raw: unknown): ObservedIssue | undefined {
  if (!isRecord(raw)) invalidResponse("/issues");
  if (raw.pull_request !== undefined) return undefined;
  const number = requiredNumber(raw.number, "/issues.number");
  const id = requiredNumber(raw.id, `/issues/${number}.id`);
  const title = requiredString(raw.title, `/issues/${number}.title`);
  const state = raw.state;
  if (state !== "open" && state !== "closed") invalidResponse(`/issues/${number}.state`);
  const body = raw.body;
  if (body !== undefined && body !== null && typeof body !== "string") invalidResponse(`/issues/${number}.body`);

  let milestoneNumber: number | null = null;
  if (raw.milestone !== undefined && raw.milestone !== null) {
    if (!isRecord(raw.milestone)) invalidResponse(`/issues/${number}.milestone`);
    milestoneNumber = requiredNumber(raw.milestone.number, `/issues/${number}.milestone.number`);
  }

  let issueType: string | null = null;
  if (raw.type !== undefined && raw.type !== null) {
    if (!isRecord(raw.type)) invalidResponse(`/issues/${number}.type`);
    issueType = requiredString(raw.type.name, `/issues/${number}.type.name`);
  }

  let labels: string[] | undefined;
  if (raw.labels !== undefined) {
    if (!Array.isArray(raw.labels)) invalidResponse("/issues/" + number + ".labels");
    labels = raw.labels.map((label, index) => {
      if (!isRecord(label)) invalidResponse("/issues/" + number + ".labels[" + index + "]");
      return requiredString(label.name, "/issues/" + number + ".labels[" + index + "].name");
    }).sort((a, b) => a.localeCompare(b));
  }
  let assignees: string[] | undefined;
  if (raw.assignees !== undefined) {
    if (!Array.isArray(raw.assignees)) invalidResponse("/issues/" + number + ".assignees");
    const logins = raw.assignees.map((assignee, index) => {
      if (!isRecord(assignee)) invalidResponse("/issues/" + number + ".assignees[" + index + "]");
      return requiredString(assignee.login, "/issues/" + number + ".assignees[" + index + "].login");
    });
    if (new Set(logins.map((login) => login.toLowerCase())).size !== logins.length)
      invalidResponse("/issues/" + number + ".assignees");
    assignees = logins.sort((a, b) => a.localeCompare(b));
  }
  const nodeId = optionalString(raw.node_id, `/issues/${number}.node_id`);
  return {
    kind: "issue",
    number,
    id,
    ...(nodeId === undefined ? {} : { nodeId }),
    title,
    body: body as string | null | undefined,
    state,
    milestoneNumber,
    issueType,
    ...(labels === undefined ? {} : { labels }),
    ...(assignees === undefined ? {} : { assignees }),
  };
}

function mapLabel(raw: unknown): ObservedLabel {
  if (!isRecord(raw)) invalidResponse("/labels");
  const name = requiredString(raw.name, "/labels.name");
  const id = raw.id === undefined ? undefined : requiredNumber(raw.id, "/labels.id");
  const color = optionalString(raw.color, "/labels.color");
  const description = raw.description;
  if (description !== undefined && description !== null && typeof description !== "string")
    invalidResponse("/labels.description");
  return { name, ...(id === undefined ? {} : { id }),
    ...(color === undefined ? {} : { color }),
    ...(description === undefined ? {} : { description: description as string | null }) };
}

function mapMilestone(raw: unknown): ObservedMilestone {
  if (!isRecord(raw)) invalidResponse("/milestones");
  const number = requiredNumber(raw.number, "/milestones.number");
  const title = requiredString(raw.title, `/milestones/${number}.title`);
  const state = raw.state;
  if (state !== "open" && state !== "closed") invalidResponse(`/milestones/${number}.state`);
  const description = raw.description;
  if (description !== undefined && description !== null && typeof description !== "string") {
    invalidResponse(`/milestones/${number}.description`);
  }
  const dueOn = raw.due_on;
  if (dueOn !== undefined && dueOn !== null && fromGithubMilestoneDueOn(dueOn) === undefined) {
    invalidResponse(`/milestones/${number}.due_on`);
  }
  const id = raw.id === undefined ? undefined : requiredNumber(raw.id, `/milestones/${number}.id`);
  const nodeId = optionalString(raw.node_id, `/milestones/${number}.node_id`);
  return {
    kind: "milestone",
    number,
    ...(id === undefined ? {} : { id }),
    ...(nodeId === undefined ? {} : { nodeId }),
    title,
    description: description as string | null | undefined,
    state,
    ...(dueOn === undefined ? {} : { due_on: dueOn as string | null }),
  };
}

function mapIssueType(raw: unknown): ObservedIssueType {
  if (!isRecord(raw)) invalidResponse("/issue-types");
  const name = requiredString(raw.name, "/issue-types.name");
  const id = raw.id === undefined ? undefined : requiredNumber(raw.id, `/issue-types/${name}.id`);
  const nodeId = optionalString(raw.node_id, `/issue-types/${name}.node_id`);
  return {
    ...(id === undefined ? {} : { id }),
    ...(nodeId === undefined ? {} : { nodeId }),
    name,
  };
}

function mapFieldOption(raw: unknown, path: string): ObservedIssueFieldOption {
  if (!isRecord(raw)) invalidResponse(path);
  const idRaw = raw.id;
  if (typeof idRaw !== "number" && typeof idRaw !== "string") invalidResponse(`${path}.id`);
  return {
    id: idRaw,
    name: requiredString(raw.name, `${path}.name`),
  };
}

function mapIssueField(raw: unknown): ObservedIssueField {
  if (!isRecord(raw)) invalidResponse("/issue-fields");
  const idRaw = raw.id;
  if (typeof idRaw !== "number" && typeof idRaw !== "string") invalidResponse("/issue-fields.id");
  const name = requiredString(raw.name, "/issue-fields.name");
  const dataType = optionalString(raw.data_type, `/issue-fields/${name}.data_type`);
  let options: ObservedIssueFieldOption[] | undefined;
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) invalidResponse(`/issue-fields/${name}.options`);
    options = sortByNameThenId(
      raw.options.map((option, index) => mapFieldOption(option, `/issue-fields/${name}.options/${index}`)),
    );
  }
  return {
    id: idRaw,
    name,
    ...(dataType === undefined ? {} : { dataType }),
    ...(options === undefined ? {} : { options }),
  };
}

function mapIssueFieldValue(raw: unknown): { name: string; value: JsonValue } {
  if (!isRecord(raw)) invalidResponse("/issue-field-values");
  const name = requiredString(raw.issue_field_name, "/issue-field-values.issue_field_name");
  const dataType = requiredString(raw.data_type, `/issue-field-values/${name}.data_type`);

  if (dataType === "single_select" && isRecord(raw.single_select_option)) {
    return { name, value: requiredString(raw.single_select_option.name, `/issue-field-values/${name}.single_select_option.name`) };
  }

  if (dataType === "multi_select" && Array.isArray(raw.multi_select_options)) {
    const names = raw.multi_select_options.map((option, index) => {
      if (!isRecord(option)) invalidResponse(`/issue-field-values/${name}.multi_select_options/${index}`);
      return requiredString(option.name, `/issue-field-values/${name}.multi_select_options/${index}.name`);
    }).sort((a, b) => a.localeCompare(b));
    return { name, value: names };
  }

  if (!isJsonValue(raw.value)) invalidResponse(`/issue-field-values/${name}.value`);
  return { name, value: raw.value };
}

async function enrichIssue(
  issue: ObservedIssue,
  client: GithubRestClient,
  repoPath: string,
  includeFields: boolean,
): Promise<ObservedIssue> {
  const fields: Record<string, JsonValue> = {};
  if (includeFields) {
    const rawValues = await client.getPaginated<unknown>(
      `${repoPath}/issues/${issue.number}/issue-field-values?per_page=100`,
    );
    const values = rawValues.map(mapIssueFieldValue).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of values) fields[entry.name] = entry.value;
  }

  const parent = await client.getJsonOptional404<unknown>(`${repoPath}/issues/${issue.number}/parent`);
  let parentNumber: number | null = null;
  if (parent !== undefined) {
    if (!isRecord(parent)) invalidResponse(`${repoPath}/issues/${issue.number}/parent`);
    parentNumber = requiredNumber(parent.number, `${repoPath}/issues/${issue.number}/parent.number`);
  }

  const rawDependencies = await client.getPaginated<unknown>(
    `${repoPath}/issues/${issue.number}/dependencies/blocked_by?per_page=100`,
  );
  const blockedByNumbers = [...new Set(rawDependencies.map((dependency, index) => {
    if (!isRecord(dependency)) invalidResponse(`${repoPath}/issues/${issue.number}/dependencies/blocked_by/${index}`);
    return requiredNumber(dependency.number, `${repoPath}/issues/${issue.number}/dependencies/blocked_by/${index}.number`);
  }))].sort((a, b) => a - b);

  const rawRelations = await client.getPaginated<unknown>(
    `${repoPath}/issues/${issue.number}/relates_to?per_page=100`,
  );
  const relatesToNumbers = [...new Set(rawRelations.map((related, index) => {
    if (!isRecord(related)) invalidResponse(`${repoPath}/issues/${issue.number}/relates_to/${index}`);
    return requiredNumber(related.number, `${repoPath}/issues/${issue.number}/relates_to/${index}.number`);
  }))].sort((a, b) => a - b);

  return {
    ...issue,
    fields,
    parentNumber,
    blockedByNumbers,
    relatesToNumbers,
  };
}



/** Parse only fields and values actually returned by GitHub's Projects v2 REST list. */
function mapProjectField(raw: unknown): ObservedProjectField {
  if (!isRecord(raw)) invalidResponse("/projectsV2/fields");
  const id = requiredNumber(raw.id, "/projectsV2/fields.id");
  if (!Number.isSafeInteger(id) || id < 1) invalidResponse("/projectsV2/fields.id");
  const name = requiredString(raw.name, "/projectsV2/fields.name");
  const dataType = requiredString(raw.data_type, "/projectsV2/fields.data_type").toLowerCase();
  const parseName = (value: unknown, path: string): string => {
    if (typeof value === "string") return value;
    if (!isRecord(value)) invalidResponse(path);
    return requiredString(value.raw, path + ".raw");
  };
  const options = raw.options === undefined ? undefined :
    Array.isArray(raw.options) ? raw.options.map((v) => {
      if (!isRecord(v)) invalidResponse("/projectsV2/fields.options");
      return { id: requiredString(v.id, "/projectsV2/fields.options.id"),
        name: parseName(v.name, "/projectsV2/fields.options.name") };
    }) : invalidResponse("/projectsV2/fields.options");
  let iterations: ObservedProjectField["iterations"];
  if (raw.configuration !== undefined) {
    if (!isRecord(raw.configuration) ||
        !Array.isArray(raw.configuration.iterations)) invalidResponse("/projectsV2/fields.configuration");
    iterations = raw.configuration.iterations.map((v) => {
      if (!isRecord(v)) invalidResponse("/projectsV2/fields.iterations");
      return { id: requiredString(v.id, "/projectsV2/fields.iterations.id"),
        title: parseName(v.title, "/projectsV2/fields.iterations.title") };
    });
  }
  return { id, name, dataType, ...(options ? { options } : {}),
    ...(iterations ? { iterations } : {}) };
}

/** Project item values are requested by numeric field IDs to avoid conflating names. */
function mapProjectItem(raw: unknown, repoFullName: string): ObservedProjectItem | undefined {
  if (!isRecord(raw)) invalidResponse("/projectsV2/items");
  if (raw.content_type !== "Issue" && raw.content_type !== "PullRequest") return undefined;
  if (!isRecord(raw.content)) invalidResponse("/projectsV2/items.content");
  // Issue content exposes repository_url, but PullRequest content can identify
  // its repository through base.repo or its canonical API URL instead.
  let repositoryUrl = raw.content.repository_url;
  if (repositoryUrl === undefined && isRecord(raw.content.base) &&
      isRecord(raw.content.base.repo) &&
      typeof raw.content.base.repo.full_name === "string") {
    repositoryUrl = "https://api.github.com/repos/" + raw.content.base.repo.full_name;
  }
  if (repositoryUrl === undefined && typeof raw.content.url === "string") {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(?:pulls|issues)\/\d+$/.exec(raw.content.url);
    if (match) repositoryUrl = "https://api.github.com/repos/" + match[1];
  }
  if (typeof repositoryUrl !== "string") invalidResponse("/projectsV2/items.content.repository_url");
  const expectedRepo = "https://api.github.com/repos/" + repoFullName;
  if (repositoryUrl.toLowerCase() !== expectedRepo.toLowerCase()) return undefined;
  const id = requiredNumber(raw.id, "/projectsV2/items.id");
  const contentId = requiredNumber(raw.content.id, "/projectsV2/items.content.id");
  const contentNumber = requiredNumber(raw.content.number, "/projectsV2/items.content.number");
  if (![id, contentId, contentNumber].every((v) => Number.isSafeInteger(v) && v > 0))
    invalidResponse("/projectsV2/items.identity");
  if (!Array.isArray(raw.fields)) invalidResponse("/projectsV2/items.fields");
  const fields: ObservedProjectItem["fields"] = {};
  for (const entry of raw.fields) {
    if (!isRecord(entry)) invalidResponse("/projectsV2/items.fields");
    const id = isRecord(entry.field) ? entry.field.id : entry.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
      invalidResponse("/projectsV2/items.fields.id");
    if (Object.hasOwn(fields, String(id))) invalidResponse("/projectsV2/items.fields.duplicate");
    const value = entry.value;
    if (value !== null && typeof value !== "string" &&
        !(typeof value === "number" && Number.isFinite(value)))
      invalidResponse("/projectsV2/items.fields.value");
    fields[id] = value;
  }
  return { id, contentType: raw.content_type, contentId, contentNumber, fields };
}

/** Bounded worker pool. Results retain input order, regardless of completion order. */
async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/**
 * Create a read-only GitHub REST discovery adapter. Factory construction
 * does not perform I/O; discover() and enrich() do. Request failures reject
 * with GithubRestTransportError; invalid concurrency throws RangeError.
 * Broad discovery starts with four GETs (repo, issues, milestones, issue types),
 * then reads organization issue-field definitions and/or label catalogs if
 * needed. Collections are paginated; each selected existing issue adds parent,
 * blocked_by and relates_to GETs, plus issue-field values when available.
 * Newly assigned logins add one eligibility GET per distinct login. Reads use
 * a bounded concurrency pool (default four). No HTTP mutation is performed.
 */
/**
 * Full read-only issue catalog for M8 issue-create recovery. Requests all
 * pages of open AND closed issues, filters out pull requests, and uses the
 * existing sanitized REST/pagination and response-validation machinery.
 * Credentials are runtime-only and never included in the returned records.
 * This reader does not depend on a possibly stale planning snapshot.
 */
export function createRestIssueCatalogReader(
  config: Pick<RestDiscoveryTransportConfig, "auth" | "fetch">,
): (repositoryFullName: string) => Promise<ObservedIssue[]> {
  const client = createRestClient(config.auth, resolveFetch(config.fetch));
  return async (repositoryFullName: string): Promise<ObservedIssue[]> => {
    const [owner, repository] = splitRepository(repositoryFullName);
    const root = "/repos/" + encodeURIComponent(owner) + "/" +
      encodeURIComponent(repository);
    const raw = await client.getPaginated<unknown>(
      root + "/issues?state=all&per_page=100",
    );
    return raw.map(mapIssue)
      .filter((issue): issue is ObservedIssue => issue !== undefined)
      .sort((a, b) => a.number - b.number);
  };
}

export function createRestDiscoveryTransport(
  config: RestDiscoveryTransportConfig,
): GithubDiscoveryTransport {
  const limit = config.enrichConcurrency ?? 4;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("enrichConcurrency must be a positive safe integer.");
  }
  const fetch = resolveFetch(config.fetch);
  const client = createRestClient(config.auth, fetch);

  return {
    mode: "rest",

    async discover(desired: NormalizedDesiredStateGraph): Promise<GithubStateSnapshot> {
      const [desiredOwner, desiredRepo] = splitRepository(desired.repository.fullName);
      const rawRepository = await client.getJson<unknown>(
        `/repos/${encodeURIComponent(desiredOwner)}/${encodeURIComponent(desiredRepo)}`,
      );
      const { repository, ownerType } = mapRepository(rawRepository);
      const [owner, repo] = splitRepository(repository.fullName);
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

      const rawIssues = await client.getPaginated<unknown>(`${repoPath}/issues?state=all&per_page=100`);
      const pullRequestIssueNumbers = rawIssues
        .map(mapPullRequestIssueNumber)
        .filter((n): n is number => n !== undefined)
        .sort((a, b) => a - b);
      const issues = rawIssues
        .map(mapIssue)
        .filter((issue): issue is ObservedIssue => issue !== undefined)
        .sort((a, b) => a.number - b.number);

      const rawMilestones = await client.getPaginated<unknown>(`${repoPath}/milestones?state=all&per_page=100`);
      const milestones = rawMilestones.map(mapMilestone).sort((a, b) => a.number - b.number);

      // Some repositories return 404 for this optional endpoint; others,
      // including user-owned repositories, can return a populated 200 list.
      const rawIssueTypes = await client.getJsonOptional404<unknown>(`${repoPath}/issue-types`);
      if (rawIssueTypes !== undefined && !Array.isArray(rawIssueTypes)) {
        invalidResponse(`${repoPath}/issue-types`);
      }
      const issueTypes = sortByNameThenId((rawIssueTypes ?? []).map(mapIssueType));
      // Catalog reads are needed only when the plan explicitly manages labels.
      // This keeps unchanged discovery request counts stable for other plans.
      const needsLabels = !!desired.labels?.length ||
        !!desired.pullRequests?.some((pr) => pr.desired.labels !== undefined) || desired.resources.some((resource) =>
        resource.kind === "issue" && resource.management === "managed" &&
        resource.desired.labels !== undefined);
      const labels = needsLabels
        ? sortByNameThenId((await client.getPaginated<unknown>(
          `${repoPath}/labels?per_page=100`)).map(mapLabel)) : undefined;

      let issueFields: ObservedIssueField[] = [];
      const organizationOwned = ownerType === "Organization";
      if (organizationOwned) {
        const rawFields = await client.getJson<unknown>(`/orgs/${encodeURIComponent(owner)}/issue-fields`);
        if (!Array.isArray(rawFields)) invalidResponse(`/orgs/${owner}/issue-fields`);
        issueFields = sortByNameThenId(rawFields.map(mapIssueField));
      }

      return {
        repository,
        issues,
        ...(desired.pullRequests?.length ? { pullRequestIssueNumbers } : {}),
        milestones,
        issueTypes,
        ...(labels === undefined ? {} : { labels }),
        issueFields,
      };
    },

    /** Target only desired PR head/base pairs; never enrich unrelated PRs. */
    async enrichPullRequests(
      snapshot: GithubStateSnapshot,
      desired: DesiredPullRequestResource[],
    ): Promise<GithubStateSnapshot> {
      if (!desired.length) return snapshot;
      const [owner, repo] = splitRepository(snapshot.repository.fullName);
      const basePath = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);
      const seen = new Map<number, ObservedPullRequest>();
      const checks: Record<string, PullRequestBranchCheck> = {};
      const candidateIssues = new Set(snapshot.pullRequestIssueNumbers ?? []);
      const candidates = await mapBounded([...desired].sort((a, b) =>
        a.logicalId.localeCompare(b.logicalId)), limit, async (pr) => {
        const number = pr.identity?.number;
        if (number !== undefined) return candidateIssues.has(number) ? [number] : [];
        // A filtered open pair query is bounded by the requested head and base;
        // this avoids GET /pulls/{number} calls for unrelated PR issue entries.
        const query = basePath + "/pulls?state=open&head=" +
          encodeURIComponent(owner + ":" + pr.head) + "&base=" +
          encodeURIComponent(pr.base) + "&per_page=100";
        const list = await client.getPaginated<unknown>(query);
        return list.map((item) => {
          if (!isRecord(item)) invalidResponse(query);
          const id = requiredNumber(item.number, query + ".number");
          return id;
        }).filter((id) => candidateIssues.has(id));
      });
      const numbers = [...new Set(candidates.flat())].sort((a, b) => a - b);
      const detailed = await mapBounded(numbers, limit, async (number) => {
        const raw = await client.getJson<unknown>(basePath + "/pulls/" + number);
        const pull = mapPullRequest(raw);
        if (pull.number !== number) invalidResponse(basePath + "/pulls/" + number);
        const requested = await client.getJson<unknown>(
          basePath + "/pulls/" + number + "/requested_reviewers");
        if (!isRecord(requested) || !Array.isArray(requested.users))
          invalidResponse(basePath + "/pulls/" + number + "/requested_reviewers");
        const people = requested.users.map((u, index) => {
          if (!isRecord(u)) invalidResponse("/pulls/requested_reviewers/" + index);
          return requiredString(u.login, "/pulls/requested_reviewers.login");
        }).sort((a, b) => a.localeCompare(b));
        return { ...pull, requestedReviewers: people };
      });
      for (const p of detailed) seen.set(p.number, p);
      for (let i = 0; i < desired.length; i++) {
        // Request checks for new head/base pairs only. Existing explicit PRs may
        // change base; GitHub validates any new base through PATCH on execution.
        const pr = desired[i]!;
        const matches = [...seen.values()].filter((item) =>
          pr.identity?.number !== undefined ? item.number === pr.identity.number :
          item.state === "open" && item.head === pr.head && item.base === pr.base);
        if (matches.length) continue;
        const prefix = basePath + "/git/ref/heads/";
        const [headRef, baseRef] = await Promise.all([
          client.getJsonOptional404<unknown>(prefix + encodeURIComponent(pr.head)),
          client.getJsonOptional404<unknown>(prefix + encodeURIComponent(pr.base)),
        ]);
        let differs = false;
        if (headRef !== undefined && baseRef !== undefined && pr.head !== pr.base) {
          const raw = await client.getJsonOptional404<unknown>(
            basePath + "/compare/" + encodeURIComponent(pr.base) + "..." +
              encodeURIComponent(pr.head));
          if (raw !== undefined) {
            if (!isRecord(raw) || typeof raw.ahead_by !== "number")
              invalidResponse("/compare/branch");
            differs = raw.ahead_by > 0;
          }
        }
        checks[pr.logicalId] = {
          headExists: headRef !== undefined,
          baseExists: baseRef !== undefined,
          differs,
        };
      }
      return {
        ...snapshot,
        pullRequests: [...seen.values()].sort((a, b) => a.number - b.number),
        pullRequestBranchChecks: checks,
      };
    },


    /** Read existing Projects v2 only; no project, field or item mutation. */
    async enrichProjects(
      snapshot: GithubStateSnapshot,
      desired: NormalizedDesiredStateGraph,
    ): Promise<GithubStateSnapshot> {
      const references = [...(desired.projects ?? [])].sort((a, b) =>
        a.logicalId.localeCompare(b.logicalId));
      if (!references.length) return snapshot;
      const boards = await mapBounded(references, limit, async (ref: DesiredProjectReference) => {
        const root = "/" + (ref.ownerType === "user" ? "users" : "orgs") + "/" +
          encodeURIComponent(ref.owner) + "/projectsV2/" + ref.number;
        const project = await client.getJsonOptional404<unknown>(root);
        if (project === undefined) return {
          logicalId: ref.logicalId, owner: ref.owner, number: ref.number,
          ownerType: ref.ownerType, missing: true, fields: [], items: [],
        } satisfies ObservedProject;
        if (!isRecord(project) || project.number !== ref.number) invalidResponse(root);
        const rawFields = await client.getPaginated<unknown>(root + "/fields?per_page=100");
        const fields = rawFields.map(mapProjectField).sort((a, b) =>
          a.name.localeCompare(b.name) || a.id - b.id);
        if (new Set(fields.map((field) => field.id)).size !== fields.length)
          invalidResponse(root + "/fields");
        const fieldIds = fields.map((field) => field.id).sort((a,b) => a-b);
        const q = "repo:" + snapshot.repository.fullName;
        const query = root + "/items?q=" + encodeURIComponent(q) +
          (fieldIds.length ? "&fields=" + encodeURIComponent(fieldIds.join(",")) : "") +
          "&per_page=100";
        const rawItems = await client.getPaginated<unknown>(query);
        const items = rawItems.map((raw) => mapProjectItem(raw, snapshot.repository.fullName))
          .filter((item): item is ObservedProjectItem => item !== undefined)
          .sort((a, b) => a.id - b.id);
        return {
          logicalId: ref.logicalId, owner: ref.owner, number: ref.number,
          ownerType: ref.ownerType, fields, items,
        } satisfies ObservedProject;
      });
      return { ...snapshot, projects: boards };
    },

    async enrich(snapshot: GithubStateSnapshot, issueNumbers: number[],
      assigneeLogins: string[] = []): Promise<GithubStateSnapshot> {
      const [owner, repo] = splitRepository(snapshot.repository.fullName);
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const selected = [...new Set(issueNumbers)].sort((a, b) => a - b);
      const byNumber = new Map(snapshot.issues.map((issue) => [issue.number, issue] as const));
      for (const number of selected) {
        if (!Number.isSafeInteger(number) || number < 1 || !byNumber.has(number)) {
          invalidResponse(`${repoPath}/issues/<unknown-issue-number>`);
        }
      }
      // Issue-field metadata is acquired by discover() only for organizations.
      // If there are no declared fields, per-issue field-value reads add no value.
      const includeFields = snapshot.issueFields.length > 0;
      const enriched = await mapBounded(selected, limit, (number) =>
        enrichIssue(byNumber.get(number)!, client, repoPath, includeFields)
      );
      const assigneeEligibility = assigneeLogins.length ? { ...snapshot.assigneeEligibility } : undefined;
      if (assigneeEligibility) {
        const unique = new Map(assigneeLogins.map((login) => [login.toLowerCase(), login]));
        const checked = await mapBounded([...unique].sort(([a], [b]) => a.localeCompare(b)),
          limit, async ([key, login]) => [key, await client.isAssigneeEligible(
            `${repoPath}/assignees/${encodeURIComponent(login)}`)] as const);
        for (const [key, eligible] of checked) assigneeEligibility[key] = eligible;
      }
      const updated = new Map(enriched.map((issue) => [issue.number, issue] as const));
      return {
        ...snapshot,
        ...(assigneeEligibility === undefined ? {} : { assigneeEligibility }),
        issues: snapshot.issues
          .map((issue) => updated.get(issue.number) ?? issue)
          .sort((a, b) => a.number - b.number),
      };
    },
  };
}
