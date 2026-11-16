import type {
  GithubDiagnostic, GithubDiffResult, GithubStateSnapshot, JsonValue,
  ManagedIssueResource, NormalizedDesiredStateGraph, PlanPath, PlanStep,
  PlanValueRef, ResourceResolution,
} from "./types.ts";

/** Pure output: explicit issue-label set/add/remove steps, noops and unknown-label blockers. */
export interface IssueLabelCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
}

function diagnostic(id: string, code: GithubDiagnostic["code"], message: string): GithubDiagnostic {
  return { code, severity: "error", blocking: true, logicalId: id,
    schemaPath: "resources." + id + ".labels", message };
}

function step(
  id: string, kind: PlanStep["kind"], status: "planned" | "noop",
  current: JsonValue | null, target: JsonValue | null,
  reason: string, dependsOn: string[] = [], request?: PlanStep["request"],
): PlanStep {
  return {
    id: kind + ":" + id, kind, logicalId: id, status, current, desired: target, reason,
    dependsOn: [...new Set(dependsOn)].sort(),
    ...(request ? { request } : {}),
    preconditions: ["Issue and repository labels retain their discovered identities"],
    expectedPostconditions: status === "noop" ? [] : ["Desired issue labels are reconciled"],
    destructive: false, reversible: true,
  };
}

const key = (name: string): string => name.toLowerCase();

/**
 * Pure compiler for explicitly managed issue labels: exact set uses PUT on
 * existing issues; add/remove uses targeted POST/DELETE, preserving others.
 * New issues receive targeted POST after issue.create (never a broad PUT).
 * Absent repository labels must be declared managed at the schema root; those
 * requests depend on label.create before assignment. Unknown/ambiguous names
 * produce blockers. No network I/O.
 */
