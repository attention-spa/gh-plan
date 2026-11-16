import { normalizeSchema } from "./normalize.ts";
import { discoverAndResolve } from "./discovery.ts";
import { diffGithubState } from "./diff.ts";
import { compileMilestoneSteps } from "./milestone-compiler.ts";
import { compileIssueSteps } from "./issue-compiler.ts";
import { compileIssueFieldSteps } from "./issue-field-compiler.ts";
import { compileRelationshipSteps } from "./relationship-compiler.ts";
import { validatePlanStepReferences } from "./plan-bindings.ts";
import { createRestDiscoveryTransport, GithubRestTransportError } from "./rest.ts";
import type {
  GithubDiagnostic, GithubPlan, GithubPlannerConfig, GithubPlannerMode,
  NormalizedDesiredStateGraph, PlanStep, ResourceResolution,
} from "./types.ts";

export const GITHUB_PLAN_VERSION = "0.1.0";

type Parts = {
  steps?: PlanStep[];
  noops?: PlanStep[];
  warnings?: GithubDiagnostic[];
  blockers?: GithubDiagnostic[];
  unsupported?: GithubDiagnostic[];
};

function sortedDiagnostics(values: GithubDiagnostic[]): GithubDiagnostic[] {
  const unique = new Map<string, GithubDiagnostic>();
  for (const value of values) {
    const key = JSON.stringify([value.code, value.severity, value.blocking,
      value.logicalId ?? "", value.schemaPath ?? "", value.message, value.details ?? null]);
    unique.set(key, value);
  }
  return [...unique.values()].sort((a, b) =>
    (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    (a.schemaPath ?? "").localeCompare(b.schemaPath ?? "") ||
    a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}
function diagnostic(code: GithubDiagnostic["code"], message: string,
  details?: GithubDiagnostic["details"]): GithubDiagnostic {
  return {
    code, severity: "error", blocking: true, schemaPath: "$.transport", message,
    ...(details === undefined ? {} : { details }),
  };
}
function mapTransport(error: unknown): GithubDiagnostic {
  if (!(error instanceof GithubRestTransportError)) {
    // No exception messages are passed through: they may contain credentials.
    return diagnostic("NO_REST_TRANSPORT", "REST discovery failed unexpectedly.");
  }
  const code: GithubDiagnostic["code"] = error.code === "AUTH_FAILED" ? "AUTH_FAILED" :
    error.code === "NOT_FOUND" ? "REPOSITORY_NOT_FOUND" :
    error.code === "FORBIDDEN" ? "INSUFFICIENT_PERMISSION" :
    error.code === "RATE_LIMITED" ? "RATE_LIMITED" :
    error.code === "NO_REST_TRANSPORT" ? "NO_REST_TRANSPORT" : "NO_REST_TRANSPORT";
  return diagnostic(code, "REST discovery failed (" + error.code + ").",
    { path: error.path, ...(error.status === undefined ? {} : { status: error.status }) });
}
function cycleDiagnostics(steps: PlanStep[]): GithubDiagnostic[] {
  const ids = new Set<string>();
  const blockers: GithubDiagnostic[] = [];
  for (const step of steps) {
    if (ids.has(step.id)) {
      blockers.push(diagnostic("INVALID_SCHEMA", "Duplicate plan step ID: " + step.id + "."));
    }
    ids.add(step.id);
  }
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) { cyclic.add(id); return; }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) {
        blockers.push(diagnostic("UNRESOLVED_REFERENCE",
          "Missing plan dependency " + dep + " required by " + id + "."));
        continue;
      }
      visit(dep);
      if (cyclic.has(dep)) cyclic.add(id);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  for (const id of [...cyclic].sort()) {
    blockers.push(diagnostic("RELATIONSHIP_CYCLE", "Plan step dependency cycle includes " + id + "."));
  }
  return blockers;
}
function topological(steps: PlanStep[]): PlanStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const ordered: PlanStep[] = [];
  const visit = (step: PlanStep): void => {
    if (visited.has(step.id)) return;
    visited.add(step.id);
    for (const id of [...step.dependsOn].sort()) {
      const dependency = byId.get(id);
      if (dependency) visit(dependency);
    }
    ordered.push(step);
  };
  for (const step of [...steps].sort((a, b) => a.id.localeCompare(b.id))) visit(step);
  return ordered;
}

