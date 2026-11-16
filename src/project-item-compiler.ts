import type {
  DesiredProjectItemAssignment, GithubDiagnostic, GithubStateSnapshot,
  JsonValue, NormalizedDesiredStateGraph, ObservedProjectField,
  PlanJsonValue, PlanPath, PlanStep, PlanValueRef, ResourceResolution,
} from "./types.ts";

/** Pure compilation result; all HTTP requests are inert proposals. */
export interface ProjectItemCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
}

const compare = (a: string | number | null, b: string | number): boolean =>
  typeof a === typeof b && a === b;

function diagnostic(id: string, code: GithubDiagnostic["code"], message: string): GithubDiagnostic {
  return { code, severity: "error", blocking: true,
    logicalId: id, schemaPath: "projectItems." + id, message };
}
function step(id: string, logicalId: string, kind: PlanStep["kind"],
  current: JsonValue | null, desired: JsonValue | null, reason: string,
  request?: PlanStep["request"], deps: string[] = []): PlanStep {
  return {
    id, logicalId, kind, status: request ? "planned" : "noop",
    current, desired, reason, dependsOn: [...new Set(deps)].sort(),
    ...(request ? { request } : {}),
    preconditions: ["The referenced project, field definitions and content identity remain current"],
    expectedPostconditions: request ? ["The requested project item state is present"] : [],
    destructive: false, reversible: kind === "project.item.add" ? "partial" : true,
  };
}
function itemKey(assignment: DesiredProjectItemAssignment): string {
  return "project-item:" + assignment.projectLogicalId + ":" + assignment.resourceLogicalId;
}
function reference(logicalId: string, prop: "id" | "number"): PlanValueRef {
  return { $ref: (logicalId + "." + prop) as PlanValueRef["$ref"] };
}
function fieldValue(field: ObservedProjectField, value: string | number):
  { value: string | number } | { error: "unsupported" | "invalid" | "option" } {
  const type = field.dataType.toLowerCase().replace(/[-_\s]/g, "");
  if (type === "text") return typeof value === "string" ? { value } : { error: "invalid" };
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ?
    { value } : { error: "invalid" };
  if (type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value) return { error: "invalid" };
    return { value };
  }
  if (type === "singleselect" || type === "iteration") {
    if (typeof value !== "string") return { error: "invalid" };
    const candidates = (type === "singleselect"
      ? (field.options ?? []).map((v) => ({ id: v.id, name: v.name }))
      : (field.iterations ?? []).map((v) => ({ id: v.id, name: v.title })))
      .filter((candidate) => candidate.name === value);
    return candidates.length === 1 ? { value: candidates[0]!.id } : { error: "option" };
  }
  return { error: "unsupported" };
}

/**
 * Only existing Projects v2 boards/fields are eligible. The compiler never
 * creates boards or fields, removes memberships, or changes unsupported field
 * types. Existing item fields are reconciled by numeric field IDs; new items
 * are created via REST POST and later assigned fields via PATCH with a late-
 * bound item id. Newly planned Issue/PR membership depends on its creation.
 */
