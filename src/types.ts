import type { GithubPlanSchema } from "./authoring-schema.ts";

/** REST reads GitHub; graphql is typed but currently yields NO_GRAPHQL_TRANSPORT without I/O. */
export type GithubPlannerMode = "rest" | "graphql";

/** JSON-safe primitive that can appear in a desired field or diagnostic. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursive JSON value; no functions, undefined, or circular structures. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Minimal response header reader for injected fetch transports. */
export interface HeaderReaderLike {
  get(name: string): string | null;
}

/** Request subset used by the read-only REST adapter. */
export interface FetchRequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Minimal HTTP response contract; no DOM Response instance is required. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url?: string;
  readonly headers: HeaderReaderLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Injectable HTTP reader. The planner makes GET requests only, never writes. */
export type FetchLike = (
  input: string,
  init?: FetchRequestInitLike,
) => Promise<FetchResponseLike>;

/** Read-only planner configuration. Auth stays in runtime headers and is never serialized into a plan. */
export interface GithubPlannerConfig {
  /** Typed authoring input; invalid runtime JSON still produces blocking normalization diagnostics. */
  schema: GithubPlanSchema;
  /** Runtime-only GitHub bearer token; GET headers use it but the result never contains it. */
  auth: string;
  /** Injected fetch for tests or restricted runtimes; otherwise global fetch is used. */
  fetch?: FetchLike;
  /** Defaults to REST; graphql returns NO_GRAPHQL_TRANSPORT without discovery. */
  mode?: GithubPlannerMode;
  /** Default false; only explicitly opted-in plans may adopt existing issues by title. */
  /** Defaults false; issue-title matches require explicit adoption or other identity. */
  adoptByTitle?: boolean;
  /** Per-issue REST enrichment worker count; defaults to four. */
  /** Positive integer, default four parallel issue/assignee detail requests. */
  enrichConcurrency?: number;
}

/** Caller-supplied stable logical key for resources and step bindings. */
export type LogicalResourceId = string;
/** Issues and milestones use resource identity; root labels are separate declarations. */
export type ResourceKind = "issue" | "milestone" | "pull_request";
/** Managed means reconciled; reference means existing-only, never created or changed. */
export type ResourceManagement = "managed" | "reference";

/** Repository identity uses owner/name and optional REST/node identifiers. */
export interface RepositoryRef {
  fullName: string;
  id?: number;
  nodeId?: string;
}

/** Explicit identity hints take priority over marker/title fallback; conflicting hints block resolution. */
export interface DesiredResourceIdentity {
  number?: number;
  id?: number;
  nodeId?: string;
  marker?: string;
}

/** Logical reference to an issue/milestone, resolved before request compilation. */
export interface LogicalResourceRef {
  logicalId: LogicalResourceId;
}

/** Explicit value reconciliation, distinct from omission. */
export interface DesiredSet<T> {
  op: "set";
  value: T;
}

/** Explicitly clear a removable property; omission leaves it untouched. */
export interface DesiredRemove {
  op: "remove";
}

/** Normalized property intent: set a value or explicitly remove it. */
export type DesiredSetOrRemove<T> = DesiredSet<T> | DesiredRemove;

/** Normalized exact set or targeted add/remove; missing labels do not manage the issue. */
export type DesiredIssueLabels =
  | { op: "set"; value: string[] }
  | { op: "modify"; add: string[]; remove: string[] };

/** GitHub logins; absent assignees are left unmanaged. */
export type DesiredIssueAssignees = DesiredIssueLabels;

/** Repository labels are name-keyed. Logical IDs are optional in input and always normalized. */
export interface DesiredRepositoryLabel {
  logicalId: LogicalResourceId;
  name: string;
  management: ResourceManagement;
  /** Six hexadecimal digits, without #. Omission preserves existing color. */
  color?: string;
  /** Omission preserves existing description; empty string clears it. */
  description?: string;
}

/** Reference to an existing Projects v2 board, never created or modified. */
export interface DesiredProjectReference {
  logicalId: LogicalResourceId;
  owner: string;
  number: number;
  ownerType: "org" | "user";
}

