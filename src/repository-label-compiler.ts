import type {
  GithubDiagnostic, GithubDiffResult, GithubStateSnapshot, JsonValue,
  NormalizedDesiredStateGraph, PlanStep,
} from "./types.ts";

/** Pure output: repository-label create/PATCH requests, noops and name-identity blockers. */
export interface RepositoryLabelCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
}

const key = (name: string): string => name.toLowerCase();

function diagnostic(id: string, code: GithubDiagnostic["code"], message: string): GithubDiagnostic {
  return { code, severity: "error", blocking: true, logicalId: id,
    schemaPath: "labels." + id, message };
}
function step(id: string, kind: PlanStep["kind"], status: "planned" | "noop",
  current: JsonValue | null, desired: JsonValue | null, reason: string,
  request?: PlanStep["request"]): PlanStep {
  return {
    id: kind + ":" + id, kind, logicalId: id, status, current, desired, reason,
    dependsOn: [], ...(request ? { request } : {}),
    preconditions: ["Repository label identity remains name-unique"],
    expectedPostconditions: status === "noop" ? [] : ["Managed repository label metadata matches"],
    destructive: false, reversible: kind === "label.create" ? "partial" : true,
  };
}

/**
 * Pure repository-label compiler keyed by case-insensitive names. Missing
 * managed labels produce POST create, changed declared metadata uses PATCH;
 * omitted metadata is preserved. Never generates rename or deletion.
 * References must exist. Unknown/ambiguous catalog identities block safely.
 * No network I/O or actual repository mutation.
 */
export function compileRepositoryLabelSteps(
  desired: NormalizedDesiredStateGraph,
  diff: GithubDiffResult,
  observed: GithubStateSnapshot,
): RepositoryLabelCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [], blockers: GithubDiagnostic[] = [];
  const repository = desired.repository.fullName.split("/");
  if (repository.length !== 2 || repository.some((part) => !part)) {
    blockers.push(diagnostic("", "INVALID_SCHEMA", "Invalid repository identity."));
    return { steps, noops, blockers };
  }
  const prefix = "/repos/" + repository.map(encodeURIComponent).join("/") + "/labels";
  for (const label of [...(desired.labels ?? [])].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))) {
    const id = label.logicalId;
    if (diff.blockers.some((error) => error.logicalId === id)) continue;
    if (!observed.labels) {
      blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE", "Repository label catalog is absent."));
      continue;
    }
    const matches = observed.labels.filter((entry) => key(entry.name) === key(label.name));
    if (matches.length > 1) {
      blockers.push(diagnostic(id, "AMBIGUOUS_IDENTITY", "Ambiguous repository label name."));
      continue;
    }
    const current = matches[0];
    if (label.management === "reference") {
      if (!current) blockers.push(diagnostic(id, "UNKNOWN_LABEL", "Reference label does not exist."));
      continue;
    }
    if (!current) {
      const creation = diff.diffs.find((entry) => entry.id === "label.create:" + id);
      if (creation?.status !== "create") {
        blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE", "Missing safe repository label create diff."));
        continue;
      }
      const body = {
        name: label.name, color: label.color ?? "ededed",
        ...(label.description === undefined ? {} : { description: label.description }),
      };
      steps.push(step(id, "label.create", "planned", null, body,
        "Create missing managed repository label.", {
          protocol: "rest", method: "POST", path: prefix, body,
        }));
      continue;
    }

    const oldValues: Record<string, JsonValue> = {};
    const newValues: Record<string, JsonValue> = {};
    const changed: Record<string, JsonValue> = {};
    let invalid = false;
    if (label.color !== undefined) {
      const semantic = diff.diffs.find((entry) => entry.id === "label.color:" + id);
      if (!semantic || !["noop", "update"].includes(semantic.status)) invalid = true;
      else if (semantic.status === "update") {
        oldValues.color = current.color ?? null;
        changed.color = label.color;
        newValues.color = label.color;
      }
    }
    if (label.description !== undefined) {
      const semantic = diff.diffs.find((entry) => entry.id === "label.description:" + id);
      if (!semantic || !["noop", "update"].includes(semantic.status)) invalid = true;
      else if (semantic.status === "update") {
        oldValues.description = current.description ?? "";
        changed.description = label.description;
        newValues.description = label.description;
      }
    }
    if (invalid) {
      blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE", "Missing safe repository label metadata diff."));
      continue;
    }
    if (Object.keys(changed).length) {
      steps.push(step(id, "label.update", "planned", oldValues, newValues,
        "Update only explicitly changed repository label properties.", {
          protocol: "rest", method: "PATCH",
          path: prefix + "/" + encodeURIComponent(current.name), body: changed,
        }));
    } else {
      noops.push(step(id, "label.update", "noop", null, null,
        "Repository label exists with all explicitly managed metadata satisfied."));
    }
  }
  const byId = (a: PlanStep, b: PlanStep) => a.id.localeCompare(b.id);
  return {
    steps: steps.sort(byId), noops: noops.sort(byId),
    blockers: blockers.sort((a, b) => (a.logicalId ?? "").localeCompare(b.logicalId ?? "")),
  };
}
