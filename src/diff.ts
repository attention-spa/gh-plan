import type {
  DesiredResource, DesiredSetOrRemove, GithubDiagnostic, GithubDiff, GithubDiffResult,
  GithubStateSnapshot, JsonValue, NormalizedDesiredStateGraph, ObservedIssue,
  ObservedMilestone, ResourceResolution,
} from "./types.ts";

type Observed = ObservedIssue | ObservedMilestone;

const stable = (value: JsonValue): string => {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key]!)).join(",") + "}";
  return JSON.stringify(value);
};
const same = (a: JsonValue, b: JsonValue): boolean => stable(a) === stable(b);
const sortDiagnostics = (a: GithubDiagnostic[]): GithubDiagnostic[] => a.sort((x, y) =>
  (x.logicalId ?? "").localeCompare(y.logicalId ?? "") ||
  (x.schemaPath ?? "").localeCompare(y.schemaPath ?? "") || x.code.localeCompare(y.code));

function found(resource: DesiredResource, state: GithubStateSnapshot, resolution: ResourceResolution): Observed | undefined {
  if (!resolution.identity) return undefined;
  const identity = resolution.identity;
  const pool: Observed[] = resource.kind === "issue" ? state.issues : state.milestones;
  const matches = pool.filter((item) =>
    (identity.number === undefined || identity.number === item.number) &&
    (identity.id === undefined || identity.id === item.id) &&
    (identity.nodeId === undefined || identity.nodeId === item.nodeId));
  return matches.length === 1 ? matches[0] : undefined;
}

function marker(resource: DesiredResource, resolution: ResourceResolution): string {
  return resolution.identity?.marker ?? resource.identity?.marker ?? "<!-- gh-plan:" + resource.logicalId + " -->";
}

