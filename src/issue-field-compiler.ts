import type {
  GithubDiagnostic, GithubDiffResult, GithubStateSnapshot, JsonValue,
  ManagedIssueResource, NormalizedDesiredStateGraph, ObservedIssueField,
  PlanStep, ResourceResolution,
} from "./types.ts";

/** Pure output: selected organization issue-field writes, noops, blockers and unsupported definitions. */
export interface IssueFieldCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
  unsupported: GithubDiagnostic[];
}
type Kind = "text" | "number" | "date" | "single_select" | "multi_select";
const KINDS = new Set(["text", "number", "date", "single_select", "multi_select"]);
function diag(code: GithubDiagnostic["code"], id: string, name: string, message: string,
  blocking = true): GithubDiagnostic {
  return { code, severity: blocking ? "error" : "warning", blocking, logicalId: id,
    schemaPath: "resources." + id + ".fields." + name, message };
}
function kindOf(field: ObservedIssueField): Kind | undefined {
  const kind = field.dataType?.toLowerCase().replace(/[-\s]/g, "_");
  return kind && KINDS.has(kind) ? kind as Kind : undefined;
}
function valueOf(field: ObservedIssueField, kind: Kind, value: JsonValue):
  { value: JsonValue } | { code: GithubDiagnostic["code"]; message: string } {
  if (kind === "text" && typeof value === "string") return { value };
  if (kind === "number" && typeof value === "number" && Number.isFinite(value)) return { value };
  if (kind === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + "T00:00:00Z");
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return { value };
  }
  if (kind === "single_select" || kind === "multi_select") {
    const names = new Set(field.options?.map((option) => option.name) ?? []);
    if (kind === "single_select" && typeof value === "string" && names.has(value)) return { value };
    if (kind === "multi_select" && Array.isArray(value) &&
      value.every((item) => typeof item === "string" && names.has(item))) {
      return { value: [...new Set(value as string[])].sort() };
    }
    return { code: "UNKNOWN_FIELD_OPTION", message: "Unknown option for " + field.name + "." };
  }
  return { code: "INVALID_SCHEMA", message: "Invalid " + kind + " value for " + field.name + "." };
}
function step(
  id: string, name: string, kind: PlanStep["kind"], status: "planned" | "noop",
  current: JsonValue | null, desired: JsonValue | null, dependsOn: string[] = [],
  request?: PlanStep["request"],
): PlanStep {
  return {
    id: kind + ":" + id + ":" + name, logicalId: id, kind, status, current, desired,
    reason: status === "noop" ? "Field already matches." : "Reconcile field " + name + ".",
    dependsOn, ...(request ? { request } : {}),
    preconditions: ["Field and issue identities remain valid"],
    expectedPostconditions: status === "noop" ? [] : ["Field " + name + " matches desired value"],
    destructive: false, reversible: kind === "issue.field.remove" ? "partial" : true,
  };
}

/**
 * Pure compiler for explicitly managed organization issue fields, looked up
 * by user-facing field/option names in discovered metadata. Emits only targeted
 * field requests, never a PUT replacing unrelated fields. Unknown fields/options
 * block or yield unsupported diagnostics; no transport calls or mutations.
 */
