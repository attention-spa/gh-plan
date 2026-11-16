export type GithubPlannerMode = "rest" | "graphql";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface HeaderReaderLike {
  get(name: string): string | null;
}

export interface FetchRequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url?: string;
  readonly headers: HeaderReaderLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: FetchRequestInitLike,
) => Promise<FetchResponseLike>;

export interface GithubPlannerConfig {
  schema: object;
  auth: string;
  fetch?: FetchLike;
  mode?: GithubPlannerMode;
  /** Default false; only explicitly opted-in plans may adopt existing issues by title. */
  adoptByTitle?: boolean;
  /** Per-issue REST enrichment worker count; defaults to four. */
  enrichConcurrency?: number;
}

export type LogicalResourceId = string;
export type ResourceKind = "issue" | "milestone";
export type ResourceManagement = "managed" | "reference";

export interface RepositoryRef {
  fullName: string;
  id?: number;
  nodeId?: string;
}

export interface DesiredResourceIdentity {
  number?: number;
  id?: number;
  nodeId?: string;
  marker?: string;
}

export interface LogicalResourceRef {
  logicalId: LogicalResourceId;
}

export interface DesiredSet<T> {
  op: "set";
  value: T;
}

export interface DesiredRemove {
  op: "remove";
}

export type DesiredSetOrRemove<T> = DesiredSet<T> | DesiredRemove;

export type DesiredIssueLabels =
  | { op: "set"; value: string[] }
  | { op: "modify"; add: string[]; remove: string[] };

/** GitHub logins; absent assignees are left unmanaged. */
export type DesiredIssueAssignees = DesiredIssueLabels;

export type DesiredIssueState = {
  title?: DesiredSet<string>;
  body?: DesiredSetOrRemove<string>;
  state?: DesiredSet<"open" | "closed">;
  milestone?: DesiredSetOrRemove<LogicalResourceRef>;
  issueType?: DesiredSet<string>;
  labels?: DesiredIssueLabels;
  assignees?: DesiredIssueAssignees;
  fields?: Record<string, DesiredSetOrRemove<JsonValue>>;
};

export type DesiredMilestoneState = {
  title?: DesiredSet<string>;
  description?: DesiredSetOrRemove<string>;
  state?: DesiredSet<"open" | "closed">;
};

interface DesiredResourceBase {
  logicalId: LogicalResourceId;
  kind: ResourceKind;
  management: ResourceManagement;
  identity?: DesiredResourceIdentity;
}

export interface ManagedIssueResource extends DesiredResourceBase {
  kind: "issue";
  management: "managed";
  desired: DesiredIssueState;
}

export interface ReferencedIssueResource extends DesiredResourceBase {
  kind: "issue";
  management: "reference";
  desired?: never;
}

export interface ManagedMilestoneResource extends DesiredResourceBase {
  kind: "milestone";
  management: "managed";
  desired: DesiredMilestoneState;
}

export interface ReferencedMilestoneResource extends DesiredResourceBase {
  kind: "milestone";
  management: "reference";
  desired?: never;
}

export type DesiredResource =
  | ManagedIssueResource
  | ReferencedIssueResource
  | ManagedMilestoneResource
  | ReferencedMilestoneResource;

export interface ParentRelationship {
  kind: "parent";
  parent: LogicalResourceId;
  child: LogicalResourceId;
}

export interface BlockedByRelationship {
  kind: "blocked_by";
  issue: LogicalResourceId;
  blocker: LogicalResourceId;
}

export interface BlocksRelationship {
  kind: "blocks";
  issue: LogicalResourceId;
  blocked: LogicalResourceId;
}

export interface RelatesToRelationship {
  kind: "relates_to";
  from: LogicalResourceId;
  to: LogicalResourceId;
}

export type DesiredRelationship =
  | ParentRelationship
  | BlockedByRelationship
  | BlocksRelationship
  | RelatesToRelationship;

export type RelationshipReconciliationMode = "reconcile" | "additive";

