export type {
  GithubPlanSchema, AuthoringIssue, AuthoringManagedIssue, AuthoringReferencedIssue,
  AuthoringMilestone, AuthoringRepositoryLabel, AuthoringRelationship,
  AuthoringPullRequest,
  AuthoringProjectReference,
  AuthoringProjectAssignments,
  AuthoringIssueLabels, AuthoringIssueAssignees, AuthoringIdentity,
  AuthoringMilestoneRef, AuthoringSet, AuthoringRemove,
} from "./authoring-schema.ts";
export { compileIssueLabelSteps } from "./issue-label-compiler.ts";
export { compileRepositoryLabelSteps } from "./repository-label-compiler.ts";
export type { RepositoryLabelCompilationResult } from "./repository-label-compiler.ts";
export { compileIssueAssigneeSteps } from "./issue-assignee-compiler.ts";
export type { IssueAssigneeCompilationResult } from "./issue-assignee-compiler.ts";
export type { IssueLabelCompilationResult } from "./issue-label-compiler.ts";
export { planGithub, GITHUB_PLAN_VERSION } from "./plan.ts";
export { compileRelationshipSteps } from "./relationship-compiler.ts";
export { compilePullRequestSteps } from "./pull-request-compiler.ts";
export { compileProjectItemSteps } from "./project-item-compiler.ts";
export { compilePruneSteps } from "./prune-compiler.ts";
export type { PruneCompilationResult } from "./prune-compiler.ts";
export type { ProjectItemCompilationResult } from "./project-item-compiler.ts";
export type { PullRequestCompilationResult } from "./pull-request-compiler.ts";
export type { RelationshipCompilationResult } from "./relationship-compiler.ts";
export { compileIssueFieldSteps } from "./issue-field-compiler.ts";
export type { IssueFieldCompilationResult } from "./issue-field-compiler.ts";
export { compileIssueSteps } from "./issue-compiler.ts";
export type { IssueCompilationResult } from "./issue-compiler.ts";
export { compileMilestoneSteps } from "./milestone-compiler.ts";
export type { MilestoneCompilationResult } from "./milestone-compiler.ts";
export { bindPlanRequest, requestReferences, validatePlanStepReferences, PlanBindingError } from "./plan-bindings.ts";
export type { BoundPlanRequest, PlanBindingErrorCode } from "./plan-bindings.ts";
export { diffGithubState } from "./diff.ts";
export { normalizeSchema } from "./normalize.ts";
export { discoverAndResolve } from "./discovery.ts";
export type { DiscoveryResolutionResult } from "./discovery.ts";
export type { NormalizationResult } from "./normalize.ts";

export {
  resolveResourceIdentities,
} from "./identity.ts";
export type {
  IdentityResolutionOptions,
  IdentityResolutionResult,
} from "./identity.ts";

export {
  createRestDiscoveryTransport,
  GithubRestTransportError,
} from "./rest.ts";
export type {
  GithubRestTransportErrorCode,
  GithubRestTransportErrorData,
  RestDiscoveryTransportConfig,
} from "./rest.ts";

export type {
  BlockedByRelationship,
  BlocksRelationship,
  DesiredIssueState,
  DesiredPullRequestState,
  DesiredProjectReference,
  DesiredProjectItemAssignment,
  DesiredPullRequestResource,
  DesiredIssueLabels,
  DesiredIssueAssignees,
  DesiredRepositoryLabel,
  DesiredMilestoneState,
  DesiredRelationship,
  DesiredRemove,
  DesiredResource,
  DesiredResourceIdentity,
  DesiredSet,
  DesiredSetOrRemove,
  DesiredStateSummary,
  DiagnosticCode,
  DiagnosticSeverity,
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
  GithubDiagnostic,
  GithubDiff,
  GithubDiffResult,
  GithubDiffStatus,
  GithubDiscoveryTransport,
  GithubPlan,
  GithubPlannerConfig,
  GithubPlannerMode,
  GithubPlanMetadata,
  GithubPlanReadiness,
  GithubPlanSummary,
  GithubStateSnapshot,
  GraphqlPlanRequest,
  HeaderReaderLike,
  HttpMethod,
  JsonPrimitive,
  JsonValue,
  LogicalResourceId,
  LogicalResourceRef,
  ManagedIssueResource,
  ManagedMilestoneResource,
  NormalizedDesiredStateGraph,
  ObservedIssue,
  ObservedPullRequest,
  ObservedProject,
  ObservedProjectItem,
  ObservedProjectField,
  PullRequestBranchCheck,
  ObservedIssueField,
  ObservedIssueFieldOption,
  ObservedIssueType,
  ObservedLabel,
  ObservedMilestone,
  ParentRelationship,
  PlanGithub,
  PlanBindings,
  PlanIdentityProperty,
  PlanJsonValue,
  PlanStringTemplate,
  PlanPath,
  PlanValueRef,
  PlanOperationKind,
  PlanRequest,
  PlanStep,
  PlanStepStatus,
  ReferencedIssueResource,
  ReferencedMilestoneResource,
  RelatesToRelationship,
  RelationshipReconciliationMode,
  RepositoryRef,
  ResolvedGithubIdentity,
  ResourceKind,
  ResourceManagement,
  ResourceResolution,
  ResourceResolutionStatus,
  RestPlanRequest,
} from "./types.ts";

/**
 * Opt-in C2 caller-injected application API (#190).
 * The caller must explicitly acknowledge callback trust and supply independent
 * owner, dispatch, authoritative readback, and catalog functions. Importing
 * this module never executes a plan or contacts GitHub.
 *
 * This is NOT an authenticated GitHub writer: the library cannot prove that
 * supplied callbacks are truthful, fenced, or backed by GitHub. Only the four
 * strict B1 issue/milestone request shapes may be executed, and the whole plan
 * is preflighted before any callback or repository mutation.
 *
 * The separately validated GitHub reference adapter stays INTERNAL; there
 * are no public token, generic transport or ownership-bypass exports.
 */
export { executeCallbackApplyPlan as applyPlan } from "./apply-lifecycle.ts";

// Named C2 types and sanitized error are part of the same public contract.
export { ApplyPlanError } from "./apply-contract.ts";
export type {
  ApplyPlanPhase, ApplyOwnerState, ApplyPlanErrorCode, ApplyPlanErrorDetails,
  ApplyPlanOptions, ApplyPlanResult, ApplyOwnershipAdapter, ApplyDispatcher,
  ApplyPostconditionContext, ApplyPostconditionRead, ApplyPostconditionReader,
  ApplyIssueCatalogReader, ApplyMilestoneCatalogReader, ApplyLogSink,
  SafeApplyLogEntry,
} from "./apply-contract.ts";
