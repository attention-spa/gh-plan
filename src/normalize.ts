import type {
  DesiredIssueState,
  DesiredMilestoneState,
  DesiredRelationship,
  DesiredResource,
  DesiredResourceIdentity,
  GithubDiagnostic,
  JsonValue,
  NormalizedDesiredStateGraph,
  RepositoryRef,
} from "./types.ts";

export interface NormalizationResult {
  ok: boolean;
  graph?: NormalizedDesiredStateGraph;
  diagnostics: GithubDiagnostic[];
}

type RecordLike = Record<string, unknown>;

const ROOT_KEYS = new Set(["repository", "issues", "milestones", "relationships"]);
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
  "children",
  "blockedBy",
  "blocks",
  "related",
]);
const MILESTONE_KEYS = new Set([
  "logicalId",
  "management",
  "identity",
  "title",
  "description",
  "state",
]);

function isPlainObject(value: unknown): value is RecordLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isLogicalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^\S+$/.test(value);
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
      diagnostics.push(diagnostic(
        "UNSUPPORTED_SCHEMA_FEATURE",
        `Unsupported schema property '${key}'.`,
        `${path}.${key}`,
      ));
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

function normalizeManagement(value: unknown, path: string, diagnostics: GithubDiagnostic[], logicalId?: string): "managed" | "reference" {
  if (value === undefined || value === "managed") return "managed";
  if (value === "reference") return "reference";
  diagnostics.push(diagnostic("INVALID_SCHEMA", "management must be 'managed' or 'reference'.", path, logicalId));
  return "managed";
}

function normalizeLogicalId(value: unknown, path: string, diagnostics: GithubDiagnostic[]): string | undefined {
  if (!isLogicalId(value)) {
    diagnostics.push(diagnostic("INVALID_SCHEMA", "logicalId must be a non-empty string without whitespace.", path));
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
    case "related": return `related:${relation.from}:${relation.to}`;
  }
}

function canonicalRelation(relation: DesiredRelationship): DesiredRelationship {
  if (relation.kind === "blocks") {
    return { kind: "blocked_by", issue: relation.blocked, blocker: relation.issue };
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
  if (value.kind === "related") {
    reportUnknownKeys(value, new Set(["kind", "from", "to"]), path, diagnostics);
    if (!isLogicalId(value.from) || !isLogicalId(value.to)) {
      diagnostics.push(diagnostic("INVALID_SCHEMA", "related relationships require from and to logical IDs.", path));
      return undefined;
    }
    return { kind: "related", from: value.from, to: value.to };
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

export function normalizeSchema(schema: object): NormalizationResult {
  const diagnostics: GithubDiagnostic[] = [];
  const resources: DesiredResource[] = [];
  const relationships: DesiredRelationship[] = [];
  const seenLogicalIds = new Set<string>();

  if (!isPlainObject(schema)) {
    return {
      ok: false,
      diagnostics: [diagnostic("INVALID_SCHEMA", "Schema must be an object.", "$" )],
    };
  }

  reportUnknownKeys(schema, ROOT_KEYS, "$", diagnostics);

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

    if (management === "reference") {
      const forbidden = ["title", "body", "state", "milestone", "type", "fields", "children", "blockedBy", "blocks", "related"].filter((key) => key in value);
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
    for (const target of normalizeStringRefArray(value.related, `${path}.related`, diagnostics, logicalId)) {
      relationships.push({ kind: "related", from: logicalId, to: target });
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
      const forbidden = ["title", "description", "state"].filter((key) => key in value);
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

    addResource({
      logicalId,
      kind: "milestone",
      management: "managed",
      ...(identity ? { identity } : {}),
      desired,
    }, path);
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
    } else if (relation.kind === "related") {
      const from = resourceById.get(relation.from);
      const to = resourceById.get(relation.to);
      if (from && from.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Related endpoint must be an issue.", "$.relationships", relation.from));
      if (to && to.kind !== "issue") diagnostics.push(diagnostic("INVALID_SCHEMA", "Related endpoint must be an issue.", "$.relationships", relation.to));
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

  resources.sort((a, b) => `${a.kind}:${a.logicalId}`.localeCompare(`${b.kind}:${b.logicalId}`));
  deduped.sort((a, b) => relationKey(a).localeCompare(relationKey(b)));

  return {
    ok: true,
    graph: {
      repository: repository!,
      resources,
      relationships: deduped,
    },
    diagnostics,
  };
}
