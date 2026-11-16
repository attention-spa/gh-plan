import { resolveResourceIdentities } from "./identity.ts";
import type { IdentityResolutionOptions, IdentityResolutionResult } from "./identity.ts";
import type {
  GithubDiscoveryTransport,
  GithubStateSnapshot,
  NormalizedDesiredStateGraph,
} from "./types.ts";

export interface DiscoveryResolutionResult {
  snapshot: GithubStateSnapshot;
  resolution: IdentityResolutionResult;
}

/** Resolve from broad summaries first; enrich only existing desired issues and relation references. */
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
  return {
    resolution,
    snapshot: await transport.enrich(broad, issueNumbers),
  };
}
