import type {
  GithubDiagnostic, GithubDiffResult, GithubStateSnapshot, JsonValue,
  ManagedIssueResource, NormalizedDesiredStateGraph, PlanPath, PlanStep,
  PlanValueRef, ResourceResolution,
} from "./types.ts";

export interface IssueAssigneeCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
}

const key = (login: string): string => login.toLowerCase();
const stable = (logins: string[]): string[] => logins.sort((a, b) => a.localeCompare(b));

function blocker(id: string, code: GithubDiagnostic["code"], message: string): GithubDiagnostic {
  return { code, severity: "error", blocking: true, logicalId: id,
    schemaPath: "resources." + id + ".assignees", message };
}

function step(id: string, kind: PlanStep["kind"], status: "planned" | "noop",
  current: JsonValue, desired: JsonValue, reason: string,
  dependsOn: string[] = [], request?: PlanStep["request"]): PlanStep {
  return {
    id: kind + ":" + id, kind, logicalId: id, status, current, desired, reason,
    dependsOn: [...new Set(dependsOn)].sort(),
    ...(request ? { request } : {}),
    preconditions: ["Issue identity and assignee eligibility remain valid"],
    expectedPostconditions: status === "noop" ? [] : ["Explicit issue assignee changes are applied"],
    destructive: false, reversible: true,
  };
}

/**
 * Plan only explicitly managed assignees. GitHub's REST API has no PUT
 * equivalent for assignees: exact sets are reconciled as deltas, and
 * incremental operations retain every unmentioned assignee.
 */
export function compileIssueAssigneeSteps(
  desired: NormalizedDesiredStateGraph,
  diff: GithubDiffResult,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
): IssueAssigneeCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [], blockers: GithubDiagnostic[] = [];
  const repository = desired.repository.fullName.split("/");
  if (repository.length !== 2 || repository.some((part) => !part)) {
    blockers.push(blocker("", "INVALID_SCHEMA", "Invalid repository identity."));
    return { steps, noops, blockers };
  }
  const prefix = "/repos/" + repository.map(encodeURIComponent).join("/") + "/issues/";
  const byResolution = new Map(resolutions.map((resolution) => [resolution.logicalId, resolution]));
  const managed = desired.resources.filter((resource): resource is ManagedIssueResource =>
    resource.kind === "issue" && resource.management === "managed" &&
    resource.desired.assignees !== undefined);

  for (const resource of [...managed].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    const id = resource.logicalId;
    if (diff.blockers.some((diagnostic) => diagnostic.logicalId === id)) continue;
    const operation = resource.desired.assignees!;
    const requested = operation.op === "set" ? operation.value : operation.add;
    const unknown = requested.filter((login) => observed.assigneeEligibility?.[key(login)] !== true);
    if (unknown.length) {
      blockers.push(blocker(id, "UNKNOWN_ASSIGNEE",
        "Unknown or ineligible assignees: " + unknown.join(", ") + "."));
      continue;
    }
    const resolution = byResolution.get(id);
    if (!resolution || resolution.kind !== "issue" ||
      (resolution.status !== "existing" && resolution.status !== "new")) {
      blockers.push(blocker(id, "UNRESOLVED_IDENTITY", "Unsafe issue identity resolution."));
      continue;
    }
    const isNew = resolution.status === "new";
    const current = isNew ? undefined : observed.issues.find((issue) =>
      issue.number === resolution.identity?.number &&
      (resolution.identity?.id === undefined || issue.id === resolution.identity.id) &&
      (resolution.identity?.nodeId === undefined || issue.nodeId === resolution.identity.nodeId));
    if (!isNew && (!current || !current.assignees)) {
      blockers.push(blocker(id, "UNRESOLVED_REFERENCE", "Existing issue assignee snapshot is incomplete."));
      continue;
    }
    if (isNew && !diff.diffs.some((entry) =>
      entry.id === "issue.create:" + id && entry.status === "create")) {
      blockers.push(blocker(id, "UNRESOLVED_REFERENCE", "Missing issue.create producer."));
      continue;
    }
    const semantic = diff.diffs.find((entry) => entry.id === "issue.assignees:" + id);
    if (!isNew && (!semantic || !["noop", "update"].includes(semantic.status))) {
      blockers.push(blocker(id, "UNRESOLVED_REFERENCE", "Missing safe assignee semantic diff."));
      continue;
    }
    const currentMap = new Map((current?.assignees ?? []).map((login) => [key(login), login]));
    const target = operation.op === "set"
      ? new Map(operation.value.map((login) => [key(login), login]))
      : new Map(currentMap);
    if (operation.op === "modify") {
      for (const login of operation.remove) target.delete(key(login));
      for (const login of operation.add) target.set(key(login), login);
    }
    const oldLogins = stable([...currentMap.values()]);
    const newLogins = stable([...target.values()]);
    if (semantic?.status === "noop" || (isNew && newLogins.length === 0)) {
      noops.push(step(id, "issue.assignee.set", "noop", oldLogins, newLogins,
        "Assignee set already matches; no mutation."));
      continue;
    }
    const removed = stable([...currentMap]
      .filter(([login]) => !target.has(login)).map(([, login]) => login));
    const added = stable([...target]
      .filter(([login]) => !currentMap.has(login)).map(([, login]) => login));
    const path: PlanPath = isNew
      ? [prefix, { $ref: (id + ".number") as PlanValueRef["$ref"] }, "/assignees"]
      : prefix + current!.number + "/assignees";
    const dependsOn = isNew ? ["issue.create:" + id] : [];
    let removeId: string | undefined;
    if (removed.length) {
      const removal = step(id, "issue.assignee.remove", "planned", oldLogins, newLogins,
        "Remove only explicitly omitted or removed assignees.", dependsOn,
        { protocol: "rest", method: "DELETE", path, body: { assignees: removed } });
      steps.push(removal);
      removeId = removal.id;
    }
    if (added.length) {
      steps.push(step(id, "issue.assignee.add", "planned", oldLogins, newLogins,
        "Add requested eligible assignees without modifying other issue properties.",
        [...dependsOn, ...(removeId ? [removeId] : [])],
        { protocol: "rest", method: "POST", path, body: { assignees: added } }));
    }
    if (!removed.length && !added.length) {
      noops.push(step(id, "issue.assignee.set", "noop", oldLogins, newLogins,
        "Assignee set already matches; no mutation."));
    }
  }
  steps.sort((a, b) => a.id.localeCompare(b.id));
  noops.sort((a, b) => a.id.localeCompare(b.id));
  blockers.sort((a, b) => (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  return { steps, noops, blockers };
}
