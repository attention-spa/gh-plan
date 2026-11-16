import type {
  DesiredRelationship, GithubDiagnostic, GithubDiffResult, GithubPlannerMode,
  GithubStateSnapshot, JsonValue, NormalizedDesiredStateGraph, ObservedIssue,
  PlanPath, PlanStep, PlanValueRef, ResourceResolution,
} from "./types.ts";

export interface RelationshipCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
  warnings: GithubDiagnostic[];
  unsupported: GithubDiagnostic[];
}
type Endpoint = {
  logicalId: string; number?: number; id?: number;
  isNew: boolean; managed: boolean; observed?: ObservedIssue;
};
function diagnostic(id: string, code: GithubDiagnostic["code"], message: string,
  severity: GithubDiagnostic["severity"] = "error"): GithubDiagnostic {
  return { code, severity, blocking: severity === "error", logicalId: id,
    schemaPath: "relationships", message };
}
function op(kind: PlanStep["kind"], logicalId: string, key: string, status: "planned" | "noop",
  reason: string, current: JsonValue | null, target: JsonValue | null,
  dependsOn: string[] = [], request?: PlanStep["request"]): PlanStep {
  return {
    id: kind + ":" + key, logicalId, kind, status, reason, current, desired: target,
    dependsOn: [...new Set(dependsOn)].sort(), ...(request ? { request } : {}),
    preconditions: ["Observed relationship identities remain valid"],
    expectedPostconditions: status === "noop" ? [] : ["Native relationship matches plan"],
    destructive: false, reversible: true,
  };
}
type CanonicalEdge =
  | { kind: "parent"; parent: string; child: string }
  | { kind: "blocked_by"; issue: string; blocker: string }
  | { kind: "relates_to"; from: string; to: string };
function canonical(edge: DesiredRelationship): CanonicalEdge {
  if (edge.kind === "blocks") return { kind: "blocked_by", issue: edge.blocked, blocker: edge.issue };
  if (edge.kind === "relates_to") {
    const [from, to] = [edge.from, edge.to].sort();
    return { kind: "relates_to", from: from!, to: to! };
  }
  return edge;
}
const pair = (a: number, b: number): string => [a, b].sort((x, y) => x - y).join(":");

