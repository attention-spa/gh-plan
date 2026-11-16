import type {
  GithubDiagnostic, JsonValue, PlanBindings, PlanJsonValue, PlanPath,
  PlanRequest, PlanStep, PlanValueRef,
} from "./types.ts";

const REF_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)\.(number|id|nodeId)$/;

/** Invalid reference syntax or a missing/unusable post-create identity. */
export type PlanBindingErrorCode = "INVALID_PLAN_REFERENCE" | "UNRESOLVED_PLAN_REFERENCE";

/** Typed pure binding error. No network operation is attempted when thrown. */
export class PlanBindingError extends Error {
  readonly code: PlanBindingErrorCode;
  readonly reference: string;

  constructor(code: PlanBindingErrorCode, reference: string) {
    super(code + ": " + reference);
    this.name = "PlanBindingError";
    this.code = code;
    this.reference = reference;
  }
}

function parseRef(value: PlanValueRef): { logicalId: string; property: "number" | "id" | "nodeId" } {
  const match = REF_PATTERN.exec(value.$ref);
  if (!match) throw new PlanBindingError("INVALID_PLAN_REFERENCE", String(value.$ref));
  return { logicalId: match[1]!, property: match[2] as "number" | "id" | "nodeId" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** $ref is reserved: a reference object must have exactly one property. */
function isReferenceObject(value: unknown): value is PlanValueRef {
  if (!isObject(value) || !Object.hasOwn(value, "$ref")) return false;
  if (Object.keys(value).length !== 1 || typeof value.$ref !== "string") {
    throw new PlanBindingError("INVALID_PLAN_REFERENCE", String(value.$ref));
  }
  parseRef(value as PlanValueRef);
  return true;
}

function traverse(value: PlanJsonValue, visit: (reference: PlanValueRef) => void): void {
  if (isReferenceObject(value)) {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const child of value) traverse(child, visit);
  } else if (isObject(value)) {
    for (const child of Object.values(value)) traverse(child as PlanJsonValue, visit);
  }
}

/**
 * Pure scan of nested request paths, bodies and variables. Returns sorted unique
 * resource logical IDs referenced by PlanValueRef placeholders. Invalid $ref
 * shapes throw PlanBindingError; no network I/O or mutation occurs.
 */
export function requestReferences(request: PlanRequest): string[] {
  const references = new Set<string>();
  const collect = (ref: PlanValueRef): void => { references.add(parseRef(ref).logicalId); };
  if (request.protocol === "rest") {
    if (Array.isArray(request.path)) for (const part of request.path) {
      if (typeof part !== "string") {
        if (!isReferenceObject(part)) throw new PlanBindingError("INVALID_PLAN_REFERENCE", JSON.stringify(part));
        collect(part);
      }
    }
    if (request.body !== undefined) traverse(request.body, collect);
  } else {
    if (request.variables !== undefined) traverse(request.variables, collect);
  }
  return [...references].sort();
}

/**
 * Pure DAG validation. Each late-bound $ref must point to exactly one planned
 * create step, with that producer's full step ID listed in consumer.dependsOn.
 * Existing resource numbers are compiled inline, never bound later. Invalid
 * syntax or missing producer dependencies become sorted blocking diagnostics,
 * not thrown transport errors. No I/O.
 */
export function validatePlanStepReferences(steps: readonly PlanStep[]): GithubDiagnostic[] {
  const producers = new Map<string, string[]>();
  for (const step of steps) {
    if ((step.kind === "issue.create" || step.kind === "milestone.create") && step.status === "planned") {
      const entries = producers.get(step.logicalId) ?? [];
      entries.push(step.id);
      producers.set(step.logicalId, entries);
    }
  }
  const diagnostics: GithubDiagnostic[] = [];
  for (const step of steps) {
    if (!step.request) continue;
    let references: string[];
    try {
      references = requestReferences(step.request);
    } catch (error) {
      if (!(error instanceof PlanBindingError)) throw error;
      diagnostics.push({
        code: "INVALID_SCHEMA", severity: "error", blocking: true,
        logicalId: step.logicalId, schemaPath: "steps." + step.id + ".request",
        message: "Invalid request reference in " + step.id + ": " + error.reference,
      });
      continue;
    }
    for (const reference of references) {
      const candidates = producers.get(reference) ?? [];
      const ok = candidates.length === 1 &&
        candidates[0] !== step.id && step.dependsOn.includes(candidates[0]!);
      if (!ok) {
        diagnostics.push({
          code: "UNRESOLVED_REFERENCE", severity: "error", blocking: true,
          logicalId: step.logicalId, schemaPath: "steps." + step.id + ".dependsOn",
          message: "Request reference " + reference + " in " + step.id +
            " requires exactly one distinct producing create step listed in dependsOn.",
          details: { reference, producerStepIds: candidates.slice().sort() },
        });
      }
    }
  }
  return diagnostics.sort((a, b) =>
    (a.schemaPath ?? "").localeCompare(b.schemaPath ?? "") ||
    (a.details ? JSON.stringify(a.details) : "").localeCompare(b.details ? JSON.stringify(b.details) : "") ||
    a.message.localeCompare(b.message));
}

function bindRef(ref: PlanValueRef, bindings: PlanBindings): number | string {
  const { logicalId, property } = parseRef(ref);
  const value = Object.hasOwn(bindings, logicalId) && bindings[logicalId] &&
    Object.hasOwn(bindings[logicalId]!, property) ? bindings[logicalId]![property] : undefined;
  const valid = property === "nodeId"
    ? typeof value === "string" && value.length > 0
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (!valid) throw new PlanBindingError("UNRESOLVED_PLAN_REFERENCE", ref.$ref);
  return value as number | string;
}

function bindValue(value: PlanJsonValue, bindings: PlanBindings): JsonValue {
  if (isReferenceObject(value)) return bindRef(value, bindings);
  if (Array.isArray(value)) return value.map((entry) => bindValue(entry, bindings));
  if (isObject(value)) {
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value)) output[key] = bindValue(value[key] as PlanJsonValue, bindings);
    return output;
  }
  return value;
}

/** Request after substituting every future identity placeholder; safe for an executor to send. */
export type BoundPlanRequest =
  | { protocol: "rest"; method: import("./types.ts").HttpMethod; path: string; body?: JsonValue }
  | { protocol: "graphql"; document: string; operationName?: string; variables?: Record<string, JsonValue> };

/**
 * Pure late binding of PlanValueRef tokens into post-create REST IDs/node IDs.
 * Returns a new serializable request without changing input or bindings. Throws
 * PlanBindingError for malformed, absent or invalid identity values. It never
 * sends the resulting request or performs any other network I/O.
 */
export function bindPlanRequest(request: PlanRequest, bindings: PlanBindings): BoundPlanRequest {
  if (request.protocol === "rest") {
    const path: PlanPath = request.path;
    const boundPath = typeof path === "string" ? path : path.map((part) =>
      typeof part === "string" ? part : String(bindRef(part, bindings))).join("");
    return {
      protocol: "rest", method: request.method, path: boundPath,
      ...(request.body === undefined ? {} : { body: bindValue(request.body, bindings) }),
    };
  }
  return {
    protocol: "graphql", document: request.document,
    ...(request.operationName === undefined ? {} : { operationName: request.operationName }),
    ...(request.variables === undefined ? {} : { variables: bindValue(request.variables, bindings) as Record<string, JsonValue> }),
  };
}
