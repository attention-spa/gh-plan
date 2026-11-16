/**
 * Public authoring input; the only source for schema/gh-plan.schema.json.
 * normalizeSchema() performs cross-resource and GitHub-specific validation.
 */
export type AuthoringJson = string | number | boolean | null
  | AuthoringJson[] | { [key: string]: AuthoringJson };
export interface AuthoringSet<T> { op: "set"; value: T; }
export interface AuthoringRemove { op: "remove"; }
export type AuthoringSetOrRemove<T> = AuthoringSet<T> | AuthoringRemove;

export interface AuthoringIdentity {
  number?: number;
  id?: number;
  nodeId?: string;
  marker?: string;
}
export interface AuthoringLogicalRef { logicalId: string; }
export type AuthoringMilestoneRef = string | AuthoringLogicalRef
  | AuthoringSet<string | AuthoringLogicalRef> | AuthoringRemove;
export type AuthoringIssueLabels = string[] | AuthoringSet<string[]>
  | { add: string[]; remove?: string[] }
  | { add?: string[]; remove: string[] };
export type AuthoringIssueAssignees = AuthoringIssueLabels;

export interface AuthoringManagedIssue {
  logicalId: string;
  management?: "managed";
  identity?: AuthoringIdentity;
  title?: string | AuthoringSet<string>;
  body?: string | AuthoringSetOrRemove<string>;
  state?: "open" | "closed" | AuthoringSet<"open" | "closed">;
  milestone?: AuthoringMilestoneRef;
  type?: string | AuthoringSet<string>;
  fields?: Record<string, AuthoringJson | AuthoringSet<AuthoringJson> | AuthoringRemove>;
  labels?: AuthoringIssueLabels;
  assignees?: AuthoringIssueAssignees;
  children?: AuthoringIssue[];
  blockedBy?: string[];
  blocks?: string[];
  relatesTo?: string[];
}
export interface AuthoringReferencedIssue {
  logicalId: string;
  management: "reference";
  identity?: AuthoringIdentity;
}
export type AuthoringIssue = AuthoringManagedIssue | AuthoringReferencedIssue;

export interface AuthoringManagedMilestone {
  logicalId: string;
  management?: "managed";
  identity?: AuthoringIdentity;
  title?: string | AuthoringSet<string>;
  description?: string | AuthoringSetOrRemove<string>;
  state?: "open" | "closed" | AuthoringSet<"open" | "closed">;
}
export interface AuthoringReferencedMilestone {
  logicalId: string;
  management: "reference";
  identity?: AuthoringIdentity;
}
export type AuthoringMilestone = AuthoringManagedMilestone | AuthoringReferencedMilestone;

export interface AuthoringManagedRepositoryLabel {
  logicalId?: string;
  name: string;
  management?: "managed";
  /** Six hexadecimal digits, without #. */
  color?: string;
  /** Maximum 100 characters; empty string clears. */
  description?: string;
}
export interface AuthoringReferencedRepositoryLabel {
  logicalId?: string;
  name: string;
  management: "reference";
}
export type AuthoringRepositoryLabel =
  AuthoringManagedRepositoryLabel | AuthoringReferencedRepositoryLabel;

export type AuthoringRelationship =
  | { kind: "parent"; parent: string; child: string }
  | { kind: "blocked_by"; issue: string; blocker: string }
  | { kind: "blocks"; issue: string; blocked: string }
  | { kind: "relates_to"; from: string; to: string };

/** Public ergonomic input to planGithub(); omit fields you do not manage. */
export interface GithubPlanSchema {
  /** Editor schema hint; ignored by the planner when a string. */
  $schema?: string;
  repository: string | { fullName: string; id?: number; nodeId?: string };
  issues?: AuthoringIssue[];
  milestones?: AuthoringMilestone[];
  labels?: AuthoringRepositoryLabel[];
  relationships?: AuthoringRelationship[];
  relationshipMode?: "reconcile" | "additive";
}