export interface NormalizedDesiredStateGraph {
  /** Default reconcile: managed issues own their native relationship sets. */
  relationshipMode?: RelationshipReconciliationMode;
  repository: RepositoryRef;
  resources: DesiredResource[];
  relationships: DesiredRelationship[];
}

export type ResourceResolutionStatus =
  | "existing"
  | "new"
  | "unresolved"
  | "ambiguous";

export interface ResolvedGithubIdentity extends DesiredResourceIdentity {
  apiUrl?: string;
  htmlUrl?: string;
}

export interface ResourceResolution {
  logicalId: LogicalResourceId;
  kind: ResourceKind;
  status: ResourceResolutionStatus;
  identity?: ResolvedGithubIdentity;
  candidates?: ResolvedGithubIdentity[];
}

export interface ObservedIssue {
  kind: "issue";
  number: number;
  id: number;
  nodeId?: string;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  milestoneNumber?: number | null;
  issueType?: string | null;
  /** Undefined means not discovered; empty array is authoritative. */
  labels?: string[];
  /** Undefined means not discovered; empty array is authoritative. */
  assignees?: string[];
  fields?: Record<string, JsonValue>;
  parentNumber?: number | null;
  blockedByNumbers?: number[];
  relatesToNumbers?: number[];
}

export interface ObservedMilestone {
  kind: "milestone";
  number: number;
  id?: number;
  nodeId?: string;
  title: string;
  description?: string | null;
  state: "open" | "closed";
}

export interface ObservedIssueType {
  id?: number;
  nodeId?: string;
  name: string;
}

export interface ObservedIssueFieldOption {
  id?: number | string;
  name: string;
  value?: JsonValue;
}

export interface ObservedIssueField {
  id: number | string;
  name: string;
  dataType?: string;
  options?: ObservedIssueFieldOption[];
}

export interface ObservedLabel {
  name: string;
  id?: number;
  color?: string;
}

export interface GithubStateSnapshot {
  repository: RepositoryRef;
  issues: ObservedIssue[];
  milestones: ObservedMilestone[];
  issueTypes: ObservedIssueType[];
  /** Undefined until catalog discovery is requested. */
  labels?: ObservedLabel[];
  /** Case-folded login to repository assignment eligibility (204=true, 404=false). */
  assigneeEligibility?: Record<string, boolean>;
  issueFields: ObservedIssueField[];
}

export interface GithubDiscoveryTransport {
  readonly mode: GithubPlannerMode;
  /** Broad repository data and issue summaries; no per-issue requests. */
  discover(desired: NormalizedDesiredStateGraph): Promise<GithubStateSnapshot>;
  /** Targeted per-issue detail requests; preserves untargeted summaries. */
  enrich(snapshot: GithubStateSnapshot, issueNumbers: number[], assigneeLogins?: string[]): Promise<GithubStateSnapshot>;
}

export type PlanStepStatus = "planned" | "noop" | "blocked" | "unsupported";

export type PlanOperationKind =
  | "milestone.create"
  | "milestone.update"
  | "issue.create"
  | "issue.update"
  | "issue.type.set"
  | "issue.marker.adopt"
  | "issue.label.set"
  | "issue.label.add"
  | "issue.label.remove"
  | "issue.assignee.set"
  | "issue.assignee.add"
  | "issue.assignee.remove"
  | "issue.field.set"
  | "issue.field.remove"
  | "issue.parent.set"
  | "issue.dependency.add"
  | "issue.dependency.remove"
  | "issue.parent.remove"
  | "issue.relates_to.add"
  | "issue.relates_to.remove"
  | "verification.read";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A reference to a GitHub identity that will be available after a create step. */
export type PlanIdentityProperty = "number" | "id" | "nodeId";
export type PlanValueRef = {
  $ref: `${LogicalResourceId}.${PlanIdentityProperty}`;
};

/** Serializable request data; references can occur at any nesting depth. */
export type PlanJsonValue =
  | JsonPrimitive
  | PlanValueRef
  | PlanJsonValue[]
  | { [key: string]: PlanJsonValue };

