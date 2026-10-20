import type {
  FetchLike,
  FetchResponseLike,
  GithubDiscoveryTransport,
  GithubStateSnapshot,
  JsonValue,
  NormalizedDesiredStateGraph,
  ObservedIssue,
  ObservedIssueField,
  ObservedIssueFieldOption,
  ObservedIssueType,
  ObservedMilestone,
  RepositoryRef,
} from "./types.ts";

const API_BASE = "https://api.github.com";
const API_VERSION = "2026-03-10";

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

export interface GithubRestTransportErrorData {
  code: GithubRestTransportErrorCode;
  method: "GET";
  path: string;
  status?: number;
  statusText?: string;
}

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

export interface RestDiscoveryTransportConfig {
  auth: string;
  fetch?: FetchLike;
}

type RecordLike = Record<string, unknown>;

interface GithubRestClient {
  getJson<T>(pathOrUrl: string): Promise<T>;
  getJsonOptional404<T>(pathOrUrl: string): Promise<T | undefined>;
  getPaginated<T>(pathOrUrl: string): Promise<T[]>;
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
  };
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

  return {
    ...issue,
    fields,
    parentNumber,
    blockedByNumbers,
  };
}

export function createRestDiscoveryTransport(
  config: RestDiscoveryTransportConfig,
): GithubDiscoveryTransport {
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
      const issues = rawIssues
        .map(mapIssue)
        .filter((issue): issue is ObservedIssue => issue !== undefined)
        .sort((a, b) => a.number - b.number);

      const rawMilestones = await client.getPaginated<unknown>(`${repoPath}/milestones?state=all&per_page=100`);
      const milestones = rawMilestones.map(mapMilestone).sort((a, b) => a.number - b.number);

      const rawIssueTypes = await client.getJson<unknown>(`${repoPath}/issue-types`);
      if (!Array.isArray(rawIssueTypes)) invalidResponse(`${repoPath}/issue-types`);
      const issueTypes = sortByNameThenId(rawIssueTypes.map(mapIssueType));

      let issueFields: ObservedIssueField[] = [];
      const organizationOwned = ownerType === "Organization";
      if (organizationOwned) {
        const rawFields = await client.getJson<unknown>(`/orgs/${encodeURIComponent(owner)}/issue-fields`);
        if (!Array.isArray(rawFields)) invalidResponse(`/orgs/${owner}/issue-fields`);
        issueFields = sortByNameThenId(rawFields.map(mapIssueField));
      }

      const enrichedIssues: ObservedIssue[] = [];
      for (const issue of issues) {
        enrichedIssues.push(await enrichIssue(issue, client, repoPath, organizationOwned));
      }

      return {
        repository,
        issues: enrichedIssues,
        milestones,
        issueTypes,
        issueFields,
      };
    },
  };
}