export function compileIssueLabelSteps(
  desired: NormalizedDesiredStateGraph,
  diff: GithubDiffResult,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
): IssueLabelCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [], blockers: GithubDiagnostic[] = [];
  const repository = desired.repository.fullName.split("/");
  if (repository.length !== 2 || repository.some((part) => !part)) {
    blockers.push(diagnostic("", "INVALID_SCHEMA", "Invalid repository identity."));
    return { steps, noops, blockers };
  }
  const base = "/repos/" + repository.map(encodeURIComponent).join("/") + "/issues/";
  const byResolution = new Map(resolutions.map((r) => [r.logicalId, r]));
  const managed = desired.resources.filter((r): r is ManagedIssueResource =>
    r.kind === "issue" && r.management === "managed" && r.desired.labels !== undefined);

  for (const resource of [...managed].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    const id = resource.logicalId;
    const incoming = diff.blockers.filter((d) => d.logicalId === id);
    if (incoming.length) {
      blockers.push(...incoming);
      continue;
    }
    const operation = resource.desired.labels!;
    if (!observed.labels) {
      blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE", "Repository label catalog was not discovered."));
      continue;
    }
    const catalog = new Map<string, string[]>();
    for (const label of observed.labels) {
      catalog.set(key(label.name), [...(catalog.get(key(label.name)) ?? []), label.name]);
    }
    const requested = operation.op === "set" ? operation.value : [...operation.add, ...operation.remove];
    const managed = new Map((desired.labels ?? [])
      .filter((label) => label.management === "managed")
      .map((label) => [key(label.name), label]));
    const unknown = requested.filter((name) => {
      const observedCount = catalog.get(key(name))?.length ?? 0;
      return observedCount !== 1 && !(observedCount === 0 && managed.has(key(name)));
    });
    if (unknown.length) {
      blockers.push(diagnostic(id, "UNKNOWN_LABEL", "Unknown or ambiguous labels: " + unknown.join(", ") + "."));
      continue;
    }
    const canonical = (name: string): string =>
      catalog.get(key(name))?.[0] ?? managed.get(key(name))!.name;
    const labelCreates = (names: string[]): string[] => [...new Set(names.flatMap((name) => {
      if ((catalog.get(key(name))?.length ?? 0) !== 0) return [];
      const producer = managed.get(key(name));
      return producer ? ["label.create:" + producer.logicalId] : [];
    }))].sort();
    const resolution = byResolution.get(id);
    if (!resolution || resolution.kind !== "issue" ||
      (resolution.status !== "new" && resolution.status !== "existing")) {
      blockers.push(diagnostic(id, "UNRESOLVED_IDENTITY", "Issue identity is not safe for labels."));
      continue;
    }
    const isNew = resolution.status === "new";
    const current = isNew ? undefined : observed.issues.find((issue) =>
      issue.number === resolution.identity?.number &&
      (resolution.identity?.id === undefined || resolution.identity.id === issue.id) &&
      (resolution.identity?.nodeId === undefined || resolution.identity.nodeId === issue.nodeId));
    if (!isNew && (!current || !current.labels)) {
      blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE", "Existing issue label snapshot is incomplete."));
      continue;
    }
    if (isNew && !diff.diffs.some((item) => item.id === "issue.create:" + id && item.status === "create")) {
      blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE", "Missing issue.create producer."));
      continue;
    }
    const existing = new Map((current?.labels ?? []).map((name) => [key(name), name]));
    const labelsPath: PlanPath = isNew ?
      [base, { $ref: (id + ".number") as PlanValueRef["$ref"] }, "/labels"] :
      base + current!.number + "/labels";
    const dependency = isNew ? ["issue.create:" + id] : [];
    const creationDependencies = labelCreates(operation.op === "set"
      ? operation.value : operation.add);
    const changed = diff.diffs.find((item) => item.id === "issue.labels:" + id);
    if (!isNew && (!changed || !["noop", "update"].includes(changed.status))) {
      blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE", "Missing safe issue label semantic diff."));
      continue;
    }
    const target = operation.op === "set"
      ? new Map(operation.value.map((name) => [key(name), canonical(name)]))
      : new Map(existing);
    if (operation.op === "modify") {
      for (const name of operation.remove) target.delete(key(name));
      for (const name of operation.add) target.set(key(name), canonical(name));
    }
    const stable = (values: string[]): string[] => values.sort((a, b) => a.localeCompare(b));
    const oldValues = stable([...existing.values()]);
    const newValues = stable([...target.values()]);
    const unchanged = !isNew && changed?.status === "noop" ||
      isNew && newValues.length === 0;
    if (unchanged) {
      noops.push(step(id, "issue.label.set", "noop", oldValues, newValues,
        "Labels already match; no mutation."));
      continue;
    }
    if (operation.op === "set" && !isNew) {
      steps.push(step(id, "issue.label.set", "planned", oldValues, newValues,
        "Replace complete issue label set.", creationDependencies, { protocol: "rest", method: "PUT",
          path: labelsPath, body: { labels: newValues } }));
      continue;
    }
    const removed = operation.op === "modify"
      ? stable(operation.remove.filter((name) => existing.has(key(name)))
        .map((name) => existing.get(key(name))!)) : [];
    const added = operation.op === "set" && isNew ? newValues :
      operation.op === "modify"
        ? stable(operation.add.filter((name) => !existing.has(key(name))).map(canonical)) : [];
    const removeIds: string[] = [];
    for (const name of removed) {
      const path: PlanPath = typeof labelsPath === "string"
        ? labelsPath + "/" + encodeURIComponent(name)
        : [...labelsPath, "/" + encodeURIComponent(name)];
      const item = step(id + ":" + encodeURIComponent(name), "issue.label.remove", "planned",
        [name], [], "Remove explicit issue label " + name + ".", dependency,
        { protocol: "rest", method: "DELETE", path });
      steps.push(item);
      removeIds.push(item.id);
    }
    if (added.length) {
      steps.push(step(id, "issue.label.add", "planned", oldValues, newValues,
        "Add explicitly requested labels while retaining unrelated labels.",
        [...dependency, ...removeIds, ...labelCreates(added)], { protocol: "rest", method: "POST",
          path: labelsPath, body: { labels: added } }));
    }
    if (!removed.length && !added.length) {
      noops.push(step(id, "issue.label.set", "noop", oldValues, newValues,
        "Labels already match; no mutation."));
    }
  }
  steps.sort((a, b) => a.id.localeCompare(b.id));
  noops.sort((a, b) => a.id.localeCompare(b.id));
  blockers.sort((a, b) => (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  return { steps, noops, blockers };
}
