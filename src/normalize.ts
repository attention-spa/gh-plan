import { isIsoCalendarDate } from "./milestone-due-date.ts";
import type {
  DesiredIssueState,
  DesiredProjectReference,
  DesiredProjectItemAssignment,
  DesiredPullRequestResource,
  DesiredMilestoneState,
  DesiredRelationship,
  DesiredResource,
  DesiredResourceIdentity,
  DesiredRepositoryLabel,
  GithubDiagnostic,
  JsonValue,
  NormalizedDesiredStateGraph,
  RepositoryRef,
} from "./types.ts";

/** Pure normalization result. Invalid inputs yield blocking diagnostics and no graph;
 * unsupported extra properties may produce nonblocking warnings. */
export interface NormalizationResult {
  ok: boolean;
  graph?: NormalizedDesiredStateGraph;
  diagnostics: GithubDiagnostic[];
}

type RecordLike = Record<string, unknown>;

const ROOT_KEYS = new Set(["repository", "issues", "milestones", "relationships", "relationshipMode", "labels", "pullRequests", "projects", "$schema"]);
const ISSUE_KEYS = new Set([
  "logicalId",
  "management",
  "identity",
  "title",
  "body",
  "state",
  "milestone",
  "type",
  "fields",
  "labels",
  "assignees",
  "projects",
  "children",
  "blockedBy",
  "blocks",
  "relatesTo",
]);
const REPOSITORY_LABEL_KEYS = new Set(["logicalId", "name", "color", "description", "management"]);
const PULL_REQUEST_KEYS = new Set([
  "logicalId", "head", "base", "identity", "title", "body", "state", "draft",
  "labels", "assignees", "reviewers", "closes", "projects",
]);
const MILESTONE_KEYS = new Set([
  "logicalId",
  "management",
  "identity",
  "title",
  "description",
  "state",
  "due_on",
]);

function isPlainObject(value: unknown): value is RecordLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function isLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function diagnostic(
  code: GithubDiagnostic["code"],
  message: string,
  schemaPath: string,
  logicalId?: string,
  details?: JsonValue,
): GithubDiagnostic {
  return {
    code,
    severity: "error",
    blocking: true,
    ...(logicalId ? { logicalId } : {}),
    schemaPath,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function reportUnknownKeys(
  value: RecordLike,
  allowed: Set<string>,
  path: string,
  diagnostics: GithubDiagnostic[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) {
      diagnostics.push({
        code: "UNSUPPORTED_SCHEMA_FEATURE",
        severity: "warning",
        blocking: false,
        schemaPath: `${path}.${key}`,
        message: `Unsupported schema property '${key}' was ignored.`,
      });
    }
  }
}

function normalizeRepository(
  value: unknown,
  diagnostics: GithubDiagnostic[],
): RepositoryRef | undefined {
  let repository: RepositoryRef | undefined;

  if (typeof value === "string") {
    repository = { fullName: value };
  } else if (isPlainObject(value)) {
    reportUnknownKeys(value, new Set(["fullName", "id", "nodeId"]), "$.repository", diagnostics);
    if (typeof value.fullName !== "string") {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Repository fullName must be a string.", "$.repository.fullName"));
      return undefined;
    }
    repository = { fullName: value.fullName };
    if ("id" in value) {
      if (!isPositiveInteger(value.id)) {
        diagnostics.push(diagnostic("INVALID_SCHEMA", "Repository id must be a positive integer.", "$.repository.id"));
      } else {
        repository.id = value.id;
      }
    }
    if ("nodeId" in value) {
      if (typeof value.nodeId !== "string" || value.nodeId.length === 0) {
        diagnostics.push(diagnostic("INVALID_SCHEMA", "Repository nodeId must be a non-empty string.", "$.repository.nodeId"));
      } else {
        repository.nodeId = value.nodeId;
      }
    }
  } else {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Repository must be an owner/name string or repository object.", "$.repository"));
    return undefined;
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repository.fullName)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Repository must use owner/name form.", "$.repository"));
  }

  return repository;
}

function normalizeIdentity(
  value: unknown,
  path: string,
  diagnostics: GithubDiagnostic[],
  logicalId?: string,
): DesiredResourceIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "identity must be an object.", path, logicalId));
    return undefined;
  }

  reportUnknownKeys(value, new Set(["number", "id", "nodeId", "marker"]), path, diagnostics);
  const identity: DesiredResourceIdentity = {};

  if ("number" in value) {
    if (!isPositiveInteger(value.number)) diagnostics.push(diagnostic("INVALID_SCHEMA", "identity.number must be a positive integer.", `${path}.number`, logicalId));
    else identity.number = value.number;
  }
  if ("id" in value) {
    if (!isPositiveInteger(value.id)) diagnostics.push(diagnostic("INVALID_SCHEMA", "identity.id must be a positive integer.", `${path}.id`, logicalId));
    else identity.id = value.id;
  }
  if ("nodeId" in value) {
    if (typeof value.nodeId !== "string" || value.nodeId.length === 0) diagnostics.push(diagnostic("INVALID_SCHEMA", "identity.nodeId must be a non-empty string.", `${path}.nodeId`, logicalId));
    else identity.nodeId = value.nodeId;
  }
  if ("marker" in value) {
    if (typeof value.marker !== "string" || value.marker.length === 0) diagnostics.push(diagnostic("INVALID_SCHEMA", "identity.marker must be a non-empty string.", `${path}.marker`, logicalId));
    else identity.marker = value.marker;
  }

  return Object.keys(identity).length > 0 ? identity : undefined;
}