/** Pure compiler: REST only; never makes a network request or mutates snapshots. */
export function compileRelationshipSteps(
  desired: NormalizedDesiredStateGraph, diff: GithubDiffResult,
  observed: GithubStateSnapshot, resolutions: ResourceResolution[],
  transport: GithubPlannerMode = "rest",
): RelationshipCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [], blockers: GithubDiagnostic[] = [];
  const warnings: GithubDiagnostic[] = [], unsupported: GithubDiagnostic[] = [];
  const sorted = (): RelationshipCompilationResult => {
    const order = (a: PlanStep, b: PlanStep) => a.id.localeCompare(b.id);
    const orderDiag = (a: GithubDiagnostic, b: GithubDiagnostic) =>
      (a.logicalId ?? "").localeCompare(b.logicalId ?? "") || a.message.localeCompare(b.message);
    return { steps: steps.sort(order), noops: noops.sort(order),
      blockers: blockers.sort(orderDiag), warnings: warnings.sort(orderDiag),
      unsupported: unsupported.sort(orderDiag) };
  };
  if (transport !== "rest") {
    unsupported.push(diagnostic("", "NO_REST_TRANSPORT",
      "Native relationships require a REST-capable transport.", "warning"));
    return sorted();
  }
  if (diff.blockers.some((d) => d.logicalId === undefined)) {
    blockers.push(...diff.blockers.filter((d) => d.logicalId === undefined));
    return sorted();
  }
  const [owner, repo, extra] = desired.repository.fullName.split("/");
  if (!owner || !repo || extra) {
    blockers.push(diagnostic("", "INVALID_SCHEMA", "Invalid repository identity."));
    return sorted();
  }
  const root = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/issues/";
  const byResolution = new Map(resolutions.map((r) => [r.logicalId, r]));
  const byNumber = new Map(observed.issues.map((i) => [i.number, i]));
  const endpoints = new Map<string, Endpoint>();
  for (const r of desired.resources) {
    if (r.kind !== "issue") continue;
    const resolution = byResolution.get(r.logicalId);
    if (!resolution || resolution.kind !== "issue" ||
      !["existing", "new"].includes(resolution.status) ||
      (r.management === "reference" && resolution.status !== "existing") ||
      diff.blockers.some((d) => d.logicalId === r.logicalId)) continue;
    const isNew = resolution.status === "new";
    const found = isNew ? undefined : byNumber.get(resolution.identity?.number ?? -1);
    if (!isNew && (!found ||
      resolution.identity?.id !== undefined && found.id !== resolution.identity.id ||
      resolution.identity?.nodeId !== undefined && found.nodeId !== resolution.identity.nodeId)) continue;
    if (isNew && !diff.diffs.some((d) => d.id === "issue.create:" + r.logicalId && d.status === "create")) continue;
    endpoints.set(r.logicalId, {
      logicalId: r.logicalId, isNew, managed: r.management === "managed",
      ...(found ? { number: found.number, id: found.id, observed: found } : {}),
    });
  }
  const ref = (e: Endpoint, prop: "number" | "id"): PlanValueRef =>
    ({ $ref: (e.logicalId + "." + prop) as PlanValueRef["$ref"] });
  const number = (e: Endpoint) => e.isNew ? ref(e, "number") : e.number!;
  const issueId = (e: Endpoint) => e.isNew ? ref(e, "id") : e.id!;
  const deps = (...edges: Endpoint[]): string[] =>
    edges.filter((e) => e.isNew).map((e) => "issue.create:" + e.logicalId);
  const path = (e: Endpoint, suffix: string): PlanPath =>
    e.isNew ? [root, ref(e, "number"), suffix] : root + e.number + suffix;
  const pathId = (e: Endpoint, suffix: string, target: Endpoint): PlanPath => {
    const start = path(e, suffix), tail = issueId(target);
    return [...(typeof start === "string" ? [start] : start), "/",
      typeof tail === "number" ? String(tail) : tail];
  };
  const requested = new Map<string, CanonicalEdge>();
  for (const raw of desired.relationships) {
    const edge = canonical(raw);
    const key = edge.kind === "parent" ? "parent:" + edge.child :
      edge.kind === "blocked_by" ? "blocked_by:" + edge.issue + ":" + edge.blocker :
      "relates_to:" + edge.from + ":" + edge.to;
    const old = requested.get(key);
    if (edge.kind === "parent" && old?.kind === "parent" && old.parent !== edge.parent)
      blockers.push(diagnostic(edge.child, "INVALID_SCHEMA", "Conflicting desired parent relationships."));
    requested.set(key, edge);
  }
  const parents = new Map<string, string>();
  const wantedBlockers = new Map<string, Set<number | string>>();
  const relatedKeys = new Set<string>();
  for (const edge of requested.values()) {
    const names = edge.kind === "parent" ? [edge.parent, edge.child] :
      edge.kind === "blocked_by" ? [edge.issue, edge.blocker] : [edge.from, edge.to];
    const [a, b] = names.map((name) => endpoints.get(name));
    if (!a || !b) {
      blockers.push(diagnostic(names[0]!, "UNRESOLVED_REFERENCE", "Unresolved relationship endpoints: " + names.join(", ")));
      continue;
    }
    if (names[0] === names[1])
      blockers.push(diagnostic(names[0]!, "INVALID_SCHEMA", "A self-relationship is invalid."));
    if (edge.kind === "parent") parents.set(edge.child, edge.parent);
    else if (edge.kind === "blocked_by") {
      const values = wantedBlockers.get(edge.issue) ?? new Set<number | string>();
      values.add(b.isNew ? edge.blocker : b.number!);
      wantedBlockers.set(edge.issue, values);
    } else {
      relatedKeys.add(!a.isNew && !b.isNew ? pair(a.number!, b.number!) : names.sort().join(":"));
    }
  }
  if (blockers.length) return sorted();
  const reconcile = desired.relationshipMode !== "additive";
  // Full enrichment is required before treating omitted edges as absent.
  for (const endpoint of endpoints.values()) {
    if (!endpoint.managed || endpoint.isNew) continue;
    const obs = endpoint.observed!;
    if (obs.parentNumber === undefined || !obs.blockedByNumbers || !obs.relatesToNumbers) {
      blockers.push(diagnostic(endpoint.logicalId, "UNRESOLVED_REFERENCE",
        "Relationship reconciliation requires enriched parent, blocked_by and relates_to data."));
    }
  }
  if (blockers.length) return sorted();
  const removeDeps = new Map<string, string[]>();
  const emit = (step: PlanStep) => (step.status === "noop" ? noops : steps).push(step);
  const remember = (ownerId: string, stepId: string) =>
    removeDeps.set(ownerId, [...(removeDeps.get(ownerId) ?? []), stepId]);

  for (const e of [...endpoints.values()].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    if (!e.managed || e.isNew) continue;
    const obs = e.observed!;
    if (obs.parentNumber != null && !parents.has(e.logicalId)) {
      const old = byNumber.get(obs.parentNumber);
      if (!old) blockers.push(diagnostic(e.logicalId, "UNRESOLVED_REFERENCE",
        "Observed old parent #" + obs.parentNumber + " is unavailable."));
      else if (reconcile) {
        const s = op("issue.parent.remove", e.logicalId, e.logicalId, "planned",
          "Remove stale parent #" + old.number + " of child #" + obs.number + ".",
          old.number, null, [], { protocol: "rest", method: "DELETE",
            path: root + old.number + "/sub_issue", body: { sub_issue_id: obs.id } });
        emit(s); remember(e.logicalId, s.id);
      } else warnings.push(diagnostic(e.logicalId, "UNSUPPORTED_SCHEMA_FEATURE",
        "Additive mode retains extra parent #" + old.number + ".", "info"));
    }
    for (const target of [...new Set(obs.blockedByNumbers ?? [])].sort((a, b) => a - b)) {
      if (wantedBlockers.get(e.logicalId)?.has(target)) continue;
      const other = byNumber.get(target);
      if (!other) blockers.push(diagnostic(e.logicalId, "UNRESOLVED_REFERENCE",
        "Observed blocker #" + target + " is unavailable."));
      else if (reconcile) {
        const s = op("issue.dependency.remove", e.logicalId,
          e.logicalId + ":" + target, "planned",
          "Remove stale blocker #" + target + " from #" + obs.number + ".",
          target, null, [], { protocol: "rest", method: "DELETE",
            path: root + obs.number + "/dependencies/blocked_by/" + other.id });
        emit(s); remember(e.logicalId, s.id);
      } else warnings.push(diagnostic(e.logicalId, "UNSUPPORTED_SCHEMA_FEATURE",
        "Additive mode retains extra blocker #" + target + ".", "info"));
    }
  }
  const seen = new Set<string>();
  for (const e of [...endpoints.values()].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    if (!e.managed || e.isNew) continue;
    for (const target of e.observed!.relatesToNumbers ?? []) {
      const key = pair(e.number!, target);
      if (seen.has(key)) continue;
      seen.add(key);
      if (relatedKeys.has(key)) continue;
      const other = byNumber.get(target);
      if (!other) blockers.push(diagnostic(e.logicalId, "UNRESOLVED_REFERENCE",
        "Observed related issue #" + target + " is unavailable."));
      else if (reconcile) {
        const s = op("issue.relates_to.remove", e.logicalId, key, "planned",
          "Remove stale related edge #" + e.number + " ↔ #" + target + ".",
          target, null, [], { protocol: "rest", method: "DELETE",
            path: root + e.number + "/relates_to/" + other.id });
        emit(s); remember(e.logicalId, s.id);
      } else warnings.push(diagnostic(e.logicalId, "UNSUPPORTED_SCHEMA_FEATURE",
        "Additive mode retains extra related edge #" + e.number + " ↔ #" + target + ".", "info"));
    }
  }
  if (blockers.length) {
    steps.length = 0;
    noops.length = 0;
    return sorted();
  }

  for (const [key, edge] of [...requested].sort(([a], [b]) => a.localeCompare(b))) {
    if (edge.kind === "parent") {
      const parent = endpoints.get(edge.parent)!, child = endpoints.get(edge.child)!;
      if (!child.managed) continue;
      const old = child.observed?.parentNumber ?? null;
      const exists = !child.isNew && !parent.isNew && old === parent.number;
      emit(op("issue.parent.set", child.logicalId, child.logicalId, exists ? "noop" : "planned",
        exists ? "Parent already matches." :
          "Change parent of " + edge.child + " from " + (old === null ? "none" : "#" + old) +
          " to " + (parent.isNew ? edge.parent : "#" + parent.number) + ".",
        old, parent.isNew ? { logicalId: parent.logicalId } : parent.number!,
        [...deps(parent, child), ...(removeDeps.get(child.logicalId) ?? [])],
        exists ? undefined : { protocol: "rest", method: "POST",
          path: path(parent, "/sub_issues"),
          body: { sub_issue_id: issueId(child), ...(old !== null && old !== parent.number ?
            { replace_parent: true } : {}) } }));
    } else if (edge.kind === "blocked_by") {
      const issue = endpoints.get(edge.issue)!, blocker = endpoints.get(edge.blocker)!;
      if (!issue.managed) continue;
      const exists = !issue.isNew && !blocker.isNew &&
        issue.observed!.blockedByNumbers!.includes(blocker.number!);
      emit(op("issue.dependency.add", issue.logicalId, edge.issue + ":" + edge.blocker,
        exists ? "noop" : "planned",
        exists ? "Dependency already exists." : "Add blocker " + edge.blocker + " to " + edge.issue + ".",
        exists ? blocker.number! : null,
        blocker.isNew ? { logicalId: blocker.logicalId } : blocker.number!,
        [...deps(issue, blocker), ...(removeDeps.get(issue.logicalId) ?? [])],
        exists ? undefined : { protocol: "rest", method: "POST",
          path: path(issue, "/dependencies/blocked_by"), body: { issue_id: issueId(blocker) } }));
    } else {
      const from = endpoints.get(edge.from)!, to = endpoints.get(edge.to)!;
      if (!from.managed && !to.managed) continue;
      const first = from.managed ? from : to, other = first === from ? to : from;
      const exists = !from.isNew && !to.isNew &&
        (from.observed?.relatesToNumbers?.includes(to.number!) === true ||
         to.observed?.relatesToNumbers?.includes(from.number!) === true);
      emit(op("issue.relates_to.add", first.logicalId, key.slice("relates_to:".length),
        exists ? "noop" : "planned",
        exists ? "Related edge already matches." : "Add symmetric related edge " + edge.from + " ↔ " + edge.to + ".",
        exists ? other.number! : null,
        other.isNew ? { logicalId: other.logicalId } : other.number!,
        [...deps(first, other), ...(removeDeps.get(first.logicalId) ?? [])],
        exists ? undefined : { protocol: "rest", method: "POST",
          path: path(first, "/relates_to"), body: { issue_id: issueId(other) } }));
    }
  }
  return sorted();
}
