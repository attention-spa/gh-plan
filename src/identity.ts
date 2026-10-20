import type {
  DesiredResource,
  GithubDiagnostic,
  GithubStateSnapshot,
  NormalizedDesiredStateGraph,
  ObservedIssue,
  ObservedMilestone,
  ResolvedGithubIdentity,
  ResourceResolution,
} from "./types.ts";

export interface IdentityResolutionResult {
  resolutions: ResourceResolution[];
  warnings: GithubDiagnostic[];
  blockers: GithubDiagnostic[];
}

type ObservedResource = ObservedIssue | ObservedMilestone;

function canonicalMarker(logicalId: string): string {
  return `<!-- gh-plan:${logicalId} -->`;
}

function effectiveMarker(resource: DesiredResource): string | undefined {
  if (resource.kind !== "issue") return undefined;
  return resource.identity?.marker ?? canonicalMarker(resource.logicalId);
}

function resourceKey(resource: ObservedResource): string {
  return [
    resource.kind,
    resource.nodeId ?? "",
    resource.id ?? "",
    resource.number,
  ].join(":");
}

function compareObserved(a: ObservedResource, b: ObservedResource): number {
  if (a.number !== b.number) return a.number - b.number;
  const byId = String(a.id ?? "").localeCompare(String(b.id ?? ""));
  if (byId !== 0) return byId;
  return String(a.nodeId ?? "").localeCompare(String(b.nodeId ?? ""));
}

function identityFromObserved(
  resource: ObservedResource,
  marker?: string,
): ResolvedGithubIdentity {
  return {
    number: resource.number,
    ...(resource.id === undefined ? {} : { id: resource.id }),
    ...(resource.nodeId === undefined ? {} : { nodeId: resource.nodeId }),
    ...(marker === undefined ? {} : { marker }),
  };
}

function candidateIdentities(
  resources: ObservedResource[],
  marker?: string,
): ResolvedGithubIdentity[] {
  return [...resources]
    .sort(compareObserved)
    .map((resource) => identityFromObserved(resource, marker));
}

function diagnostic(
  code: "AMBIGUOUS_IDENTITY" | "UNRESOLVED_IDENTITY" | "UNRESOLVED_REFERENCE" | "INVALID_SCHEMA",
  message: string,
  logicalId?: string,
): GithubDiagnostic {
  return {
    code,
    severity: "error",
    blocking: true,
    ...(logicalId === undefined ? {} : {
      logicalId,
      schemaPath: `resources.${logicalId}.identity`,
    }),
    message,
  };
}

function sortDiagnostics(items: GithubDiagnostic[]): GithubDiagnostic[] {
  return items.sort((a, b) => {
    const byLogicalId = (a.logicalId ?? "").localeCompare(b.logicalId ?? "");
    if (byLogicalId !== 0) return byLogicalId;
    const byCode = a.code.localeCompare(b.code);
    if (byCode !== 0) return byCode;
    return a.message.localeCompare(b.message);
  });
}

function sameRepository(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
): boolean {
  if (desired.repository.fullName.toLowerCase() !== observed.repository.fullName.toLowerCase()) {
    return false;
  }
  if (
    desired.repository.id !== undefined
    && observed.repository.id !== undefined
    && desired.repository.id !== observed.repository.id
  ) {
    return false;
  }
  return true;
}

function observedFor(
  resource: DesiredResource,
  snapshot: GithubStateSnapshot,
): ObservedResource[] {
  return resource.kind === "issue" ? snapshot.issues : snapshot.milestones;
}

function titleOf(resource: DesiredResource): string | undefined {
  if (resource.management !== "managed") return undefined;
  const title = resource.desired.title;
  return title?.op === "set" ? title.value : undefined;
}

function unresolved(
  resource: DesiredResource,
  blockers: GithubDiagnostic[],
  message: string,
): ResourceResolution {
  blockers.push(diagnostic(
    resource.management === "reference" ? "UNRESOLVED_REFERENCE" : "UNRESOLVED_IDENTITY",
    message,
    resource.logicalId,
  ));
  return {
    logicalId: resource.logicalId,
    kind: resource.kind,
    status: "unresolved",
  };
}

function ambiguous(
  resource: DesiredResource,
  matches: ObservedResource[],
  blockers: GithubDiagnostic[],
  message: string,
): ResourceResolution {
  const marker = effectiveMarker(resource);
  blockers.push(diagnostic("AMBIGUOUS_IDENTITY", message, resource.logicalId));
  return {
    logicalId: resource.logicalId,
    kind: resource.kind,
    status: "ambiguous",
    ...(matches.length === 0 ? {} : {
      candidates: candidateIdentities(matches, marker),
    }),
  };
}

function uniqueObserved(resources: ObservedResource[]): ObservedResource[] {
  const byKey = new Map<string, ObservedResource>();
  for (const resource of resources) byKey.set(resourceKey(resource), resource);
  return [...byKey.values()].sort(compareObserved);
}