function operationObject(value: unknown): RecordLike | undefined {
  if (!isPlainObject(value) || typeof value.op !== "string") return undefined;
  const keys = Object.keys(value);
  if (value.op === "remove" && keys.length === 1) return value;
  if (value.op === "set" && keys.length === 2 && "value" in value) return value;
  return undefined;
}

function normalizeStringSet(
  value: unknown,
  path: string,
  diagnostics: GithubDiagnostic[],
  logicalId: string,
  allowRemove: boolean,
): { op: "set"; value: string } | { op: "remove" } | undefined {
  if (typeof value === "string") return { op: "set", value };
  const operation = operationObject(value);
  if (operation?.op === "remove") {
    if (allowRemove) return { op: "remove" };
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Removal is not supported for this property.", path, logicalId));
    return undefined;
  }
  if (operation?.op === "set" && typeof operation.value === "string") {
    return { op: "set", value: operation.value };
  }
  diagnostics.push(diagnostic("INVALID_SCHEMA", "Expected a string, set operation, or supported remove operation.", path, logicalId));
  return undefined;
}

function normalizeState(
  value: unknown,
  path: string,
  diagnostics: GithubDiagnostic[],
  logicalId: string,
): { op: "set"; value: "open" | "closed" } | undefined {
  const operation = operationObject(value);
  const state = operation?.op === "set" ? operation.value : value;
  if (state === "open" || state === "closed") return { op: "set", value: state };
  diagnostics.push(diagnostic("INVALID_SCHEMA", "State must be 'open' or 'closed'.", path, logicalId));
  return undefined;
}

function normalizeMilestoneRef(
  value: unknown,
  path: string,
  diagnostics: GithubDiagnostic[],
  logicalId: string,
): { op: "set"; value: { logicalId: string } } | { op: "remove" } | undefined {
  const operation = operationObject(value);
  if (operation?.op === "remove") return { op: "remove" };
  const reference = operation?.op === "set" ? operation.value : value;
  if (typeof reference === "string" && isLogicalId(reference)) {
    return { op: "set", value: { logicalId: reference } };
  }
  if (isPlainObject(reference) && Object.keys(reference).length === 1 && isLogicalId(reference.logicalId)) {
    return { op: "set", value: { logicalId: reference.logicalId } };
  }
  diagnostics.push(diagnostic("INVALID_SCHEMA", "Milestone must reference a logicalId or use a remove operation.", path, logicalId));
  return undefined;
}

function normalizeFields(
  value: unknown,
  path: string,
  diagnostics: GithubDiagnostic[],
  logicalId: string,
): DesiredIssueState["fields"] | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "fields must be an object.", path, logicalId));
    return undefined;
  }

  const fields: NonNullable<DesiredIssueState["fields"]> = {};
  for (const name of Object.keys(value).sort()) {
    if (name.length === 0) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Field names must be non-empty.", path, logicalId));
      continue;
    }
    const fieldPath = `${path}.${name}`;
    const raw = value[name];
    const operation = operationObject(raw);
    if (operation?.op === "remove") {
      fields[name] = { op: "remove" };
      continue;
    }
    const candidate = operation?.op === "set" ? operation.value : raw;
    if (!isJsonValue(candidate)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Issue-field values must be JSON-serializable.", fieldPath, logicalId));
      continue;
    }
    fields[name] = { op: "set", value: candidate };
  }
  return fields;
}

function normalizeLabels(
  raw: unknown, path: string, diagnostics: GithubDiagnostic[], logicalId: string,
): DesiredIssueState["labels"] | undefined {
  const parse = (input: unknown, at: string): string[] | undefined => {
    if (!Array.isArray(input) || input.some((value) =>
      typeof value !== "string" || !value.trim() || value.trim() !== value)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Labels must be nonempty, trimmed strings.", at, logicalId));
      return undefined;
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of input as string[]) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        diagnostics.push(diagnostic("INVALID_SCHEMA", "Duplicate label: " + name, at, logicalId));
        return undefined;
      }
      seen.add(key);
      result.push(name);
    }
    return result.sort((a, b) => a.localeCompare(b));
  };
  if (Array.isArray(raw)) {
    const value = parse(raw, path);
    return value === undefined ? undefined : { op: "set", value };
  }
  if (!isPlainObject(raw)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Labels must be an array or operation object.", path, logicalId));
    return undefined;
  }
  if (raw.op === "set" && Object.keys(raw).length === 2 && "value" in raw) {
    const value = parse(raw.value, path + ".value");
    return value === undefined ? undefined : { op: "set", value };
  }
  if (Object.keys(raw).some((key) => key !== "add" && key !== "remove") ||
    !("add" in raw || "remove" in raw)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Labels require {op:set,value} or {add,remove}.", path, logicalId));
    return undefined;
  }
  const add = parse(raw.add ?? [], path + ".add");
  const remove = parse(raw.remove ?? [], path + ".remove");
  if (!add || !remove) return undefined;
  const overlap = new Set(add.map((name) => name.toLowerCase()));
  if (remove.some((name) => overlap.has(name.toLowerCase()))) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Cannot add and remove the same label.", path, logicalId));
    return undefined;
  }
  return { op: "modify", add, remove };
}