/** A managed membership for an issue or PR; empty fields means membership only. */
export interface DesiredProjectItemAssignment {
  resourceLogicalId: LogicalResourceId;
  resourceKind: "issue" | "pull_request";
  projectLogicalId: LogicalResourceId;
  fields: Record<string, string | number>;
}

/** Normalized issue intent. Omission leaves a field unchanged; issue types and org fields are named, not keyed by API IDs. */
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

/** Normalized pull request desired properties. Title/body/state are partial intent.
 * The head is immutable; base can be updated only for an explicitly identified PR.
 * Draft changes after creation cannot be expressed by REST. */
export interface DesiredPullRequestState {
  title?: DesiredSet<string>;
  body?: DesiredSetOrRemove<string>;
  state?: DesiredSet<"open" | "closed">;
  draft?: DesiredSet<boolean>;
  labels?: DesiredIssueLabels;
  assignees?: DesiredIssueAssignees;
  reviewers?: DesiredIssueAssignees;
  closes?: LogicalResourceRef[];
}

/** Same-repository managed PR with a stable logical key and head/base identity. */
export interface DesiredPullRequestResource {
  kind: "pull_request";
  management: "managed";
  logicalId: LogicalResourceId;
  head: string;
  base: string;
  identity?: DesiredResourceIdentity;
  desired: DesiredPullRequestState;
}

/** Normalized milestone intent; only supplied properties produce comparisons. */
export type DesiredMilestoneState = {
  title?: DesiredSet<string>;
  description?: DesiredSetOrRemove<string>;
  state?: DesiredSet<"open" | "closed">;
  /** Normalized YYYY-MM-DD UTC date, never a timestamp. */
  due_on?: DesiredSetOrRemove<string>;
};

interface DesiredResourceBase {
  logicalId: LogicalResourceId;
  kind: ResourceKind;
  management: ResourceManagement;
  /** Explicit number/id/nodeId wins over body markers and title matches; hints must agree. */
  identity?: DesiredResourceIdentity;
}

/** Managed issue with desired state and stable identity marker for creation. */
export interface ManagedIssueResource extends DesiredResourceBase {
  kind: "issue";
  management: "managed";
  desired: DesiredIssueState;
}

/** Existing issue for linking only; no desired state or mutation is permitted. */
export interface ReferencedIssueResource extends DesiredResourceBase {
  kind: "issue";
  management: "reference";
  desired?: never;
}

/** Managed milestone; exact title is its fallback identity when no number/id is supplied. */
export interface ManagedMilestoneResource extends DesiredResourceBase {
  kind: "milestone";
  management: "managed";
  desired: DesiredMilestoneState;
}

/** Existing milestone reference; unresolved references block the plan. */
export interface ReferencedMilestoneResource extends DesiredResourceBase {
  kind: "milestone";
  management: "reference";
  desired?: never;
}

/** Discriminated union of managed/reference issue and milestone resources. */
export type DesiredResource =
  | ManagedIssueResource
  | ReferencedIssueResource
  | ManagedMilestoneResource
  | ReferencedMilestoneResource;

/** Directed parent-to-child association; each child has at most one declared parent. */
export interface ParentRelationship {
  kind: "parent";
  parent: LogicalResourceId;
  child: LogicalResourceId;
}

/** Directed dependency: issue is blocked by blocker. */
export interface BlockedByRelationship {
  kind: "blocked_by";
  issue: LogicalResourceId;
  blocker: LogicalResourceId;
}

/** Reverse spelling: issue blocks blocked; normalized into blocked_by. */
export interface BlocksRelationship {
  kind: "blocks";
  issue: LogicalResourceId;
  blocked: LogicalResourceId;
}

/** Symmetric association; endpoints are sorted and duplicates deduplicated. */
export interface RelatesToRelationship {
  kind: "relates_to";
  from: LogicalResourceId;
  to: LogicalResourceId;
}

/** Supported parent, dependency and symmetric related-to relationships. */
export type DesiredRelationship =
  | ParentRelationship
  | BlockedByRelationship
  | BlocksRelationship
  | RelatesToRelationship;

