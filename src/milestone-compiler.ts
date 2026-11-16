import { toGithubMilestoneDueOn } from "./milestone-due-date.ts";
import type {
  GithubDiagnostic, GithubDiff, GithubDiffResult, JsonValue,
  ManagedMilestoneResource, NormalizedDesiredStateGraph, PlanStep, ResourceResolution,
} from "./types.ts";

/**
 * Milestone compiler result: proposed REST creation/updates, noops and blockers.
 * Pure: no discovery or mutation; callers compose these steps into the DAG.
 */
export interface MilestoneCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
}

const PROPERTIES = ["title", "description", "state", "due_on"] as const;
type MilestoneProperty = typeof PROPERTIES[number];

function diagnostic(logicalId: string, message: string): GithubDiagnostic {
  return {
    code: "INVALID_SCHEMA",
    severity: "error",
    blocking: true,
    logicalId,
    schemaPath: "resources." + logicalId,
    message,
  };
}

function diffFor(diffs: GithubDiff[], logicalId: string, property: MilestoneProperty): GithubDiff | undefined {
  return diffs.find((diff) => diff.id === "milestone." + property + ":" + logicalId);
}

function step(
  id: string,
  logicalId: string,
  kind: "milestone.create" | "milestone.update",
  status: "planned" | "noop",
  current: JsonValue | null,
  desired: JsonValue | null,
  reason: string,
  request?: PlanStep["request"],
  reversible: PlanStep["reversible"] = true,
): PlanStep {
  return {
    id, kind, logicalId, status, current, desired, reason,
    dependsOn: [],
    ...(request === undefined ? {} : { request }),
    preconditions: kind === "milestone.update" ? ["Milestone identity remains valid"] :
      ["Repository remains accessible"],
    expectedPostconditions: status === "noop" ? [] :
      [kind === "milestone.create" ? "Milestone resolves to a new GitHub milestone" :
        "Explicitly managed milestone properties match desired values"],
    destructive: false,
    reversible,
  };
}

/**
 * Pure milestone compiler: creates missing managed milestones; existing ones
 * get PATCH only for explicitly changed fields, preserving omitted metadata.
 * Reference-only milestones never change. Unsafe identities block; no HTTP I/O.
 */
export function compileMilestoneSteps(
  desired: NormalizedDesiredStateGraph,
  result: GithubDiffResult,
  resolutions: ResourceResolution[],
): MilestoneCompilationResult {
  const steps: PlanStep[] = [];
  const noops: PlanStep[] = [];
  const blockers = result.blockers.filter((item) =>
    item.logicalId === undefined || desired.resources.some((resource) =>
      resource.kind === "milestone" && resource.logicalId === item.logicalId));
  const resolutionById = new Map(resolutions.map((item) => [item.logicalId, item]));
  const repoPath = desired.repository.fullName.split("/").map(encodeURIComponent).join("/");
  if (desired.repository.fullName.split("/").length !== 2) {
    return { steps, noops, blockers: [...blockers, diagnostic("", "Invalid repository name.")] };
  }

  const milestones = desired.resources.filter((resource): resource is ManagedMilestoneResource =>
    resource.kind === "milestone" && resource.management === "managed");
  for (const resource of [...milestones].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    const id = resource.logicalId;
    const resolution = resolutionById.get(id);
    const relevant = result.diffs.filter((diff) => diff.kind === "milestone" && diff.logicalId === id);
    const hasConflict = result.diffs.some((diff) =>
      diff.logicalId === id && diff.status === "conflict") ||
      blockers.some((blocker) => blocker.logicalId === id);
    if (hasConflict) continue;
    if (!resolution || resolution.kind !== "milestone" ||
      !["existing", "new"].includes(resolution.status)) {
      blockers.push(diagnostic(id, "Milestone lacks a safe existing/new resolution."));
      continue;
    }

    if (resolution.status === "new") {
      const create = relevant.find((diff) => diff.id === "milestone.create:" + id && diff.status === "create");
      const title = resource.desired.title?.value;
      if (!create || typeof title !== "string" || title.length === 0) {
        blockers.push(diagnostic(id, "New milestone requires a nonempty desired title and create diff."));
        continue;
      }
      const body: Record<string, JsonValue> = { title };
      const description = resource.desired.description;
      if (description?.op === "set") body.description = description.value;
      // Removal on a new milestone is already satisfied by omission.
      if (resource.desired.state) body.state = resource.desired.state.value;
      if (resource.desired.due_on?.op === "set")
        body.due_on = toGithubMilestoneDueOn(resource.desired.due_on.value);
      // Explicit remove on creation is satisfied by omission, like description.
      steps.push(step("milestone.create:" + id, id, "milestone.create", "planned",
        null, body, "Milestone does not exist.",
        { protocol: "rest", method: "POST", path: "/repos/" + repoPath + "/milestones", body },
        "partial"));
      continue;
    }

    const number = resolution.identity?.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
      blockers.push(diagnostic(id, "Existing milestone requires a valid numeric identity."));
      continue;
    }
    const changed: Record<string, JsonValue> = {};
    const before: Record<string, JsonValue> = {};
    let clearDescription = false;
    let invalid = false;
    for (const property of PROPERTIES) {
      const op = resource.desired[property];
      if (!op) continue;
      const diff = diffFor(relevant, id, property);
      if (!diff || diff.status === "conflict" || diff.status === "unsupported" ||
        (diff.status !== "noop" && diff.status !== "update")) {
        blockers.push(diagnostic(id, "No safe semantic diff for " + property + "."));
        invalid = true;
        break;
      }
      if (diff.status === "noop") continue;
      if (property === "description") {
        clearDescription = op.op === "remove";
        changed.description = op.op === "remove" ? "" : op.value;
      } else if (property === "due_on") {
        changed.due_on = op.op === "remove" ? null : toGithubMilestoneDueOn(op.value);
      } else if (op.op === "set") {
        changed[property] = op.value;
      } else {
        blockers.push(diagnostic(id, "Unsupported removal of milestone " + property + "."));
        invalid = true;
        break;
      }
      before[property] = diff.current ?? null;
    }
    if (invalid) continue;
    if (Object.keys(changed).length === 0) {
      noops.push(step("milestone.noop:" + id, id, "milestone.update", "noop",
        null, null, relevant.length ? "Explicit milestone properties already match." :
          "No milestone properties are explicitly managed."));
      continue;
    }
    steps.push(step("milestone.update:" + id, id, "milestone.update", "planned",
      before, changed, "Only explicitly changed milestone properties are updated.",
      { protocol: "rest", method: "PATCH", path: "/repos/" + repoPath + "/milestones/" + number, body: changed },
      clearDescription || changed.due_on === null ? "partial" : true));
  }
  return {
    steps: steps.sort((a, b) => a.id.localeCompare(b.id)),
    noops: noops.sort((a, b) => a.id.localeCompare(b.id)),
    blockers: blockers.sort((a, b) =>
      (a.logicalId ?? "").localeCompare(b.logicalId ?? "") || a.message.localeCompare(b.message)),
  };
}