/** Assemble a complete, stable public plan without retaining runtime credentials. */
function assemble(
  repository: GithubPlan["repository"],
  mode: GithubPlannerMode,
  desired: GithubPlan["desired"],
  resolutions: ResourceResolution[],
  pieces: Parts[],
): GithubPlan {
  const steps = pieces.flatMap((piece) => piece.steps ?? []);
  const noops = pieces.flatMap((piece) => piece.noops ?? []);
  const warnings = sortedDiagnostics(pieces.flatMap((piece) => piece.warnings ?? []));
  const unsupported = sortedDiagnostics(pieces.flatMap((piece) => piece.unsupported ?? []));
  const blockers = sortedDiagnostics([
    ...pieces.flatMap((piece) => piece.blockers ?? []),
    ...validatePlanStepReferences(steps),
    ...cycleDiagnostics(steps),
  ]);
  // A blocked plan can still expose candidate operations for inspection, but
  // external integrations must check readiness before executing any request.
  const readiness = blockers.length ? "blocked" :
    warnings.length || unsupported.length ? "ready_with_warnings" : "ready";
  return {
    metadata: { planner: "gh-plan", version: GITHUB_PLAN_VERSION, mode },
    repository, desired,
    resolutions: [...resolutions].sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
    steps: topological(steps),
    noops: noops.sort((a, b) => a.id.localeCompare(b.id)),
    warnings, blockers, unsupported,
    summary: {
      planned: steps.filter((step) => step.status === "planned").length,
      noops: noops.length,
      blocked: blockers.length,
      unsupported: unsupported.length,
      warnings: warnings.length,
    },
    readiness,
  };
}

/**
 * Read-only planner. The sole network-capable dependency is REST discovery;
 * compilers never issue mutations or require a GitHub SDK.
 */
export async function planGithub(config: GithubPlannerConfig): Promise<GithubPlan> {
  const mode = config.mode ?? "rest";
  const normalization = normalizeSchema(config.schema);
  const graph: NormalizedDesiredStateGraph | undefined = normalization.graph;
  const repository = graph?.repository ??
    { fullName: "" };
  const counts = {
    resourceCount: graph?.resources.length ?? 0,
    relationshipCount: graph?.relationships.length ?? 0,
  };
  if (!normalization.ok || !graph) {
    return assemble(repository, mode, counts, [], [
      { blockers: normalization.diagnostics.filter((d) => d.blocking),
        warnings: normalization.diagnostics.filter((d) => !d.blocking) },
    ]);
  }
  const normalizationWarnings = normalization.diagnostics.filter((d) => !d.blocking);
  if (mode === "graphql") {
    return assemble(repository, mode, counts, [], [
      { blockers: [diagnostic("NO_GRAPHQL_TRANSPORT",
        "GraphQL planning is unavailable; use the REST transport.")] },
      { warnings: normalizationWarnings },
    ]);
  }
  let snapshot: Awaited<ReturnType<typeof discoverAndResolve>>["snapshot"];
  let resolution: Awaited<ReturnType<typeof discoverAndResolve>>["resolution"];
  try {
    const rest = createRestDiscoveryTransport({
      auth: config.auth, ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.enrichConcurrency === undefined ? {} : { enrichConcurrency: config.enrichConcurrency }),
    });
    ({ snapshot, resolution } = await discoverAndResolve(graph, rest, {
      adoptByTitle: config.adoptByTitle,
    }));
  } catch (error) {
    return assemble(repository, mode, counts, [], [
      { blockers: [mapTransport(error)] },
      { warnings: normalizationWarnings },
    ]);
  }

  const semantic = diffGithubState(graph, snapshot, resolution.resolutions);
  const milestone = compileMilestoneSteps(graph, semantic, resolution.resolutions);
  const issues = compileIssueSteps(graph, semantic, snapshot, resolution.resolutions);
  const fields = compileIssueFieldSteps(graph, semantic, snapshot, resolution.resolutions);
  const relationships = compileRelationshipSteps(graph, semantic, snapshot, resolution.resolutions, mode);
  return assemble(snapshot.repository, mode, counts, resolution.resolutions, [
    { warnings: normalizationWarnings },
    resolution,
    semantic,
    milestone,
    issues,
    fields,
    relationships,
  ]);
}