/** Reconcile is the default; additive retains undeclared existing relationships. */
export type RelationshipReconciliationMode = "reconcile" | "additive";

/** Flattened deterministic result of pure schema normalization. */
export interface NormalizedDesiredStateGraph {
  /** Default reconcile: managed issues own their native relationship sets. */
  relationshipMode?: RelationshipReconciliationMode;
  repository: RepositoryRef;
  resources: DesiredResource[];
  /** Optional root repository-label declarations; never imply deletions. */
  labels?: DesiredRepositoryLabel[];
  relationships: DesiredRelationship[];
  /** Separate PR resources avoid treating PRs as ordinary issue-mutation targets. */
  pullRequests?: DesiredPullRequestResource[];
  /** Existing board references and declared issue/PR project item memberships. */
  projects?: DesiredProjectReference[];
  projectItems?: DesiredProjectItemAssignment[];
}

/** Only existing/new are actionable; ambiguous/unresolved identities must block. */
export type ResourceResolutionStatus =
  | "existing"
  | "new"
  | "unresolved"
  | "ambiguous";

/** Observed REST/node identity, with optional marker and URLs. */
export interface ResolvedGithubIdentity extends DesiredResourceIdentity {
  apiUrl?: string;
  htmlUrl?: string;
}

/** Per-logical-ID identity decision; ambiguous candidates are reported rather than guessed. */
export interface ResourceResolution {
  logicalId: LogicalResourceId;
  kind: ResourceKind;
  status: ResourceResolutionStatus;
  identity?: ResolvedGithubIdentity;
  candidates?: ResolvedGithubIdentity[];
}

/** Read-only issue snapshot. Absent optional collections mean not discovered, not empty. */
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

/** Read-only milestone summary used for identity matching and field comparison. */
export interface ObservedMilestone {
  kind: "milestone";
  number: number;
  id?: number;
  nodeId?: string;
  title: string;
  description?: string | null;
  state: "open" | "closed";
  /** GitHub's ISO timestamp or null; undefined means due_on was not discovered. */
  due_on?: string | null;
}

/** Enriched PR. Unlike a /issues listing entry, head/base and reviewer state are authoritative. */
export interface ObservedPullRequest {
  kind: "pull_request";
  number: number;
  id: number;
  nodeId?: string;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  head: string;
  base: string;
  draft: boolean;
  merged: boolean;
  labels: string[];
  assignees: string[];
  requestedReviewers: string[];
}

/** Validated same-repo branch refs and compare status for a proposed new PR. */
export interface PullRequestBranchCheck {
  headExists: boolean;
  baseExists: boolean;
  differs: boolean;
}

/** GitHub issue type metadata; authored by name rather than id. */
export interface ObservedIssueType {
  id?: number;
  nodeId?: string;
  name: string;
}

/** Metadata for allowed values of an organization issue field. */
export interface ObservedIssueFieldOption {
  id?: number | string;
  name: string;
  value?: JsonValue;
}

/** Organization issue-field catalog; authored by name, resolved to API identifiers. */
export interface ObservedIssueField {
  id: number | string;
  name: string;
  dataType?: string;
  options?: ObservedIssueFieldOption[];
}

/** Repository label entry keyed by case-insensitive name; no implicit deletion. */
export interface ObservedLabel {
  name: string;
  id?: number;
  color?: string;
  /** Null is GitHub's representation of an empty description. */
  description?: string | null;
}

/** Existing project custom field metadata keyed by numeric REST ID; unsupported types are not applied. */
export interface ObservedProjectField {
  id: number;
  name: string;
  dataType: string;
  options?: Array<{ id: string; name: string }>;
  iterations?: Array<{ id: string; title: string }>;
}

/** Scoped item snapshot; fields represent observed values by field ID. */
export interface ObservedProjectItem {
  id: number;
  contentType: "Issue" | "PullRequest";
  contentId: number;
  contentNumber: number;
  fields: Record<string, string | number | null>;
}

