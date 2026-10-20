export { normalizeSchema } from "./normalize.ts";
export type { NormalizationResult } from "./normalize.ts";

export {
  resolveResourceIdentities,
} from "./identity.ts";
export type {
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
  ObservedIssueField,
  ObservedIssueFieldOption,
  ObservedIssueType,
  ObservedMilestone,
  ParentRelationship,
  PlanGithub,
  PlanOperationKind,
  PlanRequest,
  PlanStep,
  PlanStepStatus,
  ReferencedIssueResource,
  ReferencedMilestoneResource,
  RelatedRelationship,
  RepositoryRef,
  ResolvedGithubIdentity,
  ResourceKind,
  ResourceManagement,
  ResourceResolution,
  ResourceResolutionStatus,
  RestPlanRequest,
} from "./types.ts";