export function compileProjectItemSteps(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
): ProjectItemCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [], blockers: GithubDiagnostic[] = [];
  const boards = new Map((observed.projects ?? []).map((v) => [v.logicalId, v]));
  const refs = new Map(resolutions.map((v) => [v.logicalId, v]));
  const [repoOwner, repoName] = desired.repository.fullName.split("/");
  if (!repoOwner || !repoName) {
    blockers.push(diagnostic("", "INVALID_SCHEMA", "Invalid repository identity."));
    return { steps, noops, blockers };
  }
  for (const project of desired.projects ?? []) {
    const board = boards.get(project.logicalId);
    if (!board || board.missing || board.number !== project.number ||
        board.owner.toLowerCase() !== project.owner.toLowerCase() ||
        board.ownerType !== project.ownerType) {
      blockers.push(diagnostic(project.logicalId, "UNKNOWN_PROJECT",
        "Referenced existing Project v2 board was not discovered."));
    }
  }
  for (const a of [...(desired.projectItems ?? [])].sort((x, y) =>
    x.projectLogicalId.localeCompare(y.projectLogicalId) ||
    x.resourceLogicalId.localeCompare(y.resourceLogicalId))) {
    const key = itemKey(a), board = boards.get(a.projectLogicalId);
    if (!board || board.missing) continue;
    const resolution = refs.get(a.resourceLogicalId);
    if (!resolution || resolution.kind !== a.resourceKind ||
        (resolution.status !== "existing" && resolution.status !== "new")) {
      blockers.push(diagnostic(key, "UNRESOLVED_REFERENCE",
        "Project membership requires a safely resolved issue or pull request."));
      continue;
    }
    const isNew = resolution.status === "new", id = resolution.identity?.id,
      number = resolution.identity?.number;
    if (!isNew && id === undefined && number === undefined) {
      blockers.push(diagnostic(key, "UNRESOLVED_REFERENCE",
        "Existing issue or PR has no REST id or number for project membership."));
      continue;
    }
    const candidates = isNew ? [] : board.items.filter((item) =>
      item.contentType === (a.resourceKind === "issue" ? "Issue" : "PullRequest") &&
      (id !== undefined ? item.contentId === id : item.contentNumber === number));
    if (candidates.length > 1) {
      blockers.push(diagnostic(key, "AMBIGUOUS_IDENTITY",
        "Multiple project items matched the same issue/PR content identity."));
      continue;
    }
    const current = candidates[0];
    const root = "/" + (board.ownerType === "user" ? "users" : "orgs") + "/" +
      encodeURIComponent(board.owner) + "/projectsV2/" + board.number + "/items";
    const createId = "project.item.add:" + key;
    const deps: string[] = isNew ?
      [(a.resourceKind === "issue" ? "issue.create:" : "pull_request.create:") +
        a.resourceLogicalId] : [];
    // Resolve every field before proposing membership; unknown fields and
    // unsupported values must block rather than creating a partial item.
    const updates: Array<{ id: number; value: string | number }> = [];
    const previous: Record<string, JsonValue> = {}, next: Record<string, JsonValue> = {};
    let failed = false;
    for (const name of Object.keys(a.fields).sort()) {
      const definitions = board.fields.filter((field) => field.name === name);
      if (definitions.length !== 1) {
        blockers.push(diagnostic(key, "UNKNOWN_PROJECT_FIELD",
          "Unknown or ambiguous existing Project field: " + name + "."));
        failed = true; continue;
      }
      const field = definitions[0]!;
      const parsed = fieldValue(field, a.fields[name]!);
      if ("error" in parsed) {
        const code = parsed.error === "unsupported" ? "UNSUPPORTED_PROJECT_FIELD" :
          parsed.error === "option" ? "UNKNOWN_PROJECT_FIELD_OPTION" : "INVALID_SCHEMA";
        blockers.push(diagnostic(key, code,
          "Invalid or unsupported value for Project field " + name + "."));
        failed = true; continue;
      }
      const old = current?.fields[String(field.id)] ?? null;
      if (current && !Object.hasOwn(current.fields, String(field.id))) {
        // A selector request with missing values means the field is currently
        // empty; list-items returns fields by ID and does not materialize nulls.
      }
      if (!current || !compare(old, parsed.value)) {
        updates.push({ id: field.id, value: parsed.value });
        previous[name] = old; next[name] = parsed.value;
      }
    }
    if (failed) continue;
    if (!current) {
      const data: Record<string, PlanJsonValue> = {
        type: a.resourceKind === "issue" ? "Issue" : "PullRequest",
        ...(isNew
          ? { owner: repoOwner, repo: repoName, number: reference(a.resourceLogicalId, "number") }
          : id !== undefined ? { id } : { owner: repoOwner, repo: repoName, number: number! }),
      };
      steps.push(step(createId, key, "project.item.add", null,
        data as unknown as JsonValue, "Add existing/planned content to an existing Projects v2 board.",
        { protocol: "rest", method: "POST", path: root, body: data }, deps));
    } else {
      noops.push(step(createId, key, "project.item.add", current.id, current.id,
        "Issue/PR is already a member of this existing board."));
    }
    if (updates.length) {
      const patchPath: PlanPath = current ? root + "/" + current.id :
        [root + "/", reference(key, "id")];
      const patchDeps = current ? [] : [createId];
      steps.push(step("project.item.fields.set:" + key, key,
        "project.item.fields.set", previous, next,
        "Update only explicitly supplied, changed fields on this project item.",
        { protocol: "rest", method: "PATCH", path: patchPath, body: { fields: updates } },
        patchDeps));
    } else if (Object.keys(a.fields).length) {
      noops.push(step("project.item.fields.set:" + key, key,
        "project.item.fields.set", null, null, "Managed project fields already match."));
    }
  }
  steps.sort((a, b) => a.id.localeCompare(b.id));
  noops.sort((a, b) => a.id.localeCompare(b.id));
  blockers.sort((a, b) => (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  return { steps, noops, blockers };
}