/** Read-only metadata and scoped items for a declared existing Projects v2 board. */
export interface ObservedProject {
  logicalId: LogicalResourceId;
  owner: string;
  number: number;
  ownerType: "org" | "user";
  missing?: boolean;
  fields: ObservedProjectField[];
  items: ObservedProjectItem[];
}

/** Read-only observed state; optional catalogs are fetched only when required. */
export interface GithubStateSnapshot {
  repository: RepositoryRef;
  issues: ObservedIssue[];
  /** PR numbers identified by pull_request metadata in the broad /issues list. */
  pullRequestIssueNumbers?: number[];
  /** Only PRs matching desired open head/base or an explicit number are enriched. */
  pullRequests?: ObservedPullRequest[];
  /** Checks for new-PR head/base refs and nonidentical commits. */
  pullRequestBranchChecks?: Record<LogicalResourceId, PullRequestBranchCheck>;
  milestones: ObservedMilestone[];
  issueTypes: ObservedIssueType[];
  /** Undefined until catalog discovery is requested. */
  labels?: ObservedLabel[];
  /** Case-folded login to repository assignment eligibility (204=true, 404=false). */
  assigneeEligibility?: Record<string, boolean>;
  issueFields: ObservedIssueField[];
  /** Scoped Projects v2 metadata; absent means not discovered, not empty. */
  projects?: ObservedProject[];
}

/** Read-only I/O boundary. discover fetches broad data; enrich fetches targeted details and may reject on transport errors. */
export interface GithubDiscoveryTransport {
  readonly mode: GithubPlannerMode;
  /** Broad repository data and issue summaries; no per-issue requests. */
  discover(desired: NormalizedDesiredStateGraph): Promise<GithubStateSnapshot>;
  /** Targeted per-issue detail requests; preserves untargeted summaries. */
  enrich(snapshot: GithubStateSnapshot, issueNumbers: number[], assigneeLogins?: string[]): Promise<GithubStateSnapshot>;
  /** Optional read-only, PR-specific enrichment; invoked only for declared PRs. */
  enrichPullRequests?(snapshot: GithubStateSnapshot, desired: DesiredPullRequestResource[]): Promise<GithubStateSnapshot>;
  /** Read only referenced boards, their fields, and items scoped to target repository. */
  enrichProjects?(snapshot: GithubStateSnapshot, desired: NormalizedDesiredStateGraph): Promise<GithubStateSnapshot>;
}

/** Only planned operations are executable; noops and blocked/unsupported entries are informational. */
export type PlanStepStatus = "planned" | "noop" | "blocked" | "unsupported";

/** Stable operation names forming plan step IDs and request DAG edges. */
export type PlanOperationKind =
  | "label.create"
  | "label.update"
  | "milestone.create"
  | "milestone.update"
  | "project.item.add"
  | "project.item.fields.set"
  | "pull_request.create"
  | "pull_request.update"
  | "pull_request.reviewer.add"
  | "pull_request.reviewer.remove"
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

/** HTTP method for a proposed request; the planner never performs mutations. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A reference to a GitHub identity that will be available after a create step. */
/** Identity fields available only after an external executor creates a resource. */
export type PlanIdentityProperty = "number" | "id" | "nodeId";
/** Late-bound identity placeholder like { $ref: "A.number" }. Its create step must appear in dependsOn. */
export type PlanValueRef = {
  $ref: `${LogicalResourceId}.${PlanIdentityProperty}`;
};

/** Template for a string containing late-bound IDs (e.g., a Closes #number body). */
export type PlanStringTemplate = {
  $template: Array<string | PlanValueRef>;
};

/** Serializable request data; references can occur at any nesting depth. */
/** JSON request payload that can contain nested late-bound identity references. */
export type PlanJsonValue =
  | JsonPrimitive
  | PlanValueRef
  | PlanStringTemplate
  | PlanJsonValue[]
  | { [key: string]: PlanJsonValue };

/** Literal path fragments and late-bound identity references in order. */
/** REST path as a string or ordered literal/reference fragments. */
export type PlanPath = string | Array<string | PlanValueRef>;