function resolveOne(
  resource: DesiredResource,
  snapshot: GithubStateSnapshot,
  blockers: GithubDiagnostic[],
): ResourceResolution {
  const observed = observedFor(resource, snapshot);
  const identity = resource.identity;
  const marker = effectiveMarker(resource);

  const explicitHints: Array<{ label: string; matches: ObservedResource[] }> = [];
  if (identity?.id !== undefined) {
    explicitHints.push({
      label: "REST id",
      matches: observed.filter((item) => item.id === identity.id),
    });
  }
  if (identity?.nodeId !== undefined) {
    explicitHints.push({
      label: "node id",
      matches: observed.filter((item) => item.nodeId === identity.nodeId),
    });
  }
  if (identity?.number !== undefined) {
    explicitHints.push({
      label: "number",
      matches: observed.filter((item) => item.number === identity.number),
    });
  }

  if (explicitHints.length > 0) {
    const multiMatch = explicitHints.flatMap((hint) => hint.matches).filter((item, index, all) => {
      return all.findIndex((candidate) => resourceKey(candidate) === resourceKey(item)) === index;
    });

    if (explicitHints.some((hint) => hint.matches.length === 0)) {
      return unresolved(
        resource,
        blockers,
        `Explicit identity for ${resource.logicalId} does not exist in the observed ${resource.kind} snapshot.`,
      );
    }
    if (explicitHints.some((hint) => hint.matches.length > 1)) {
      return ambiguous(
        resource,
        multiMatch,
        blockers,
        `Explicit identity for ${resource.logicalId} matches multiple observed resources.`,
      );
    }

    const explicitMatches = uniqueObserved(explicitHints.map((hint) => hint.matches[0]!));
    if (explicitMatches.length !== 1) {
      return ambiguous(
        resource,
        explicitMatches,
        blockers,
        `Explicit identity hints for ${resource.logicalId} do not agree on one observed resource.`,
      );
    }

    const selected = explicitMatches[0]!;
    if (resource.kind === "issue" && marker !== undefined) {
      const markerMatches = snapshot.issues.filter((issue) => issue.body?.includes(marker) === true);
      if (markerMatches.length > 1) {
        return ambiguous(
          resource,
          markerMatches,
          blockers,
          `Marker for ${resource.logicalId} appears on multiple observed issues.`,
        );
      }
      if (markerMatches.length === 1 && resourceKey(markerMatches[0]!) !== resourceKey(selected)) {
        return ambiguous(
          resource,
          [selected, markerMatches[0]!],
          blockers,
          `Explicit identity and marker for ${resource.logicalId} identify different issues.`,
        );
      }
    }

    return {
      logicalId: resource.logicalId,
      kind: resource.kind,
      status: "existing",
      identity: identityFromObserved(selected, marker),
    };
  }

  if (resource.kind === "issue" && marker !== undefined) {
    const markerMatches = snapshot.issues.filter((issue) => issue.body?.includes(marker) === true);
    if (markerMatches.length > 1) {
      return ambiguous(
        resource,
        markerMatches,
        blockers,
        `Marker for ${resource.logicalId} appears on multiple observed issues.`,
      );
    }
    if (markerMatches.length === 1) {
      return {
        logicalId: resource.logicalId,
        kind: resource.kind,
        status: "existing",
        identity: identityFromObserved(markerMatches[0]!, marker),
      };
    }
  }

  const title = titleOf(resource);
  if (title !== undefined) {
    const titleMatches = observed.filter((item) => item.title === title);
    if (titleMatches.length > 1) {
      return ambiguous(
        resource,
        titleMatches,
        blockers,
        `Exact title for ${resource.logicalId} matches multiple observed ${resource.kind}s.`,
      );
    }
    if (titleMatches.length === 1) {
      return {
        logicalId: resource.logicalId,
        kind: resource.kind,
        status: "existing",
        identity: identityFromObserved(titleMatches[0]!, marker),
      };
    }
  }

  if (resource.management === "reference") {
    return unresolved(
      resource,
      blockers,
      `Reference ${resource.logicalId} could not be resolved to an observed ${resource.kind}.`,
    );
  }

  return {
    logicalId: resource.logicalId,
    kind: resource.kind,
    status: "new",
    ...(marker === undefined ? {} : { identity: { marker } }),
  };
}

export function resolveResourceIdentities(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
): IdentityResolutionResult {
  const blockers: GithubDiagnostic[] = [];
  const resources = [...desired.resources].sort((a, b) => a.logicalId.localeCompare(b.logicalId));

  if (!sameRepository(desired, observed)) {
    blockers.push(diagnostic(
      "INVALID_SCHEMA",
      `Observed repository ${observed.repository.fullName} does not match desired repository ${desired.repository.fullName}.`,
    ));
    return {
      resolutions: resources.map((resource) => ({
        logicalId: resource.logicalId,
        kind: resource.kind,
        status: "unresolved",
      })),
      warnings: [],
      blockers: sortDiagnostics(blockers),
    };
  }

  const resolutions = resources.map((resource) => resolveOne(resource, observed, blockers));
  return {
    resolutions,
    warnings: [],
    blockers: sortDiagnostics(blockers),
  };
}
