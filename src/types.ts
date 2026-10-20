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
  octokit?: unknown;
  mode?: GithubPlannerMode;
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

export type DesiredIssueState = {
  title?: DesiredSet<string>;
  body?: DesiredSetOrRemove<string>;
  state?: DesiredSet<"open" | "closed">;
  milestone?: DesiredSetOrRemove<LogicalResourceRef>;
  issueType?: DesiredSet<string>;
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

export interface RelatedRelationship {
  kind: "related";
  from: LogicalResourceId;
  to: LogicalResourceId;
}

export type DesiredRelationship =
  | ParentRelationship
  | BlockedByRelationship
  | BlocksRelationship
  | RelatedRelationship;

export interface NormalizedDesiredStateGraph {
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
  fields?: Record<string, JsonValue>;
  parentNumber?: number | null;
  blockedByNumbers?: number[];
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

export interface GithubStateSnapshot {
  repository: RepositoryRef;
  issues: ObservedIssue[];
  milestones: ObservedMilestone[];
  issueTypes: ObservedIssueType[];
  issueFields: ObservedIssueField[];
}

export interface GithubDiscoveryTransport {
  readonly mode: GithubPlannerMode;
  discover(desired: NormalizedDesiredStateGraph): Promise<GithubStateSnapshot>;
}

export type PlanStepStatus = "planned" | "noop" | "blocked" | "unsupported";

export type PlanOperationKind =
  | "milestone.create"
  | "milestone.update"
  | "issue.create"
  | "issue.update"
  | "issue.type.set"
  | "issue.field.set"
  | "issue.parent.set"
  | "issue.dependency.add"
  | "verification.read";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RestPlanRequest {
  protocol: "rest";
  method: HttpMethod;
  path: string;
  body?: JsonValue;
}

export interface GraphqlPlanRequest {
  protocol: "graphql";
  document: string;
  operationName?: string;
  variables?: Record<string, JsonValue>;
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
  | "UNRESOLVED_IDENTITY"
  | "UNRESOLVED_REFERENCE"
  | "UNKNOWN_ISSUE_TYPE"
  | "UNKNOWN_ISSUE_FIELD"
  | "UNKNOWN_FIELD_OPTION"
  | "RELATIONSHIP_CYCLE"
  | "INSUFFICIENT_PERMISSION"
  | "NO_REST_TRANSPORT"
  | "NO_GRAPHQL_TRANSPORT"
  | "UNSUPPORTED_SCHEMA_FEATURE";

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