/** Literal path fragments and late-bound identity references in order. */
export type PlanPath = string | Array<string | PlanValueRef>;

/** Identity values supplied by an external executor after creating a resource. */
export type PlanBindings = Record<LogicalResourceId, Partial<Record<PlanIdentityProperty, number | string>>>;


export interface RestPlanRequest {
  protocol: "rest";
  method: HttpMethod;
  path: PlanPath;
  body?: PlanJsonValue;
}

export interface GraphqlPlanRequest {
  protocol: "graphql";
  document: string;
  operationName?: string;
  variables?: Record<string, PlanJsonValue>;
}

export type PlanRequest = RestPlanRequest | GraphqlPlanRequest;

export interface PlanStep {
  id: string;
  kind: PlanOperationKind;
  logicalId: LogicalResourceId;
  status: PlanStepStatus;
  current: JsonValue | null;
  desired: JsonValue | null;
  reason: string;
  dependsOn: string[];
  request?: PlanRequest;
  preconditions: string[];
  expectedPostconditions: string[];
  destructive: boolean;
  reversible: boolean | "partial";
}

export type DiagnosticCode =
  | "INVALID_SCHEMA"
  | "AUTH_FAILED"
  | "REPOSITORY_NOT_FOUND"
  | "AMBIGUOUS_IDENTITY"
  | "TITLE_MATCH_REQUIRES_ADOPTION"
  | "UNRESOLVED_IDENTITY"
  | "UNRESOLVED_REFERENCE"
  | "UNKNOWN_ISSUE_TYPE"
  | "UNKNOWN_ISSUE_FIELD"
  | "UNKNOWN_LABEL"
  | "UNKNOWN_ASSIGNEE"
  | "UNKNOWN_FIELD_OPTION"
  | "RELATIONSHIP_CYCLE"
  | "INSUFFICIENT_PERMISSION"
  | "NO_REST_TRANSPORT"
  | "RATE_LIMITED"
  | "NO_GRAPHQL_TRANSPORT"
  | "UNSUPPORTED_SCHEMA_FEATURE"
  | "PARENT_CONFLICT";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface GithubDiagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  blocking: boolean;
  logicalId?: LogicalResourceId;
  schemaPath?: string;
  message: string;
  details?: JsonValue;
}

export interface GithubPlanMetadata {
  planner: "gh-plan";
  version: string;
  mode: GithubPlannerMode;
}

export interface DesiredStateSummary {
  resourceCount: number;
  relationshipCount: number;
}

export interface GithubPlanSummary {
  planned: number;
  noops: number;
  blocked: number;
  unsupported: number;
  warnings: number;
}

export type GithubPlanReadiness = "ready" | "ready_with_warnings" | "blocked";

export interface GithubPlan {
  metadata: GithubPlanMetadata;
  repository: RepositoryRef;
  desired: DesiredStateSummary;
  resolutions: ResourceResolution[];
  steps: PlanStep[];
  noops: PlanStep[];
  warnings: GithubDiagnostic[];
  blockers: GithubDiagnostic[];
  unsupported: GithubDiagnostic[];
  summary: GithubPlanSummary;
  readiness: GithubPlanReadiness;
}

export type PlanGithub = (config: GithubPlannerConfig) => Promise<GithubPlan>;

/** Pure, transport-independent reconciliation intent. */
export type GithubDiffStatus = "create" | "update" | "noop" | "conflict" | "unsupported";
export interface GithubDiff {
  id: string;
  logicalId: LogicalResourceId;
  kind: string;
  status: GithubDiffStatus;
  reason: string;
  property?: string;
  current?: JsonValue;
  desired?: JsonValue;
  references?: LogicalResourceRef[];
}
export interface GithubDiffResult {
  diffs: GithubDiff[];
  blockers: GithubDiagnostic[];
  warnings: GithubDiagnostic[];
  unsupported: GithubDiagnostic[];
}
