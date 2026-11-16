import { resolveResourceIdentities } from "./identity.ts";
import type { IdentityResolutionOptions, IdentityResolutionResult } from "./identity.ts";
import type {
  GithubDiscoveryTransport,
  GithubStateSnapshot,
  NormalizedDesiredStateGraph,
} from "./types.ts";

/** Combined observed snapshot and the pure logical-ID resolution decisions. */
export interface DiscoveryResolutionResult {
  snapshot: GithubStateSnapshot;
  resolution: IdentityResolutionResult;
}

/**
 * Async, read-only I/O orchestrator for broad discovery then targeted enrichment.
 * Requests broad repository/issues/milestones/types once (paginated where necessary).
 * Existing managed issues and reference relationship endpoints receive per-issue
 * detail reads; newly created issues have no detail calls. Assignee additions
 * trigger eligibility GETs, but removals do not. Transport failures reject.
 * Does not issue any mutating HTTP method.
 */
export async function discoverAndResolve(
  desired: NormalizedDesiredStateGraph,
  transport: GithubDiscoveryTransport,
  options: IdentityResolutionOptions = {},
): Promise<DiscoveryResolutionResult> {
  const broad = await transport.discover(desired);
  const resolution = resolveResourceIdentities(desired, broad, options);
  const required = new Set(
    desired.resources
      .filter((resource) => resource.kind === "issue" && resource.management === "managed")
      .map((resource) => resource.logicalId),
  );
  // Reference-only resources are enriched only when used as relationship endpoints.
  for (const relation of desired.relationships) {
    switch (relation.kind) {
      case "parent":
        required.add(relation.parent);
        required.add(relation.child);
        break;
      case "blocked_by":
        required.add(relation.issue);
        required.add(relation.blocker);
        break;
      case "blocks":
        required.add(relation.issue);
        required.add(relation.blocked);
        break;
      case "relates_to":
        required.add(relation.from);
        required.add(relation.to);
        break;
    }
  }
  const issueNumbers = resolution.resolutions
    .filter((resource) =>
      resource.kind === "issue" && resource.status === "existing"
      && resource.identity?.number !== undefined && required.has(resource.logicalId))
    .map((resource) => resource.identity!.number!);
  // Check only logins that may be assigned. Removals must remain possible
  // even after a collaborator loses repository assignment eligibility.
  const logins = new Map<string, string>();
  for (const resource of desired.resources) {
    if (resource.kind !== "issue" || resource.management !== "managed") continue;
    const operation = resource.desired.assignees;
    if (!operation) continue;
    for (const login of operation.op === "set" ? operation.value : operation.add) {
      logins.set(login.toLowerCase(), logins.get(login.toLowerCase()) ?? login);
    }
  }
  for (const pr of desired.pullRequests ?? []) {
    for (const operation of [pr.desired.assignees]) {
      if (!operation) continue;
      for (const login of operation.op === "set" ? operation.value : operation.add) {
        logins.set(login.toLowerCase(), logins.get(login.toLowerCase()) ?? login);
      }
    }
  }
  const enriched = await transport.enrich(broad, issueNumbers,
    [...logins.values()].sort((a, b) => a.localeCompare(b)));
  const snapshot = desired.pullRequests?.length
    ? await transport.enrichPullRequests?.(enriched, desired.pullRequests)
    : enriched;
  if (!snapshot) throw new Error("PR-aware discovery transport is required for pullRequests.");
  return { resolution, snapshot };
}