function bodyWithoutMarker(body: string | null | undefined, token: string): string | null {
  if (body == null) return null;
  if (!body.includes(token)) return body;
  const value = body.replace(token, "");
  if (value.startsWith("\r\n")) return value.slice(2);
  if (value.startsWith("\n")) return value.slice(1);
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

export function diffGithubState(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
): GithubDiffResult {
  const diffs: GithubDiff[] = [];
  const blockers: GithubDiagnostic[] = [];
  const warnings: GithubDiagnostic[] = [];
  const unsupported: GithubDiagnostic[] = [];
  const resources = new Map(desired.resources.map((resource) => [resource.logicalId, resource]));
  const resolved = new Map(resolutions.map((resolution) => [resolution.logicalId, resolution]));

  function add(id: string, logicalId: string, kind: string, status: GithubDiff["status"],
    reason: string, property?: string, current?: JsonValue, target?: JsonValue, refs: string[] = []): void {
    diffs.push({
      id, logicalId, kind, status, reason,
      ...(property === undefined ? {} : { property }),
      ...(current === undefined ? {} : { current }),
      ...(target === undefined ? {} : { desired: target }),
      ...(refs.length ? { references: [...new Set(refs)].sort().map((logicalId) => ({ logicalId })) } : {}),
    });
  }

  function report(code: GithubDiagnostic["code"], id: string, logicalId: string, kind: string,
    property: string, reason: string, details?: JsonValue): void {
    add(id, logicalId, kind, "conflict", reason, property);
    blockers.push({
      code, severity: "error", blocking: true, logicalId, schemaPath: property, message: reason,
      ...(details === undefined ? {} : { details }),
    });
  }

  function compare(id: string, logicalId: string, kind: string, property: string,
    current: JsonValue, operation: DesiredSetOrRemove<JsonValue>): void {
    const target = operation.op === "remove" ? null : operation.value;
    const matches = operation.op === "remove" ? current === null : same(current, target);
    add(id, logicalId, kind, matches ? "noop" : "update",
      matches ? property + " already matches." : property + " differs.", property, current, target);
  }

  function endpoint(ref: string): ResourceResolution | undefined {
    const resource = resources.get(ref), resolution = resolved.get(ref);
    if (!resource || !resolution || resource.kind !== resolution.kind ||
      resolution.status === "ambiguous" || resolution.status === "unresolved" ||
      (resource.management === "reference" && resolution.status !== "existing") ||
      (resolution.status === "existing" && !found(resource, observed, resolution))) return undefined;
    return resolution;
  }

  if (desired.repository.fullName.toLowerCase() !== observed.repository.fullName.toLowerCase() ||
    (desired.repository.id !== undefined && observed.repository.id !== undefined &&
      desired.repository.id !== observed.repository.id)) {
    blockers.push({ code: "INVALID_SCHEMA", severity: "error", blocking: true,
      schemaPath: "$.repository", message: "Desired and observed repository identities differ." });
    return { diffs, blockers, warnings, unsupported };
  }

  for (const resource of [...desired.resources].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    const id = resource.logicalId, kind = resource.kind, resolution = resolved.get(id);
    if (!resolution || resolution.kind !== kind || resolution.status === "unresolved" || resolution.status === "ambiguous") {
      report(resolution?.status === "ambiguous" ? "AMBIGUOUS_IDENTITY" :
        resource.management === "reference" ? "UNRESOLVED_REFERENCE" : "UNRESOLVED_IDENTITY",
        kind + ".identity:" + id, id, kind, "identity", "Unsafe identity resolution for " + id + ".");
      continue;
    }
    const current = resolution.status === "existing" ? found(resource, observed, resolution) : undefined;
    if (resource.management === "reference") {
      if (!current) report("UNRESOLVED_REFERENCE", kind + ".identity:" + id, id, kind, "identity",
        "Reference " + id + " does not resolve to an existing observed resource.");
      continue;
    }
    if (resolution.status === "existing" && !current) {
      report("UNRESOLVED_IDENTITY", kind + ".identity:" + id, id, kind, "identity",
        "Existing resource " + id + " not found in snapshot.");
      continue;
    }
    if (resolution.status === "new") {
      add(kind + ".create:" + id, id, kind, "create", id + " is new.", undefined, undefined,
        { ...resource.desired, ...(kind === "issue" ? { identityMarker: marker(resource, resolution) } : {}) } as JsonValue,
        resource.kind === "issue" && resource.desired.milestone?.op === "set"
          ? [resource.desired.milestone.value.logicalId] : []);
    }
    if (resource.kind === "milestone") {
      if (current?.kind === "milestone") {
        const d = resource.desired;
        if (d.title) compare("milestone.title:" + id, id, kind, "title", current.title, d.title);
        if (d.description) compare("milestone.description:" + id, id, kind, "description",
          current.description ?? null, d.description);
        if (d.state) compare("milestone.state:" + id, id, kind, "state", current.state, d.state);
      }
      continue;
    }
    const issue = current?.kind === "issue" ? current : undefined;
    const d = resource.desired;
    if (issue) {
      if (d.title) compare("issue.title:" + id, id, kind, "title", issue.title, d.title);
      if (d.body) compare("issue.body:" + id, id, kind, "body",
        bodyWithoutMarker(issue.body, marker(resource, resolution)), d.body);
      if (d.state) compare("issue.state:" + id, id, kind, "state", issue.state, d.state);
    }

    if (d.milestone) {
      const diffId = "issue.milestone:" + id;
      if (d.milestone.op === "remove") {
        if (issue) compare(diffId, id, kind, "milestone", issue.milestoneNumber ?? null, d.milestone);
      } else {
        const ref = d.milestone.value.logicalId, target = endpoint(ref);
        if (!target || resources.get(ref)?.kind !== "milestone") {
          report("UNRESOLVED_REFERENCE", diffId, id, kind, "milestone",
            "Milestone reference " + ref + " cannot be resolved.", { reference: ref });
        } else if (issue) {
          const matches = target.status === "existing" && target.identity?.number === issue.milestoneNumber;
          add(diffId, id, kind, matches ? "noop" : "update",
            matches ? "Milestone already matches." : "Milestone assignment differs.",
            "milestone", issue.milestoneNumber ?? null, { logicalId: ref }, [ref]);
        }
      }
    }
    if (d.issueType) {
      const value = d.issueType.value;
      if (observed.issueTypes.filter((type) => type.name === value).length !== 1) {
        report("UNKNOWN_ISSUE_TYPE", "issue.type:" + id, id, kind, "issueType",
          "Unknown or ambiguous issue type: " + value, { name: value });
      } else if (issue) compare("issue.type:" + id, id, kind, "issueType", issue.issueType ?? null, d.issueType);
    }
    for (const name of Object.keys(d.fields ?? {}).sort()) {
      const operation = d.fields![name]!, diffId = "issue.field:" + id + ":" + name;
      const fields = observed.issueFields.filter((field) => field.name === name);
      if (fields.length !== 1) {
        report("UNKNOWN_ISSUE_FIELD", diffId, id, kind, "fields." + name,
          "Unknown or ambiguous issue field: " + name, { name });
        continue;
      }
      const definition = fields[0]!;
      if (operation.op === "set" && definition.options) {
        const options = definition.options;
        const exists = (value: JsonValue): boolean => options.some((option) => same(value, option.value ?? option.name));
        const multi = (definition.dataType ?? "").toLowerCase().replace(/[-_\s]/g, "").includes("multi");
        const valid = multi ? Array.isArray(operation.value) && operation.value.every(exists)
          : exists(operation.value);
        if (!valid) {
          report("UNKNOWN_FIELD_OPTION", diffId, id, kind, "fields." + name,
            "Unknown option for field: " + name, { name, value: operation.value });
          continue;
        }
      }
      if (issue) compare(diffId, id, kind, "fields." + name, issue.fields?.[name] ?? null, operation);
    }
  }

  const seen = new Set<string>();
  for (const relation of desired.relationships) {
    const edge = relation.kind === "blocks"
      ? { kind: "blocked_by" as const, issue: relation.blocked, blocker: relation.issue } : relation;
    let id: string, logicalId: string, refs: string[];
    if (edge.kind === "parent") {
      id = "issue.parent:" + edge.parent + ":" + edge.child;
      logicalId = edge.child; refs = [edge.parent, edge.child];
    } else if (edge.kind === "blocked_by") {
      id = "issue.dependency:" + edge.issue + ":" + edge.blocker;
      logicalId = edge.issue; refs = [edge.issue, edge.blocker];
    } else {
      refs = [edge.from, edge.to].sort();
      id = "issue.related:" + refs.join(":"); logicalId = refs[0]!;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (edge.kind === "relates_to") {
      const reason = "Related is conceptual metadata; no native v0.1 mutation exists.";
      add(id, logicalId, "relationship.related", "unsupported", reason, undefined, undefined,
        { from: refs[0]!, to: refs[1]! }, refs);
      unsupported.push({ code: "UNSUPPORTED_SCHEMA_FEATURE", severity: "warning", blocking: false,
        logicalId, schemaPath: "relationships.related", message: reason });
      continue;
    }
    const first = endpoint(refs[0]!), second = endpoint(refs[1]!);
    if (!first || !second || refs.some((ref) => resources.get(ref)?.kind !== "issue")) {
      report("UNRESOLVED_REFERENCE", id, logicalId, "relationship." + edge.kind, "relationship",
        "Relationship has unresolved endpoint(s): " + refs.join(", "), { references: refs });
      continue;
    }
    if (edge.kind === "parent") {
      const child = second.status === "existing"
        ? observed.issues.find((issue) => issue.number === second.identity?.number) : undefined;
      const parentNumber = first.status === "existing" ? first.identity?.number : undefined;
      const oldParent = child?.parentNumber ?? null;
      if (child && oldParent !== null && oldParent !== parentNumber) {
        report("PARENT_CONFLICT", id, logicalId, "relationship.parent", "parent",
          "Unsafe reparenting of " + edge.child + " from #" + oldParent + ".",
          { existingParentNumber: oldParent });
      } else {
        const matches = !!child && parentNumber !== undefined && oldParent === parentNumber;
        add(id, logicalId, "relationship.parent", matches ? "noop" : "update",
          matches ? "Parent already matches." : "Parent relationship is missing.",
          "parent", oldParent, { logicalId: edge.parent }, refs);
      }
    } else {
      const dependent = first.status === "existing"
        ? observed.issues.find((issue) => issue.number === first.identity?.number) : undefined;
      const blockerNumber = second.status === "existing" ? second.identity?.number : undefined;
      const matches = !!dependent && blockerNumber !== undefined &&
        (dependent.blockedByNumbers ?? []).includes(blockerNumber);
      add(id, logicalId, "relationship.blocked_by", matches ? "noop" : "update",
        matches ? "Dependency already exists." : "Dependency is missing.",
        "blocked_by", dependent?.blockedByNumbers ?? [], { logicalId: edge.blocker }, refs);
    }
  }
  diffs.sort((a, b) => a.id.localeCompare(b.id) || a.status.localeCompare(b.status));
  return { diffs, blockers: sortDiagnostics(blockers), warnings: sortDiagnostics(warnings),
    unsupported: sortDiagnostics(unsupported) };
}
