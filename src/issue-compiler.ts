import type {
  GithubDiagnostic, GithubDiff, GithubDiffResult, GithubStateSnapshot,
  JsonValue, ManagedIssueResource, NormalizedDesiredStateGraph,
  PlanJsonValue, PlanStep, ResourceResolution,
} from "./types.ts";

export interface IssueCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
}

type IssueProperty = "title" | "body" | "state" | "milestone";

function blocker(logicalId: string, message: string, code: GithubDiagnostic["code"] = "INVALID_SCHEMA"): GithubDiagnostic {
  return {
    code, severity: "error", blocking: true, logicalId,
    schemaPath: "resources." + logicalId, message,
  };
}

function identityMarker(resource: ManagedIssueResource, resolution: ResourceResolution): string {
  return resolution.identity?.marker ?? resource.identity?.marker ??
    "<!-- gh-plan:" + resource.logicalId + " -->";
}

function withMarker(content: string, marker: string): string {
  if (content.includes(marker)) return content;
  return content ? marker + "\n" + content : marker;
}

function issueStep(
  id: string, logicalId: string, kind: PlanStep["kind"], status: "planned" | "noop",
  current: JsonValue | null, desired: JsonValue | null, reason: string,
  dependsOn: string[] = [], request?: PlanStep["request"],
  reversible: PlanStep["reversible"] = true,
): PlanStep {
  return {
    id, logicalId, kind, status, current, desired, reason,
    dependsOn: [...new Set(dependsOn)].sort(),
    ...(request ? { request } : {}),
    preconditions: kind === "issue.create"
      ? ["Repository remains accessible"]
      : ["Issue identity remains valid"],
    expectedPostconditions: status === "noop" ? [] :
      [kind === "issue.create" ? "Created issue resolves to the logical ID" :
        "Explicitly managed issue state matches the intended change"],
    destructive: false, reversible,
  };
}