function normalizeAssignees(
  raw: unknown, path: string, diagnostics: GithubDiagnostic[], logicalId: string,
): DesiredIssueState["assignees"] | undefined {
  const parse = (input: unknown, at: string): string[] | undefined => {
    const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
    if (!Array.isArray(input) || input.some((value) =>
      typeof value !== "string" || !valid.test(value))) {
      diagnostics.push(diagnostic("INVALID_SCHEMA",
        "Assignees must be valid GitHub login strings.", at, logicalId));
      return undefined;
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const login of input as string[]) {
      const key = login.toLowerCase();
      if (seen.has(key)) {
        diagnostics.push(diagnostic("INVALID_SCHEMA", "Duplicate assignee: " + login, at, logicalId));
        return undefined;
      }
      seen.add(key);
      result.push(login);
    }
    return result.sort((a, b) => a.localeCompare(b));
  };
  if (Array.isArray(raw)) {
    const value = parse(raw, path);
    return value === undefined ? undefined : { op: "set", value };
  }
  if (!isPlainObject(raw)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA",
      "Assignees must be an array or operation object.", path, logicalId));
    return undefined;
  }
  if (raw.op === "set" && Object.keys(raw).length === 2 && "value" in raw) {
    const value = parse(raw.value, path + ".value");
    return value === undefined ? undefined : { op: "set", value };
  }
  if (Object.keys(raw).some((key) => key !== "add" && key !== "remove") ||
    !("add" in raw || "remove" in raw)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA",
      "Assignees require {op:set,value} or {add,remove}.", path, logicalId));
    return undefined;
  }
  const add = parse(raw.add ?? [], path + ".add");
  const remove = parse(raw.remove ?? [], path + ".remove");
  if (!add || !remove) return undefined;
  const additions = new Set(add.map((login) => login.toLowerCase()));
  if (remove.some((login) => additions.has(login.toLowerCase()))) {
    diagnostics.push(diagnostic("INVALID_SCHEMA",
      "Cannot add and remove the same assignee.", path, logicalId));
    return undefined;
  }
  return { op: "modify", add, remove };
}

function normalizeManagement(value: unknown, path: string, diagnostics: GithubDiagnostic[], logicalId?: string): "managed" | "reference" {
  if (value === undefined || value === "managed") return "managed";
  if (value === "reference") return "reference";
  diagnostics.push(diagnostic("INVALID_SCHEMA", "management must be 'managed' or 'reference'.", path, logicalId));
  return "managed";
}

function normalizeLogicalId(value: unknown, path: string, diagnostics: GithubDiagnostic[]): string | undefined {
  if (!isLogicalId(value)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "logicalId must match ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ (start with an ASCII letter or digit).", path));
    return undefined;
  }
  return value;
}

function normalizeStringRefArray(
  value: unknown,
  path: string,
  diagnostics: GithubDiagnostic[],
  logicalId: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Relationship references must be an array of logical IDs.", path, logicalId));
    return [];
  }
  const refs: string[] = [];
  value.forEach((item, index) => {
    if (!isLogicalId(item)) diagnostics.push(diagnostic("INVALID_SCHEMA", "Relationship reference must be a logical ID.", `${path}[${index}]`, logicalId));
    else refs.push(item);
  });
  return refs;
}

function relationKey(relation: DesiredRelationship): string {
  switch (relation.kind) {
    case "parent": return `parent:${relation.parent}:${relation.child}`;
    case "blocked_by": return `blocked_by:${relation.issue}:${relation.blocker}`;
    case "blocks": return `blocked_by:${relation.blocked}:${relation.issue}`;
    case "relates_to": {
      const [from, to] = [relation.from, relation.to].sort();
      return JSON.stringify(["relates_to", from, to]);
    }
  }
}

function canonicalRelation(relation: DesiredRelationship): DesiredRelationship {
  if (relation.kind === "blocks") {
    return { kind: "blocked_by", issue: relation.blocked, blocker: relation.issue };
  }
  if (relation.kind === "relates_to") {
    const [from, to] = [relation.from, relation.to].sort();
    return { kind: "relates_to", from, to };
  }
  return relation;
}

function parseExplicitRelationship(
  value: unknown,
  path: string,
  diagnostics: GithubDiagnostic[],
): DesiredRelationship | undefined {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Relationship must be an object with a kind.", path));
    return undefined;
  }

  if (value.kind === "parent") {
    reportUnknownKeys(value, new Set(["kind", "parent", "child"]), path, diagnostics);
    if (!isLogicalId(value.parent) || !isLogicalId(value.child)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Parent relationships require parent and child logical IDs.", path));
      return undefined;
    }
    return { kind: "parent", parent: value.parent, child: value.child };
  }
  if (value.kind === "blocked_by") {
    reportUnknownKeys(value, new Set(["kind", "issue", "blocker"]), path, diagnostics);
    if (!isLogicalId(value.issue) || !isLogicalId(value.blocker)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "blocked_by relationships require issue and blocker logical IDs.", path));
      return undefined;
    }
    return { kind: "blocked_by", issue: value.issue, blocker: value.blocker };
  }
  if (value.kind === "blocks") {
    reportUnknownKeys(value, new Set(["kind", "issue", "blocked"]), path, diagnostics);
    if (!isLogicalId(value.issue) || !isLogicalId(value.blocked)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "blocks relationships require issue and blocked logical IDs.", path));
      return undefined;
    }
    return { kind: "blocks", issue: value.issue, blocked: value.blocked };
  }
  if (value.kind === "relates_to") {
    reportUnknownKeys(value, new Set(["kind", "from", "to"]), path, diagnostics);
    if (!isLogicalId(value.from) || !isLogicalId(value.to)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "relates_to relationships require from and to logical IDs.", path));
      return undefined;
    }
    return { kind: "relates_to", from: value.from, to: value.to };
  }

  diagnostics.push(diagnostic("UNSUPPORTED_SCHEMA_FEATURE", `Unsupported relationship kind '${value.kind}'.`, `${path}.kind`));
  return undefined;
}

