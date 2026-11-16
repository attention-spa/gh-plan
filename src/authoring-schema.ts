/**
 * Public authoring input; the only source for schema/gh-plan.schema.json.
 * normalizeSchema() performs cross-resource and GitHub-specific validation.
 */
/** JSON-serializable field payload; a remove operation is separate from JSON null. */
export type AuthoringJson = string | number | boolean | null
  | AuthoringJson[] | { [key: string]: AuthoringJson };
/** Explicitly assign a value; omitted properties are not managed. */
export interface AuthoringSet<T> { op: "set"; value: T; }
/** Explicitly clear a supported nullable property. */
export interface AuthoringRemove { op: "remove"; }
/** Set or clear form for body, description and other removable properties. */
export type AuthoringSetOrRemove<T> = AuthoringSet<T> | AuthoringRemove;

/** Optional exact identity clues: REST id, node id, issue number and body marker. Explicit IDs precede marker/title lookup and must agree. */
export interface AuthoringIdentity {
  number?: number;
  id?: number;
  nodeId?: string;
  marker?: string;
}
/** Logical resource pointer used for future and existing milestone assignment. */
export interface AuthoringLogicalRef { logicalId: string; }
/** Milestone assignment shorthand: logical ID, logical reference, explicit set or remove. */
export type AuthoringMilestoneRef = string | AuthoringLogicalRef
  | AuthoringSet<string | AuthoringLogicalRef> | AuthoringRemove;
/** Exact labels array or set operation; add/remove only change named labels, preserving others. Omission leaves labels untouched. */
export type AuthoringIssueLabels = string[] | AuthoringSet<string[]>
  | { add: string[]; remove?: string[] }
  | { add?: string[]; remove: string[] };
/** GitHub login assignment using the same exact/incremental forms as labels. Omission never unassigns collaborators. */
export type AuthoringIssueAssignees = AuthoringIssueLabels;

/** Managed issue: requested properties are reconciled; absent properties are not touched. Type and organization fields use display names, not REST IDs. */
export interface AuthoringManagedIssue {
  logicalId: string;
  management?: "managed";
  identity?: AuthoringIdentity;
  title?: string | AuthoringSet<string>;
  body?: string | AuthoringSetOrRemove<string>;
  state?: "open" | "closed" | AuthoringSet<"open" | "closed">;
  milestone?: AuthoringMilestoneRef;
  type?: string | AuthoringSet<string>;
  /** Organization issue fields keyed by field name; value or explicit set/remove. */
  fields?: Record<string, AuthoringJson | AuthoringSet<AuthoringJson> | AuthoringRemove>;
  /** Omitted leaves existing issue labels intact; exact set or targeted add/remove. */
  labels?: AuthoringIssueLabels;
  /** GitHub logins; assignment eligibility is checked by GET during discovery. */
  assignees?: AuthoringIssueAssignees;
  /** Nested children create directed parent links; nested reference-only issues are allowed. */
  children?: AuthoringIssue[];
  /** Logical IDs of issues that block this issue (incoming dependency edges). */
  blockedBy?: string[];
  /** Logical IDs of issues blocked by this issue (outgoing dependency edges). */
  blocks?: string[];
  /** Undirected associations to other issue logical IDs. */
  relatesTo?: string[];
}
/** Existing issue reference for relationships only; authoring a title or other desired state is prohibited. */
export interface AuthoringReferencedIssue {
  logicalId: string;
  management: "reference";
  identity?: AuthoringIdentity;
}
/** Discriminated managed-or-reference issue declaration, optionally nested via children. */
export type AuthoringIssue = AuthoringManagedIssue | AuthoringReferencedIssue;

/** Managed milestone: title is fallback discovery identity when no explicit id is supplied; omitted fields remain unchanged. */
export interface AuthoringManagedMilestone {
  logicalId: string;
  management?: "managed";
  identity?: AuthoringIdentity;
  title?: string | AuthoringSet<string>;
  description?: string | AuthoringSetOrRemove<string>;
  state?: "open" | "closed" | AuthoringSet<"open" | "closed">;
}
/** Existing milestone resource used as a pointer, not mutated or created. */
export interface AuthoringReferencedMilestone {
  logicalId: string;
  management: "reference";
  identity?: AuthoringIdentity;
}
/** Managed or reference-only milestone declaration. */
export type AuthoringMilestone = AuthoringManagedMilestone | AuthoringReferencedMilestone;

/** Managed repository label: case-insensitive name is identity; metadata is optional and never implies deletion or rename. */
export interface AuthoringManagedRepositoryLabel {
  logicalId?: string;
  name: string;
  management?: "managed";
  /** Six hexadecimal digits, without #. */
  color?: string;
  /** Maximum 100 characters; empty string clears. */
  description?: string;
}
/** Existing label referenced by name only; missing labels block and cannot be created from a reference. */
export interface AuthoringReferencedRepositoryLabel {
  logicalId?: string;
  name: string;
  management: "reference";
}
/** Managed or reference-only repository-label declaration, keyed by unique name. */
export type AuthoringRepositoryLabel =
  AuthoringManagedRepositoryLabel | AuthoringReferencedRepositoryLabel;

/** Directed parent/blocked_by/blocks and symmetric relates_to edges. blocks reverses blocked_by; relates_to is deduplicated without direction. */
export type AuthoringRelationship =
  | { kind: "parent"; parent: string; child: string }
  | { kind: "blocked_by"; issue: string; blocker: string }
  | { kind: "blocks"; issue: string; blocked: string }
  | { kind: "relates_to"; from: string; to: string };

/** Managed PR declaration, identified by a unique open head/base pair (or explicit PR number).
 * head and base must be same-repository branch refs, not cross-fork selectors.
 * Existing PRs can change base only when identity.number identifies the original PR. */
export interface AuthoringPullRequest {
  logicalId: string;
  head: string;
  base: string;
  identity?: AuthoringIdentity;
  title?: string | AuthoringSet<string>;
  body?: string | AuthoringSetOrRemove<string>;
  state?: "open" | "closed" | AuthoringSet<"open" | "closed">;
  draft?: boolean | AuthoringSet<boolean>;
  labels?: AuthoringIssueLabels;
  assignees?: AuthoringIssueAssignees;
  /** GitHub user logins only; a requested reviewer is not an approving review. */
  reviewers?: AuthoringIssueAssignees;
  /** Logical IDs of declared issues referenced by a managed Closes #number block. */
  closes?: string[];
}

/** Public ergonomic planGithub() input. Fields omitted from managed resources are not touched.
 * Nested children flatten into parent edges; cross-resource validity is checked at runtime.
 * A string $schema value is an editor hint, not a transport instruction. */
export interface GithubPlanSchema {
  /** Editor schema hint; ignored by the planner when a string. */
  $schema?: string;
  /** owner/name shorthand or repository identity object. */
  repository: string | { fullName: string; id?: number; nodeId?: string };
  /** Optional managed/reference issue trees. */
  issues?: AuthoringIssue[];
  /** Managed pull requests, identified by open head/base pairs. Merging is not supported. */
  pullRequests?: AuthoringPullRequest[];
  /** Optional milestones keyed by logical ID. */
  milestones?: AuthoringMilestone[];
  /** Optional repository-label declarations; omitted labels never imply deletion. */
  labels?: AuthoringRepositoryLabel[];
  /** Native directed and symmetric relationship declarations. */
  relationships?: AuthoringRelationship[];
  /** Defaults reconcile; additive preserves relationships not named in the schema. */
  relationshipMode?: "reconcile" | "additive";
}