export function compileIssueFieldSteps(
  desired: NormalizedDesiredStateGraph,
  result: GithubDiffResult,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
): IssueFieldCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [];
  const blockers: GithubDiagnostic[] = [], unsupported: GithubDiagnostic[] = [];
  const byResolution = new Map(resolutions.map((resolution) => [resolution.logicalId, resolution]));
  const parts = desired.repository.fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    blockers.push(diag("INVALID_SCHEMA", "", "", "Invalid repository fullName."));
    return { steps, noops, blockers, unsupported };
  }
  const globalErrors = result.blockers.filter((error) => error.logicalId === undefined);
  if (globalErrors.length) return { steps, noops, blockers: globalErrors, unsupported };
  const prefix = "/repos/" + parts.map(encodeURIComponent).join("/") + "/issues";
  const resources = desired.resources.filter((resource): resource is ManagedIssueResource =>
    resource.kind === "issue" && resource.management === "managed" &&
    Object.keys(resource.desired.fields ?? {}).length > 0);
  for (const resource of [...resources].sort((a, b) => a.logicalId.localeCompare(b.logicalId))) {
    const id = resource.logicalId;
    const originalErrors = result.blockers.filter((error) => error.logicalId === id);
    if (observed.issueFields.length === 0) {
      unsupported.push(diag("UNSUPPORTED_SCHEMA_FEATURE", id, "",
        "Organization field definitions unavailable; user-owned issue fields unsupported.", false));
    }
    if (originalErrors.length) {
      blockers.push(...originalErrors);
      continue;
    }
    if (observed.issueFields.length === 0) continue;
    const resolution = byResolution.get(id);
    if (!resolution || resolution.kind !== "issue" ||
      (resolution.status !== "existing" && resolution.status !== "new")) {
      blockers.push(diag("UNRESOLVED_IDENTITY", id, "", "Unsafe issue identity resolution."));
      continue;
    }
    const isNew = resolution.status === "new";
    const observedIssue = isNew ? undefined : observed.issues.find((issue) =>
      issue.number === resolution.identity?.number &&
      (resolution.identity?.id === undefined || issue.id === resolution.identity.id) &&
      (resolution.identity?.nodeId === undefined || issue.nodeId === resolution.identity.nodeId));
    if (!isNew && (!observedIssue || !observedIssue.fields ||
      !Number.isSafeInteger(resolution.identity?.number))) {
      blockers.push(diag("UNRESOLVED_IDENTITY", id, "",
        "Existing field values require enriched issue discovery."));
      continue;
    }
    if (isNew && !result.diffs.some((diff) => diff.id === "issue.create:" + id &&
      diff.status === "create")) {
      blockers.push(diag("UNRESOLVED_REFERENCE", id, "", "Missing issue create producer."));
      continue;
    }
    const path: import("./types.ts").PlanPath = isNew
      ? [prefix + "/", { $ref: (id + ".number") as import("./types.ts").PlanValueRef["$ref"] }, "/issue-field-values"]
      : prefix + "/" + observedIssue!.number + "/issue-field-values";
    const predecessors = isNew ? ["issue.create:" + id] : [];
    const pending: PlanStep[] = [], skipped: PlanStep[] = [], errors: GithubDiagnostic[] = [];
    for (const name of Object.keys(resource.desired.fields ?? {}).sort()) {
      const operation = resource.desired.fields![name]!;
      const found = observed.issueFields.filter((field) => field.name === name);
      if (found.length !== 1) {
        errors.push(diag("UNKNOWN_ISSUE_FIELD", id, name, "Unknown/ambiguous field " + name + "."));
        continue;
      }
      const field = found[0]!, kind = kindOf(field);
      if (!kind) {
        errors.push(diag("UNSUPPORTED_SCHEMA_FEATURE", id, name, "Unsupported field type " + field.dataType + "."));
        continue;
      }
      if (typeof field.id !== "number" || !Number.isSafeInteger(field.id) || field.id < 1) {
        errors.push(diag("INVALID_SCHEMA", id, name, "Field has no valid numeric REST ID."));
        continue;
      }
      const normalized = operation.op === "remove"
        ? { value: null as JsonValue } : valueOf(field, kind, operation.value);
      if ("code" in normalized) {
        errors.push(diag(normalized.code, id, name, normalized.message));
        continue;
      }
      const diff = result.diffs.find((item) => item.id === "issue.field:" + id + ":" + name);
      if (!isNew && (!diff || (diff.status !== "noop" && diff.status !== "update"))) {
        errors.push(diag("INVALID_SCHEMA", id, name, "Missing safe semantic field diff."));
        continue;
      }
      const current = observedIssue?.fields?.[name] ?? null;
      const target = operation.op === "remove" ? null : normalized.value;
      if ((isNew && operation.op === "remove") || diff?.status === "noop") {
        skipped.push(step(id, name, "issue.field.set", "noop", current, target));
      } else if (operation.op === "remove") {
        const removalPath: import("./types.ts").PlanPath = typeof path === "string"
          ? path + "/" + field.id : [...path, "/", String(field.id)];
        pending.push(step(id, name, "issue.field.remove", "planned", current, null, predecessors,
          { protocol: "rest", method: "DELETE", path: removalPath }));
      } else {
        pending.push(step(id, name, "issue.field.set", "planned", current, target, predecessors,
          { protocol: "rest", method: "POST", path,
            body: { issue_field_values: [{ field_id: field.id, value: normalized.value }] } }));
      }
    }
    // Never emit a partial batch for an issue containing an invalid managed field.
    if (errors.length) blockers.push(...errors);
    else { steps.push(...pending); noops.push(...skipped); }
  }
  const byStep = (a: PlanStep, b: PlanStep) => a.id.localeCompare(b.id);
  const byDiagnostic = (a: GithubDiagnostic, b: GithubDiagnostic) =>
    (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    (a.schemaPath ?? "").localeCompare(b.schemaPath ?? "") || a.code.localeCompare(b.code);
  return {
    steps: steps.sort(byStep), noops: noops.sort(byStep),
    blockers: blockers.sort(byDiagnostic), unsupported: unsupported.sort(byDiagnostic),
  };
}