/** Compile safe core issue mutations from semantic deltas. Never performs network I/O. */
export function compileIssueSteps(
  desired: NormalizedDesiredStateGraph,
  result: GithubDiffResult,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
): IssueCompilationResult {
  const steps: PlanStep[] = [];
  const noops: PlanStep[] = [];
  const managed = desired.resources.filter((r): r is ManagedIssueResource =>
    r.kind === "issue" && r.management === "managed");
  const ids = new Set(managed.map((r) => r.logicalId));
  const blockers = result.blockers.filter((d) => d.logicalId === undefined || ids.has(d.logicalId));
  const byResolution = new Map(resolutions.map((r) => [r.logicalId, r]));
  const byResource = new Map(desired.resources.map((r) => [r.logicalId, r]));
  const segments = desired.repository.fullName.split("/");
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    return { steps, noops, blockers: [...blockers, blocker("", "Invalid repository fullName.")] };
  }
  const prefix = "/repos/" + segments.map(encodeURIComponent).join("/") + "/issues";

  const diffsFor = (logicalId: string): GithubDiff[] =>
    result.diffs.filter((diff) => diff.logicalId === logicalId &&
      (diff.kind === "issue" || diff.kind === "relationship.milestone"));
  const findDiff = (logicalId: string, property: string): GithubDiff | undefined =>
    result.diffs.find((diff) => diff.id === "issue." + property + ":" + logicalId);

  function milestone(
    logicalId: string, ref: string,
  ): { value: PlanJsonValue; dependsOn: string[] } | undefined {
    const resource = byResource.get(ref);
    const resolution = byResolution.get(ref);
    if (!resource || resource.kind !== "milestone" || !resolution ||
      resolution.kind !== "milestone" ||
      (resource.management === "reference" && resolution.status !== "existing")) {
      blockers.push(blocker(logicalId, "Unknown or unsafe milestone reference " + ref + ".", "UNRESOLVED_REFERENCE"));
      return undefined;
    }
    if (resolution.status === "new") {
      if (resource.management !== "managed" ||
        !result.diffs.some((diff) =>
          diff.id === "milestone.create:" + ref && diff.status === "create") ||
        blockers.some((b) => b.logicalId === ref)) {
        blockers.push(blocker(logicalId, "Milestone reference " + ref + " has no safe producing create.", "UNRESOLVED_REFERENCE"));
        return undefined;
      }
      return { value: { $ref: ref + ".number" }, dependsOn: ["milestone.create:" + ref] };
    }
    if (resolution.status !== "existing" ||
      typeof resolution.identity?.number !== "number" ||
      !observed.milestones.some((m) => m.number === resolution.identity?.number)) {
      blockers.push(blocker(logicalId, "Milestone " + ref + " has no observed numeric identity.", "UNRESOLVED_REFERENCE"));
      return undefined;
    }
    return { value: resolution.identity.number, dependsOn: [] };
  }

  for (const resource of [...managed].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    const id = resource.logicalId;
    const resolution = byResolution.get(id);
    const relevant = diffsFor(id);
    if (result.blockers.some((d) => d.logicalId === id) ||
      result.diffs.some((d) => d.logicalId === id && d.status === "conflict")) continue;
    if (!resolution || resolution.kind !== "issue" ||
      (resolution.status !== "existing" && resolution.status !== "new")) {
      blockers.push(blocker(id, "No safe issue identity resolution.", "UNRESOLVED_IDENTITY"));
      continue;
    }
    const token = identityMarker(resource, resolution);
    const d = resource.desired;
    const typeDiff = d.issueType ? findDiff(id, "type") : undefined;
    if (d.issueType && (!typeDiff || typeDiff.status === "conflict" ||
      !["noop", "update"].includes(typeDiff.status) && resolution.status === "existing")) {
      // New issues have a create diff rather than a separate type diff.
      if (resolution.status === "existing" || !observed.issueTypes.some((type) => type.name === d.issueType?.value)) {
        blockers.push(blocker(id, "Issue type cannot be safely reconciled.", "UNKNOWN_ISSUE_TYPE"));
        continue;
      }
    }
    const requestedType = d.issueType?.value;
    if (requestedType !== undefined && observed.issueTypes.filter((type) => type.name === requestedType).length !== 1) {
      blockers.push(blocker(id, "Unknown or ambiguous issue type " + d.issueType.value + ".", "UNKNOWN_ISSUE_TYPE"));
      continue;
    }

    if (resolution.status === "new") {
      if (!result.diffs.some((diff) => diff.id === "issue.create:" + id && diff.status === "create") ||
        !d.title || !d.title.value.trim()) {
        blockers.push(blocker(id, "New issue requires an explicit nonempty title and semantic create."));
        continue;
      }
      const body: Record<string, PlanJsonValue> = {
        title: d.title.value,
        body: withMarker(d.body?.op === "set" ? d.body.value : "", token),
      };
      const dependsOn: string[] = [];
      if (d.issueType) body.type = d.issueType.value;
      if (d.milestone?.op === "set") {
        const target = milestone(id, d.milestone.value.logicalId);
        if (!target) continue;
        body.milestone = target.value;
        dependsOn.push(...target.dependsOn);
      }
      const createId = "issue.create:" + id;
      steps.push(issueStep(createId, id, "issue.create", "planned", null,
        { ...body, ...(d.fields ? { fields: d.fields } : {}) } as JsonValue,
        "Issue does not exist.", dependsOn,
        { protocol: "rest", method: "POST", path: prefix, body }, "partial"));
      // GitHub's issue creation endpoint does not support setting state.
      if (d.state?.value === "closed") {
        steps.push(issueStep("issue.update:" + id, id, "issue.update", "planned",
          { state: "open" }, { state: "closed" },
          "Close the newly created issue.", [createId],
          {
            protocol: "rest", method: "PATCH",
            path: [prefix + "/", { $ref: `${id}.number` as `${string}.number` }], body: { state: "closed" },
          }));
      }
      continue;
    }

    const number = resolution.identity?.number;
    const current = observed.issues.find((issue) => issue.number === number);
    if (!current || typeof number !== "number" ||
      (resolution.identity?.id !== undefined && current.id !== resolution.identity.id) ||
      (resolution.identity?.nodeId !== undefined && current.nodeId !== resolution.identity.nodeId)) {
      blockers.push(blocker(id, "Existing issue is absent or mismatched in snapshot.", "UNRESOLVED_IDENTITY"));
      continue;
    }

    const changed: Record<string, PlanJsonValue> = {};
    const before: Record<string, JsonValue> = {};
    const dependsOn: string[] = [];
    let invalid = false;
    for (const property of ["title", "body", "state", "milestone"] as IssueProperty[]) {
      const operation = d[property];
      if (!operation) continue;
      const diff = findDiff(id, property);
      if (!diff || !["noop", "update"].includes(diff.status)) {
        blockers.push(blocker(id, "Missing or unsafe semantic issue diff for " + property + "."));
        invalid = true;
        break;
      }
      if (diff.status === "noop") continue;
      before[property] = diff.current ?? null;
      if (property === "body") {
        const bodyOp = d.body!;
        changed.body = withMarker(bodyOp.op === "set" ? bodyOp.value : "", token);
      } else if (property === "milestone") {
        const milestoneOp = d.milestone!;
        if (milestoneOp.op === "remove") changed.milestone = null;
        else {
          const target = milestone(id, milestoneOp.value.logicalId);
          if (!target) { invalid = true; break; }
          changed.milestone = target.value;
          dependsOn.push(...target.dependsOn);
        }
      } else if (property === "title") {
        changed.title = d.title!.value;
      } else {
        changed.state = d.state!.value;
      }
    }
    if (invalid) continue;
    // Identity marker adoption is permitted only after upstream resolution to existing;
    // #8 defaults to rejecting title-only adoption without explicit opt-in.
    const missingMarker = !((current.body ?? "").includes(token));
    if (missingMarker) {
      if (changed.body === undefined) changed.body = withMarker(current.body ?? "", token);
      before.body = current.body ?? null;
    }
    if (Object.keys(changed).length > 0) {
      const markerOnly = missingMarker && Object.keys(changed).length === 1 && changed.body !== undefined &&
        !d.body;
      const stepKind = markerOnly ? "issue.marker.adopt" : "issue.update";
      steps.push(issueStep(stepKind + ":" + id, id, stepKind, "planned",
        before, changed, markerOnly ? "Preserve identity by adopting the marker." :
          "Apply only explicitly changed issue properties.", dependsOn,
        { protocol: "rest", method: "PATCH", path: prefix + "/" + number, body: changed },
        changed.body !== undefined ? "partial" : true));
    } else if (typeDiff?.status !== "update") {
      noops.push(issueStep("issue.noop:" + id, id, "issue.update", "noop",
        null, null, relevant.length ? "Explicit issue state matches." : "No issue core properties are managed."));
    }

    if (d.issueType && typeDiff?.status === "update") {
      steps.push(issueStep("issue.type.set:" + id, id, "issue.type.set", "planned",
        { type: current.issueType ?? null }, { type: d.issueType.value },
        "Set discovered issue type.", [],
        { protocol: "rest", method: "PATCH", path: prefix + "/" + number, body: { type: d.issueType.value } }));
    }
  }

  steps.sort((a, b) => a.id.localeCompare(b.id));
  noops.sort((a, b) => a.id.localeCompare(b.id));
  blockers.sort((a, b) => (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  return { steps, noops, blockers };
}