/** Identity values supplied by an external executor after creating a resource. */
/** External executor's post-create identity map; missing values cause binding errors. */
export type PlanBindings = Record<LogicalResourceId, Partial<Record<PlanIdentityProperty, number | string>>>;


/** Serializable REST request specification without credentials or side effects. */
export interface RestPlanRequest {
  protocol: "rest";
  method: HttpMethod;
  path: PlanPath;
  body?: PlanJsonValue;
}

/** Reserved GraphQL request descriptor; GraphQL planning currently blocks. */
export interface GraphqlPlanRequest {
  protocol: "graphql";
  document: string;
  operationName?: string;
  variables?: Record<string, PlanJsonValue>;
}

/** Transport-neutral proposed action, never executed by the planner itself. */
export type PlanRequest = RestPlanRequest | GraphqlPlanRequest;

/** A DAG node; dependsOn contains full step IDs. A partial reversible step cannot guarantee rollback (e.g., creation). */
export interface PlanStep {
  id: string;
  kind: PlanOperationKind;
  logicalId: LogicalResourceId;
  status: PlanStepStatus;
  current: JsonValue | null;
  desired: JsonValue | null;
  reason: string;
  /** Full prerequisite step IDs, such as "issue.create:A", not bare resource logical IDs. */
  dependsOn: string[];
  /** Inert proposal until an external executor explicitly runs it. */
  request?: PlanRequest;
  preconditions: string[];
  expectedPostconditions: string[];
  destructive: boolean;
  /** "partial" means compensating operations cannot promise restoration of prior state. */
  reversible: boolean | "partial";
}

/** Stable machine-readable error and warning categories. */
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
  | "PARENT_CONFLICT"
  | "PR_BRANCH_INVALID"
  | "PR_PAIR_CONFLICT"
  | "PR_MERGED"
  | "PR_DRAFT_UNSUPPORTED"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_PROJECT_FIELD"
  | "UNKNOWN_PROJECT_FIELD_OPTION"
  | "UNSUPPORTED_PROJECT_FIELD";

/** Severity label; blocking separately controls whether the plan is safe to execute. */
export type DiagnosticSeverity = "info" | "warning" | "error";

/** Scoped actionable diagnostic, optionally including JSON details. */
export interface GithubDiagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  blocking: boolean;
  logicalId?: LogicalResourceId;
  schemaPath?: string;
  message: string;
  details?: JsonValue;
}

/** Planner/version/mode metadata; version comes from GITHUB_PLAN_VERSION. */
export interface GithubPlanMetadata {
  planner: "gh-plan";
  version: string;
  mode: GithubPlannerMode;
}

/** Count of normalized resources (including root labels) and relationships. */
export interface DesiredStateSummary {
  resourceCount: number;
  relationshipCount: number;
}

/** Counts of proposed operations and diagnostics; never observed execution outcomes. */
export interface GithubPlanSummary {
  planned: number;
  noops: number;
  blocked: number;
  unsupported: number;
  warnings: number;
}

/** Ready has no blockers, ready_with_warnings has warnings, blocked forbids execution. */
export type GithubPlanReadiness = "ready" | "ready_with_warnings" | "blocked";

/** Deterministic read-only proposal. Check readiness before executing the topologically ordered steps. */
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
  /** A blocked plan must not be executed; warnings alone do not block. */
  readiness: GithubPlanReadiness;
}

/** Asynchronous read-only planning entrypoint type; REST discovery may perform GET requests. */
export type PlanGithub = (config: GithubPlannerConfig) => Promise<GithubPlan>;

/** Pure, transport-independent reconciliation intent. */
/** Pure semantic delta classification independent of REST request compilation. */
export type GithubDiffStatus = "create" | "update" | "noop" | "conflict" | "unsupported";
/** One pure desired/observed delta with optional references. */
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
/** Pure semantic deltas and diagnostics; no network traffic. */
export interface GithubDiffResult {
  diffs: GithubDiff[];
  blockers: GithubDiagnostic[];
  warnings: GithubDiagnostic[];
  unsupported: GithubDiagnostic[];
}