function detectDirectedCycle(edges: Array<[string, string]>): boolean {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const targets = adjacency.get(from) ?? [];
    targets.push(to);
    adjacency.set(from, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const node of adjacency.keys()) {
    if (visit(node)) return true;
  }
  return false;
}

/**
 * Normalize the authoring input into sorted resources, labels and canonical edges.
 * Pure: no fetch, mutation, or exception for ordinary invalid JSON-shaped input.
 * Absent property means untouched; shorthands become explicit set/remove intent.
 * Unsupported unknown keys warn rather than silently changing behavior.
 * Malformed and cyclic relationships return INVALID_SCHEMA/RELATIONSHIP_CYCLE.
 */
export function normalizeSchema(schema: object): NormalizationResult {
  const diagnostics: GithubDiagnostic[] = [];
  const resources: DesiredResource[] = [];
  const repositoryLabels: DesiredRepositoryLabel[] = [];
  const relationships: DesiredRelationship[] = [];
  const pullRequests: DesiredPullRequestResource[] = [];
  const projects: DesiredProjectReference[] = [];
  const projectItems: DesiredProjectItemAssignment[] = [];
  const seenPullPairs = new Set<string>();
  const seenLogicalIds = new Set<string>();

  if (!isPlainObject(schema)) {
    return {
      ok: false,
      diagnostics: [diagnostic("INVALID_SCHEMA", "Schema must be an object.", "$" )],
    };
  }

  reportUnknownKeys(schema, ROOT_KEYS, "$", diagnostics);
  if ("$schema" in schema && typeof schema.$schema !== "string") {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "$schema must be a string.", "$.$schema"));
  }
  const relationshipMode = schema.relationshipMode === undefined ? "reconcile" : schema.relationshipMode;
  if (relationshipMode !== "reconcile" && relationshipMode !== "additive") {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "relationshipMode must be reconcile or additive.", "$.relationshipMode"));
  }

  if (!("repository" in schema)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "Schema requires a repository selector.", "$.repository"));
  }
  const repository = normalizeRepository(schema.repository, diagnostics);

  function addResource(resource: DesiredResource, path: string): void {
    if (seenLogicalIds.has(resource.logicalId)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", `Duplicate logicalId '${resource.logicalId}'.`, `${path}.logicalId`, resource.logicalId));
      return;
    }
    seenLogicalIds.add(resource.logicalId);
    resources.push(resource);
  }

  function parseProjectAssignments(
    raw: unknown, path: string, logicalId: string, resourceKind: "issue" | "pull_request",
  ): void {
    if (!isPlainObject(raw)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA",
        "Project memberships must map project logical IDs to field maps.", path, logicalId));
      return;
    }
    for (const projectLogicalId of Object.keys(raw).sort()) {
      const at = path + "." + projectLogicalId;
      if (!isLogicalId(projectLogicalId)) {
        diagnostics.push(diagnostic("INVALID_SCHEMA",
          "Project membership key must be a logicalId.", at, logicalId));
        continue;
      }
      const fields = raw[projectLogicalId];
      if (!isPlainObject(fields)) {
        diagnostics.push(diagnostic("INVALID_SCHEMA",
          "Project fields must be an object; use {} for membership only.", at, logicalId));
        continue;
      }
      const normalized: Record<string, string | number> = {};
      for (const name of Object.keys(fields).sort()) {
        const value = fields[name];
        if (!name.trim() || name.trim() !== name ||
            !(typeof value === "string" || typeof value === "number" && Number.isFinite(value))) {
          diagnostics.push(diagnostic("INVALID_SCHEMA",
            "Project field names must be trimmed and values finite numbers or strings.", at + "." + name, logicalId));
          continue;
        }
        normalized[name] = value;
      }
      projectItems.push({ resourceLogicalId: logicalId, resourceKind, projectLogicalId, fields: normalized });
    }
  }

  function parseIssue(value: unknown, path: string, parent?: string): void {
    if (!isPlainObject(value)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Issue entries must be objects.", path));
      return;
    }
    reportUnknownKeys(value, ISSUE_KEYS, path, diagnostics);
    const logicalId = normalizeLogicalId(value.logicalId, `${path}.logicalId`, diagnostics);
    if (!logicalId) return;
    const management = normalizeManagement(value.management, `${path}.management`, diagnostics, logicalId);
    const identity = normalizeIdentity(value.identity, `${path}.identity`, diagnostics, logicalId);
    if ("projects" in value) parseProjectAssignments(value.projects,
      path + ".projects", logicalId, "issue");

    if (management === "reference") {
      const forbidden = ["title", "body", "state", "milestone", "type", "fields", "labels", "assignees", "children", "blockedBy", "blocks", "relatesTo"].filter((key) => key in value);
      if (forbidden.length > 0) {
        diagnostics.push(diagnostic("INVALID_SCHEMA", "Reference-only issues cannot contain desired state or inline relationships.", path, logicalId, forbidden));
      }
      addResource({
        logicalId,
        kind: "issue",
        management: "reference",
        ...(identity ? { identity } : {}),
      }, path);
      if (parent) relationships.push({ kind: "parent", parent, child: logicalId });
      return;
    }

    const desired: DesiredIssueState = {};
    if ("title" in value) {
      const normalized = normalizeStringSet(value.title, `${path}.title`, diagnostics, logicalId, false);
      if (normalized?.op === "set") desired.title = normalized;
    }
    if ("body" in value) {
      const normalized = normalizeStringSet(value.body, `${path}.body`, diagnostics, logicalId, true);
      if (normalized) desired.body = normalized;
    }
    if ("state" in value) {
      const normalized = normalizeState(value.state, `${path}.state`, diagnostics, logicalId);
      if (normalized) desired.state = normalized;
    }
    if ("milestone" in value) {
      const normalized = normalizeMilestoneRef(value.milestone, `${path}.milestone`, diagnostics, logicalId);
      if (normalized) desired.milestone = normalized;
    }
    if ("type" in value) {
      const normalized = normalizeStringSet(value.type, `${path}.type`, diagnostics, logicalId, false);
      if (normalized?.op === "set") desired.issueType = normalized;
    }
    if ("labels" in value) {
      const normalized = normalizeLabels(value.labels, `${path}.labels`, diagnostics, logicalId);
      if (normalized) desired.labels = normalized;
    }
    if ("assignees" in value) {
      const normalized = normalizeAssignees(value.assignees, `${path}.assignees`, diagnostics, logicalId);
      if (normalized) desired.assignees = normalized;
    }
    if ("fields" in value) {
      const normalized = normalizeFields(value.fields, `${path}.fields`, diagnostics, logicalId);
      if (normalized) desired.fields = normalized;
    }

    addResource({
      logicalId,
      kind: "issue",
      management: "managed",
      ...(identity ? { identity } : {}),
      desired,
    }, path);

    if (parent) relationships.push({ kind: "parent", parent, child: logicalId });

    for (const blocker of normalizeStringRefArray(value.blockedBy, `${path}.blockedBy`, diagnostics, logicalId)) {
      relationships.push({ kind: "blocked_by", issue: logicalId, blocker });
    }
    for (const blocked of normalizeStringRefArray(value.blocks, `${path}.blocks`, diagnostics, logicalId)) {
      relationships.push({ kind: "blocked_by", issue: blocked, blocker: logicalId });
    }
    for (const target of normalizeStringRefArray(value.relatesTo, `${path}.relatesTo`, diagnostics, logicalId)) {
      relationships.push({ kind: "relates_to", from: logicalId, to: target });
    }

    if ("children" in value) {
      if (!Array.isArray(value.children)) {
        diagnostics.push(diagnostic("INVALID_SCHEMA", "children must be an array.", `${path}.children`, logicalId));
      } else {
        value.children.forEach((child, index) => parseIssue(child, `${path}.children[${index}]`, logicalId));
      }
    }
  }

  function parseMilestone(value: unknown, path: string): void {
    if (!isPlainObject(value)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Milestone entries must be objects.", path));
      return;
    }
    reportUnknownKeys(value, MILESTONE_KEYS, path, diagnostics);
    const logicalId = normalizeLogicalId(value.logicalId, `${path}.logicalId`, diagnostics);
    if (!logicalId) return;
    const management = normalizeManagement(value.management, `${path}.management`, diagnostics, logicalId);
    const identity = normalizeIdentity(value.identity, `${path}.identity`, diagnostics, logicalId);

    if (management === "reference") {
      const forbidden = ["title", "description", "state", "due_on"].filter((key) => key in value);
      if (forbidden.length > 0) {
        diagnostics.push(diagnostic("INVALID_SCHEMA", "Reference-only milestones cannot contain desired state.", path, logicalId, forbidden));
      }
      addResource({
        logicalId,
        kind: "milestone",
        management: "reference",
        ...(identity ? { identity } : {}),
      }, path);
      return;
    }

    const desired: DesiredMilestoneState = {};
    if ("title" in value) {
      const normalized = normalizeStringSet(value.title, `${path}.title`, diagnostics, logicalId, false);
      if (normalized?.op === "set") desired.title = normalized;
    }
    if ("description" in value) {
      const normalized = normalizeStringSet(value.description, `${path}.description`, diagnostics, logicalId, true);
      if (normalized) desired.description = normalized;
    }
    if ("state" in value) {
      const normalized = normalizeState(value.state, `${path}.state`, diagnostics, logicalId);
      if (normalized) desired.state = normalized;
    }
    if ("due_on" in value) {
      const normalized = normalizeStringSet(value.due_on, `${path}.due_on`, diagnostics, logicalId, true);
      if (normalized?.op === "remove") desired.due_on = normalized;
      else if (normalized?.op === "set") {
        if (isIsoCalendarDate(normalized.value)) desired.due_on = normalized;
        else diagnostics.push(diagnostic("INVALID_SCHEMA",
          "Milestone due_on must be a real UTC YYYY-MM-DD calendar date.", `${path}.due_on`, logicalId));
      }
    }

    addResource({
      logicalId,
      kind: "milestone",
      management: "managed",
      ...(identity ? { identity } : {}),
      desired,
    }, path);
  }


  const seenLabelNames = new Set<string>();
  function parseRepositoryLabel(value: unknown, path: string): void {
    if (!isPlainObject(value)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Repository labels must be objects.", path));
      return;
    }
    reportUnknownKeys(value, REPOSITORY_LABEL_KEYS, path, diagnostics);
    if (typeof value.name !== "string" || !value.name.trim() || value.name !== value.name.trim()) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Repository label name must be a nonempty trimmed string.", path + ".name"));
      return;
    }
    const name = value.name;
    const folded = name.toLowerCase();
    if (seenLabelNames.has(folded)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Duplicate repository label name: " + name + ".", path + ".name"));
      return;
    }
    seenLabelNames.add(folded);
    const logicalId = value.logicalId === undefined
      ? "label:" + encodeURIComponent(folded)
      : normalizeLogicalId(value.logicalId, path + ".logicalId", diagnostics);
    if (!logicalId) return;
    if (seenLogicalIds.has(logicalId)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA",
        "Duplicate logicalId '" + logicalId + "'.", path + ".logicalId", logicalId));
      return;
    }
    seenLogicalIds.add(logicalId);
    const management = normalizeManagement(value.management, path + ".management", diagnostics, logicalId);
    let color: string | undefined;
    if ("color" in value) {
      if (typeof value.color !== "string" || !/^[0-9a-fA-F]{6}$/.test(value.color)) {
        diagnostics.push(diagnostic("INVALID_SCHEMA",
          "Repository label color must be six hexadecimal digits without #.", path + ".color", logicalId));
      } else color = value.color.toLowerCase();
    }
    let description: string | undefined;
    if ("description" in value) {
      if (typeof value.description !== "string" || value.description.length > 100) {
        diagnostics.push(diagnostic("INVALID_SCHEMA",
          "Repository label description must be a string of at most 100 characters.", path + ".description", logicalId));
      } else description = value.description;
    }
    if (management === "reference" && ("color" in value || "description" in value)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA",
        "Reference-only repository labels cannot manage color or description.", path, logicalId));
    }
    repositoryLabels.push({
      logicalId, name, management,
      ...(color === undefined ? {} : { color }),
      ...(description === undefined ? {} : { description }),
    });
  }

  function parsePullRequest(raw: unknown, path: string): void {
    if (!isPlainObject(raw)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Pull request must be an object.", path));
      return;
    }
    reportUnknownKeys(raw, PULL_REQUEST_KEYS, path, diagnostics);
    const logicalId = normalizeLogicalId(raw.logicalId, path + ".logicalId", diagnostics);
    if (!logicalId) return;
    if (seenLogicalIds.has(logicalId)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Duplicate logicalId: " + logicalId, path + ".logicalId", logicalId));
      return;
    }
    seenLogicalIds.add(logicalId);
    const branch = (v: unknown, key: string): string | undefined => {
      if (typeof v !== "string" || v.trim() !== v || !v ||
          !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v) || v.includes("..") ||
          v.includes("//") || v.endsWith("/") || v.endsWith(".") ||
          v.includes("@{") || v.includes("\\")) {
        diagnostics.push(diagnostic("INVALID_SCHEMA",
          "Pull request " + key + " must be a valid same-repository branch ref.", path + "." + key, logicalId));
        return undefined;
      }
      return v;
    };
    const head = branch(raw.head, "head"), base = branch(raw.base, "base");
    if (!head || !base) return;
    if (head === base) diagnostics.push(diagnostic("PR_BRANCH_INVALID",
      "Pull request head and base cannot be identical.", path, logicalId));
    const pair = head + "\u0000" + base;
    if (seenPullPairs.has(pair)) diagnostics.push(diagnostic("PR_PAIR_CONFLICT",
      "Duplicate pull request head/base pair.", path, logicalId));
    seenPullPairs.add(pair);
    const identity = normalizeIdentity(raw.identity, path + ".identity", diagnostics, logicalId);
    if (identity?.marker !== undefined) diagnostics.push(diagnostic("INVALID_SCHEMA",
      "Pull requests use head/base identity, not an issue-body marker.", path + ".identity.marker", logicalId));
    const desired: DesiredPullRequestResource["desired"] = {};
    if ("title" in raw) {
      const v = normalizeStringSet(raw.title, path + ".title", diagnostics, logicalId, false);
      if (v?.op === "set") desired.title = v;
    }
    if ("body" in raw) desired.body = normalizeStringSet(raw.body, path + ".body", diagnostics, logicalId, true);
    if ("state" in raw) desired.state = normalizeState(raw.state, path + ".state", diagnostics, logicalId);
    if ("draft" in raw) {
      const op = operationObject(raw.draft);
      const value = op?.op === "set" ? op.value : raw.draft;
      if (typeof value !== "boolean") diagnostics.push(diagnostic("INVALID_SCHEMA",
        "Pull request draft must be a boolean or set operation.", path + ".draft", logicalId));
      else desired.draft = { op: "set", value };
    }
    if ("labels" in raw) desired.labels = normalizeLabels(raw.labels, path + ".labels", diagnostics, logicalId);
    if ("assignees" in raw) desired.assignees = normalizeAssignees(raw.assignees, path + ".assignees", diagnostics, logicalId);
    if ("reviewers" in raw) desired.reviewers = normalizeAssignees(raw.reviewers, path + ".reviewers", diagnostics, logicalId);
    if ("projects" in raw) parseProjectAssignments(raw.projects,
      path + ".projects", logicalId, "pull_request");
    if ("closes" in raw) desired.closes = normalizeStringRefArray(raw.closes, path + ".closes", diagnostics, logicalId)
      .map((ref) => ({ logicalId: ref }))
      .filter((ref, index, values) => values.findIndex((other) => other.logicalId === ref.logicalId) === index)
      .sort((a, b) => a.logicalId.localeCompare(b.logicalId));
    pullRequests.push({
      logicalId, kind: "pull_request", management: "managed", head, base,
      ...(identity ? { identity } : {}), desired,
    });
  }

  function parseProject(raw: unknown, path: string): void {
    if (!isPlainObject(raw)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Project reference must be an object.", path));
      return;
    }
    const logicalId = normalizeLogicalId(raw.logicalId, path + ".logicalId", diagnostics);
    if (!logicalId) return;
    if (seenLogicalIds.has(logicalId)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Duplicate project logicalId: " + logicalId, path, logicalId));
      return;
    }
    seenLogicalIds.add(logicalId);
    const extras = Object.keys(raw).filter((name) =>
      !["logicalId", "owner", "number", "ownerType", "management"].includes(name));
    if (extras.length || (raw.management !== undefined && raw.management !== "reference")) {
      diagnostics.push(diagnostic("UNSUPPORTED_SCHEMA_FEATURE",
        "Projects are reference-only; project and field creation are unsupported.", path, logicalId, extras));
    }
    if (typeof raw.owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(raw.owner) ||
        !isPositiveInteger(raw.number) || (raw.ownerType !== undefined &&
        raw.ownerType !== "org" && raw.ownerType !== "user")) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "Project requires valid owner, number and optional ownerType.", path, logicalId));
      return;
    }
    projects.push({ logicalId, owner: raw.owner, number: raw.number,
      ownerType: raw.ownerType === "user" ? "user" : "org" });
  }

  if ("projects" in schema) {
    if (!Array.isArray(schema.projects)) diagnostics.push(diagnostic("INVALID_SCHEMA",
      "Root projects must be an array of existing project references.", "$.projects"));
    else schema.projects.forEach((raw, index) => parseProject(raw, "$.projects[" + index + "]"));
  }
  if ("pullRequests" in schema) {
    if (!Array.isArray(schema.pullRequests))
      diagnostics.push(diagnostic("INVALID_SCHEMA", "pullRequests must be an array.", "$.pullRequests"));
    else schema.pullRequests.forEach((raw, index) => parsePullRequest(raw, "$.pullRequests[" + index + "]"));
  }
  if ("labels" in schema) {
    if (!Array.isArray(schema.labels))
      diagnostics.push(diagnostic("INVALID_SCHEMA", "labels must be an array.", "$.labels"));
    else schema.labels.forEach((value, index) => parseRepositoryLabel(value, `$.labels[${index}]`));
  }
  if ("milestones" in schema) {
    if (!Array.isArray(schema.milestones)) diagnostics.push(diagnostic("INVALID_SCHEMA", "milestones must be an array.", "$.milestones"));
    else schema.milestones.forEach((value, index) => parseMilestone(value, `$.milestones[${index}]`));
  }
  if ("issues" in schema) {
    if (!Array.isArray(schema.issues)) diagnostics.push(diagnostic("INVALID_SCHEMA", "issues must be an array.", "$.issues"));
    else schema.issues.forEach((value, index) => parseIssue(value, `$.issues[${index}]`));
  }
  if ("relationships" in schema) {
    if (!Array.isArray(schema.relationships)) diagnostics.push(diagnostic("INVALID_SCHEMA", "relationships must be an array.", "$.relationships"));
    else schema.relationships.forEach((value, index) => {
      const relation = parseExplicitRelationship(value, `$.relationships[${index}]`, diagnostics);
      if (relation) relationships.push(canonicalRelation(relation));
    });
  }

  const resourceById = new Map(resources.map((resource) => [resource.logicalId, resource] as const));
  const projectById = new Map(projects.map((project) => [project.logicalId, project]));
  const projectIdentityKeys = new Set<string>();
  for (const project of projects) {
    const key = project.ownerType + ":" + project.owner.toLowerCase() + ":" + project.number;
    if (projectIdentityKeys.has(key)) diagnostics.push(diagnostic("INVALID_SCHEMA",
      "The same existing Project was declared under multiple logical IDs.", "$.projects", project.logicalId));
    projectIdentityKeys.add(key);
  }
  for (const item of projectItems) {
    if (!projectById.has(item.projectLogicalId)) diagnostics.push(diagnostic("UNKNOWN_PROJECT",
      "Project membership references an undeclared project " + item.projectLogicalId + ".",
      "$.projects", item.resourceLogicalId));
  }
  for (const pr of pullRequests) {
    for (const reference of pr.desired.closes ?? []) {
      const target = resourceById.get(reference.logicalId);
      if (!target || target.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA",
        "PR closes must reference a declared issue: " + reference.logicalId,
        "$.pullRequests", pr.logicalId));
    }
  }

  for (const resource of resources) {
    if (resource.kind === "issue" && resource.management === "managed" && resource.desired.milestone?.op === "set") {
      const target = resourceById.get(resource.desired.milestone.value.logicalId);
      if (!target) diagnostics.push(diagnostic("INVALID_SCHEMA", `Unknown milestone logicalId '${resource.desired.milestone.value.logicalId}'.`, `$.issues`, resource.logicalId));
      else if (target.kind !== "milestone") diagnostics.push(diagnostic("INVALID_SCHEMA", "Issue milestone reference must target a milestone resource.", `$.issues`, resource.logicalId));
    }
  }

  const canonical = relationships.map(canonicalRelation);
  const dedupedMap = new Map<string, DesiredRelationship>();
  for (const relation of canonical) dedupedMap.set(relationKey(relation), relation);
  const deduped = [...dedupedMap.values()];

  const parentForChild = new Map<string, string>();
  for (const relation of deduped) {
    const endpointIds = relation.kind === "parent"
      ? [relation.parent, relation.child]
      : relation.kind === "blocked_by"
        ? [relation.issue, relation.blocker]
        : relation.kind === "blocks"
          ? [relation.issue, relation.blocked]
          : [relation.from, relation.to];

    for (const endpoint of endpointIds) {
      if (!resourceById.has(endpoint)) diagnostics.push(diagnostic("INVALID_SCHEMA", `Unknown relationship endpoint '${endpoint}'.`, "$.relationships", endpoint));
    }

    if (relation.kind === "parent") {
      if (relation.parent === relation.child) diagnostics.push(diagnostic("INVALID_SCHEMA", "Issue cannot be its own parent.", "$.relationships", relation.child));
      const parent = resourceById.get(relation.parent);
      const child = resourceById.get(relation.child);
      if (parent && parent.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Parent endpoint must be an issue.", "$.relationships", relation.parent));
      if (child && child.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Child endpoint must be an issue.", "$.relationships", relation.child));
      const existingParent = parentForChild.get(relation.child);
      if (existingParent && existingParent !== relation.parent) diagnostics.push(diagnostic("INVALID_SCHEMA", `Issue '${relation.child}' has multiple parents.`, "$.relationships", relation.child));
      else parentForChild.set(relation.child, relation.parent);
    } else if (relation.kind === "blocked_by") {
      if (relation.issue === relation.blocker) diagnostics.push(diagnostic("INVALID_SCHEMA", "Issue cannot block itself.", "$.relationships", relation.issue));
      const issue = resourceById.get(relation.issue);
      const blocker = resourceById.get(relation.blocker);
      if (issue && issue.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Dependency endpoint must be an issue.", "$.relationships", relation.issue));
      if (blocker && blocker.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Dependency blocker must be an issue.", "$.relationships", relation.blocker));
    } else if (relation.kind === "relates_to") {
      const from = resourceById.get(relation.from);
      const to = resourceById.get(relation.to);
      if (from && from.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Relates-to endpoint must be an issue.", "$.relationships", relation.from));
      if (to && to.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Relates-to endpoint must be an issue.", "$.relationships", relation.to));
    }
  }

  const parentEdges = deduped
    .filter((relation): relation is Extract<DesiredRelationship, { kind: "parent" }> => relation.kind === "parent")
    .map((relation) => [relation.parent, relation.child] as [string, string]);
  if (detectDirectedCycle(parentEdges)) {
    diagnostics.push(diagnostic("RELATIONSHIP_CYCLE", "Parent relationships contain a cycle.", "$.relationships"));
  }

  const dependencyEdges = deduped
    .filter((relation): relation is Extract<DesiredRelationship, { kind: "blocked_by" }> => relation.kind === "blocked_by")
    .map((relation) => [relation.blocker, relation.issue] as [string, string]);
  if (dependencyEdges.some(([from, to]) => from !== to) && detectDirectedCycle(dependencyEdges)) {
    diagnostics.push(diagnostic("RELATIONSHIP_CYCLE", "Blocking dependencies contain a cycle.", "$.relationships"));
  }

  diagnostics.sort((a, b) => `${a.code}:${a.schemaPath ?? ""}:${a.logicalId ?? ""}:${a.message}`.localeCompare(`${b.code}:${b.schemaPath ?? ""}:${b.logicalId ?? ""}:${b.message}`));

  if (diagnostics.some((item) => item.blocking)) {
    return { ok: false, diagnostics };
  }

  projects.sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  projectItems.sort((a, b) => a.projectLogicalId.localeCompare(b.projectLogicalId) ||
    a.resourceLogicalId.localeCompare(b.resourceLogicalId));
  pullRequests.sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  resources.sort((a, b) => `${a.kind}:${a.logicalId}`.localeCompare(`${b.kind}:${b.logicalId}`));
  repositoryLabels.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  deduped.sort((a, b) => relationKey(a).localeCompare(relationKey(b)));

  return {
    ok: true,
    graph: {
      repository: repository!,
      ...(relationshipMode === "additive" ? { relationshipMode: "additive" as const } : {}),
      resources,
      ...(pullRequests.length ? { pullRequests } : {}),
      ...(projects.length ? { projects } : {}),
      ...(projectItems.length ? { projectItems } : {}),
      ...(repositoryLabels.length ? { labels: repositoryLabels } : {}),
      relationships: deduped,
    },
    diagnostics,
  };
}
