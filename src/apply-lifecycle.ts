import { prepareApplyPlan, ApplyPlanError } from "./apply-contract.ts";
import { bindPlanRequest } from "./plan-bindings.ts";
import { matchesMarker } from "./identity.ts";
import { fromGithubMilestoneDueOn } from "./milestone-due-date.ts";
import type {
  ApplyPlanErrorCode, ApplyPlanOptions, ApplyPlanPhase, ApplyOwnerState,
  ApplyPlanResult, ApplyPostconditionRead, PreparedApplyPlan, SafeApplyLogEntry,
} from "./apply-contract.ts";
import type { ApplyPostconditionSpec, ApplyFieldPredicate } from "./apply-preflight.ts";
import type { BoundPlanRequest } from "./plan-bindings.ts";
import type {
  GithubPlan, ObservedIssue, ObservedMilestone, PlanBindings, PlanStep, PlanValueRef,
} from "./types.ts";

/**
 * INTERNAL C2 callback execution lifecycle (#188).
 * This function is NOT exported from the package entrypoint. It must never
 * acquire credentials or dispatch GitHub requests itself; #189 must provide
 * and independently validate a trusted GitHub adapter, and #190 gates the
 * public applyPlan() export.
 *
 * The callback provider can lie. This core checks result SHAPES, normalized
 * B1 predicates against callback-provided catalog fields, identity coherence,
 * ordering and owner assertions; it cannot certify GitHub truth, issue writes
 * fencing or globally exactly-once execution.
 */
type Identity = { number: number; id?: number; nodeId?: string };
type Read = Readonly<ApplyPostconditionRead>;
const ID = /^[A-Za-z0-9._-]{1,160}$/;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validId(value: unknown): value is Identity {
  return isRecord(value) && positive(value.number) &&
    (value.id === undefined || positive(value.id)) &&
    (value.nodeId === undefined ||
      typeof value.nodeId === "string" && value.nodeId.length > 0);
}
function identity(value: unknown): Identity | undefined {
  if (value === undefined) return undefined;
  if (!validId(value)) return undefined;
  return {
    number: value.number, ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
  };
}
function coherent(a: Identity | undefined, b: Identity | undefined): boolean {
  if (!a || !b || a.number !== b.number) return false;
  return (a.id === undefined || b.id === undefined || a.id === b.id) &&
    (a.nodeId === undefined || b.nodeId === undefined || a.nodeId === b.nodeId);
}
function readShape(value: unknown): value is Read {
  return isRecord(value) && (
    value.status === "unsatisfied" && Object.keys(value).length === 1 ||
    value.status === "satisfied" &&
      Object.keys(value).every((k) => k === "status" || k === "identity") &&
      (value.identity === undefined || validId(value.identity))
  );
}
function snapshot(bindings: PlanBindings): PlanBindings {
  return Object.fromEntries(Object.entries(bindings).map(([id, found]) =>
    [id, { ...found }]));
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
function expect(spec: ApplyPostconditionSpec, predicate: ApplyFieldPredicate,
  bindings: PlanBindings): unknown {
  const expected = predicate.expected;
  if (isRecord(expected) && typeof expected.$ref === "string") {
    if (!expected.$ref.endsWith(".number")) throw new Error("bad-reference");
    const id = expected.$ref.slice(0, -".number".length);
    const resolved = bindings[id]?.number;
    if (!positive(resolved)) throw new Error("unresolved-reference");
    return resolved;
  }
  return expected;
}
function dateMatch(actual: unknown, expected: unknown): boolean {
  return typeof actual === "string" && typeof expected === "string" &&
    fromGithubMilestoneDueOn(actual) === fromGithubMilestoneDueOn(expected) &&
    fromGithubMilestoneDueOn(actual) !== undefined;
}
/**
 * Only check fields that the claimed catalog actually makes observable.
 * Missing required catalog fields fail closed. Full by-number verification and
 * omitted-field preservation remain the caller reader's responsibility.
 */
function predicateMatch(spec: ApplyPostconditionSpec,
  entry: ObservedIssue | ObservedMilestone, bindings: PlanBindings): boolean {
  for (const predicate of spec.predicates) {
    let actual: unknown;
    if (entry.kind === "issue") {
      actual = predicate.field === "milestone" ? entry.milestoneNumber :
        predicate.field === "title" ? entry.title :
        predicate.field === "body" ? entry.body :
        predicate.field === "state" ? entry.state : undefined;
    } else {
      actual = predicate.field === "due_on" ? entry.due_on :
        predicate.field === "title" ? entry.title :
        predicate.field === "description" ? entry.description :
        predicate.field === "state" ? entry.state : undefined;
    }
    const wanted = expect(spec, predicate, bindings);
    if (actual === undefined) return false;
    if (predicate.comparison === "utc_day") {
      if (!dateMatch(actual, wanted)) return false;
    } else if (predicate.comparison === "null") {
      if (actual !== null && !(predicate.field === "description" && actual === ""))
        return false;
    } else if (actual !== wanted) return false;
  }
  return true;
}
function numberFor(spec: ApplyPostconditionSpec, bindings: PlanBindings): number {
  if (spec.identity.strategy === "issue_number") {
    if (typeof spec.identity.number === "number") return spec.identity.number;
    const token = spec.identity.number.$ref;
    if (!token.endsWith(".number")) throw new Error("bad-ref");
    const candidate = bindings[token.slice(0, -".number".length)]?.number;
    if (positive(candidate)) return candidate;
  } else if (spec.identity.strategy === "milestone_number") {
    return spec.identity.number;
  }
  throw new Error("missing-number");
}
/** Match only exact canonical/custom issue markers, not substrings or PRs. */
async function catalog(
  callbacks: PreparedApplyPlan, spec: ApplyPostconditionSpec,
  bindings: PlanBindings, checked: Read,
): Promise<Identity | undefined> {
  const fullName = callbacks.plan.repository.fullName;
  let matches: Array<ObservedIssue | ObservedMilestone> = [];
  if (spec.kind.startsWith("issue")) {
    if (spec.identity.strategy !== "unique_issue_marker" &&
        spec.identity.strategy !== "issue_number") throw new Error("bad-issue-identity");
    const rows = await callbacks.readIssueCatalog!(fullName);
    if (!Array.isArray(rows) || rows.some((row) =>
      !isRecord(row) || row.kind !== "issue" ||
      !positive(row.number) || !positive(row.id) ||
      typeof row.nodeId !== "string" || !row.nodeId ||
      typeof row.title !== "string" || typeof row.state !== "string" ||
      !(row.body === null || typeof row.body === "string")))
      throw new Error("invalid-issue-catalog");
    const marker = spec.identity.marker;
    const custom = !marker.startsWith("<!-- gh-plan:");
    matches = (rows as ObservedIssue[]).filter((row) =>
      matchesMarker(row.body, marker, custom));
  } else if (spec.kind === "milestone.create") {
    if (spec.identity.strategy !== "unique_milestone_title") throw new Error("bad-title-identity");
    const rows = await callbacks.readMilestoneCatalog!(fullName);
    if (!Array.isArray(rows) || rows.some((row) =>
      !isRecord(row) || row.kind !== "milestone" ||
      !positive(row.number) || !positive(row.id) ||
      typeof row.nodeId !== "string" || !row.nodeId ||
      typeof row.title !== "string" || !["open", "closed"].includes(row.state)))
      throw new Error("invalid-milestone-catalog");
    matches = (rows as ObservedMilestone[]).filter((row) =>
      row.title === spec.identity.title);
  } else return undefined;
  if (matches.length > 1) throw new Error("ambiguous-catalog");
  const row = matches[0];
  if (!row) {
    if (checked.status === "satisfied") throw new Error("false-positive-reader");
    if (spec.kind.endsWith(".update")) throw new Error("missing-update-identity");
    return undefined;
  }
  if (spec.kind.endsWith(".update") && row.number !== numberFor(spec, bindings))
    throw new Error("marker-wrong-owner");
  const found: Identity = {
    number: row.number, ...(row.id === undefined ? {} : { id: row.id }),
    ...(row.nodeId === undefined ? {} : { nodeId: row.nodeId }),
  };
  if (checked.status === "unsatisfied") {
    // Existing exact-owner marker/title but different fields: never replay
    // a create POST or adopt a conflicting resource.
    if (spec.kind.endsWith(".create")) throw new Error("create-owner-conflict");
    return found;
  }
  if (!predicateMatch(spec, row, bindings)) throw new Error("catalog-field-mismatch");
  if (spec.kind.endsWith(".create") && !coherent(found, identity(checked.identity)))
    throw new Error("catalog-reader-mismatch");
  if (spec.kind === "issue.update" && checked.identity !== undefined &&
      !coherent(found, identity(checked.identity)))
    throw new Error("update-reader-mismatch");
  return found;
}
function ordered(plan: GithubPlan): PlanStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const output: PlanStep[] = [], done = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error("cycle");
    if (done.has(id)) return;
    const step = byId.get(id);
    if (!step) throw new Error("missing");
    active.add(id);
    for (const predecessor of [...step.dependsOn].sort()) visit(predecessor);
    active.delete(id);
    done.add(id);
    output.push(step);
  }
  for (const id of [...byId.keys()].sort()) visit(id);
  return output;
}
function checkCreateIdentity(spec: ApplyPostconditionSpec, first: Read,
  response: unknown, catalogId: Identity | undefined): Identity {
  if (first.status !== "satisfied") throw new Error("unverified");
  const verified = identity(first.identity);
  if (!verified || !catalogId || !coherent(verified, catalogId))
    throw new Error("unverified-create-identity");
  const claimed = identity(response);
  if (response !== undefined && response !== null && claimed === undefined)
    throw new Error("malformed-create-reply");
  if (claimed && !coherent(claimed, verified))
    throw new Error("create-reply-mismatch");
  if (spec.kind !== "issue.create" && spec.kind !== "milestone.create")
    throw new Error("not-a-create");
  return {
    number: verified.number,
    ...(verified.id === undefined ? {} : { id: verified.id }),
    ...(verified.nodeId === undefined ? {} : { nodeId: verified.nodeId }),
  };
}
function resultCode(code: ApplyPlanErrorCode, phase: ApplyPlanPhase,
  ownerState: ApplyOwnerState, runId: string, log: readonly SafeApplyLogEntry[],
  completed: readonly string[], skipped: readonly string[],
  stepIndex?: number): ApplyPlanError {
  return new ApplyPlanError({
    code, phase, ownerState, runId, log,
    completedStepIds: completed, skippedStepIds: skipped,
    ...(stepIndex === undefined ? {} : { stepIndex }),
  });
}
/**
 * Internal only; full-plan preflight is ALWAYS first. All callback effects
 * are sequential, and the last unsupported step rejects before acquire.
 * No production dispatch, HTTP, GitHub auth or public applyPlan export.
 */
export async function executeCallbackApplyPlan(
  options: ApplyPlanOptions,
): Promise<ApplyPlanResult> {
  const prepared = prepareApplyPlan(options);
  const plan = prepared.plan as GithubPlan;
  const steps = ordered(plan);
  const specs = new Map(prepared.postconditions.map((spec) => [spec.stepId, spec]));
  const bindings: PlanBindings = Object.create(null) as PlanBindings;
  const completed: string[] = [];
  const skipped: string[] = [];
  const accepted: SafeApplyLogEntry[] = [];
  const runId = crypto.randomUUID();
  let ownerId: string | undefined;
  let ownerState: ApplyOwnerState = "not_acquired";
  let releaseSafe = true;
  let activeStep: number | undefined;
  let phase: ApplyPlanPhase = "ownership";
  let code: ApplyPlanErrorCode = "OWNER_UNCERTAIN";
  let loggingFailed = false;
  let wrote = false;

  async function log(phase: ApplyPlanPhase,
    outcome: SafeApplyLogEntry["outcome"], stepIndex?: number): Promise<void> {
    const entry: SafeApplyLogEntry = frozen({
      runId, sequence: accepted.length + 1,
      ...(stepIndex === undefined ? {} : { stepIndex }), phase, outcome,
    });
    try {
      if (prepared.onLog) await prepared.onLog(entry);
      accepted.push(entry);
    } catch {
      loggingFailed = true;
      throw new Error("sink-failed");
    }
  }
  async function assertOwner(): Promise<void> {
    if (ownerId === undefined) throw new Error("owner-missing");
    try {
      if (await prepared.ownership.assertOwned(plan.repository.fullName, ownerId) !== true)
        throw new Error("owner-changed");
    } catch {
      ownerState = "unknown";
      code = "OWNER_LOST";
      phase = "ownership";
      releaseSafe = false;
      throw new Error("owner-unverified");
    }
  }
  async function release(): Promise<void> {
    await assertOwner();
    try {
      await prepared.ownership.release(plan.repository.fullName, ownerId!);
      ownerState = "released";
    } catch {
      ownerState = "unknown";
      code = "RELEASE_FAILED";
      phase = "release";
      releaseSafe = false;
      throw new Error("release-uncertain");
    }
  }
  try {
    if (prepared.signal?.aborted) {
      phase = "preflight"; code = "ABORTED";
      throw new Error("aborted");
    }
    let owner: unknown;
    try {
      owner = await prepared.ownership.acquire(plan.repository.fullName);
    } catch {
      code = "OWNER_UNCERTAIN";
      ownerState = "unknown";
      releaseSafe = false; // acquire may have succeeded before its reply was lost
      throw new Error("owner-acquire-unknown");
    }
    if (!isRecord(owner) || typeof owner.ownerId !== "string" ||
        !ID.test(owner.ownerId) || Object.keys(owner).some((k) => k !== "ownerId")) {
      code = "OWNER_UNCERTAIN"; ownerState = "unknown"; releaseSafe = false;
      throw new Error("bad-owner");
    }
    ownerId = owner.ownerId;
    ownerState = "retained";
    await assertOwner();
    phase = "audit";
    try { await log("ownership", "started"); }
    catch { code = "AUDIT_FAILED"; throw new Error("audit-owner"); }

    for (const [index, step] of steps.entries()) {
      activeStep = index;
      const spec = specs.get(step.id);
      if (!spec) { phase = "preflight"; code = "INVALID_PLAN"; throw new Error("missing-spec"); }
      if (prepared.signal?.aborted) {
        phase = "precondition"; code = "ABORTED"; throw new Error("aborted");
      }
      let request: BoundPlanRequest;
      try {
        request = frozen(bindPlanRequest(step.request!, bindings));
      } catch {
        phase = "precondition"; code = "UNVERIFIED_STATE";
        throw new Error("bind-failed");
      }
      phase = "precondition"; code = "UNVERIFIED_STATE";
      let first: Read, catalogBefore: Identity | undefined;
      try {
        const outcome: unknown = await prepared.readPostcondition(frozen({
          spec, phase: "before", step, request, bindings: frozen(snapshot(bindings)),
        }));
        if (!readShape(outcome)) throw new Error("invalid-read");
        first = outcome;
        catalogBefore = await catalog(prepared, spec, bindings, first);
      } catch { throw new Error("before-unverified"); }
      if (first.status === "satisfied") {
        if (spec.kind.endsWith(".create")) {
          const verified = checkCreateIdentity(spec, first, undefined, catalogBefore);
          bindings[step.logicalId] = verified;
        } else if (first.identity !== undefined &&
          spec.kind === "issue.update" && catalogBefore &&
          !coherent(identity(first.identity), catalogBefore)) {
          throw new Error("stale-update-identity");
        }
        phase = "audit";
        try { await log("precondition", "skipped", index); }
        catch { code = "AUDIT_FAILED"; throw new Error("audit-skip"); }
        completed.push(step.id);
        skipped.push(step.id);
        continue;
      }

      if (prepared.signal?.aborted) {
        phase = "precondition"; code = "ABORTED"; throw new Error("aborted");
      }
      // Audit intent BEFORE the caller may start a resource mutation.
      phase = "audit";
      try { await log("dispatch", "started", index); }
      catch { code = "AUDIT_FAILED"; throw new Error("audit-intent"); }
      phase = "ownership";
      await assertOwner(); // immediate last awaited callback before dispatch
      if (prepared.signal?.aborted) {
        phase = "precondition"; code = "ABORTED"; throw new Error("aborted");
      }
      phase = "dispatch"; code = "INDETERMINATE_WRITE";
      wrote = true;
      releaseSafe = false; // cannot release until definitive readback
      let response: unknown;
      try { response = await prepared.dispatch(request, step); }
      catch { throw new Error("ambiguous-write"); }
      phase = "verification"; code = "VERIFICATION_FAILED";
      let verified: Read, afterCatalog: Identity | undefined;
      try {
        const outcome: unknown = await prepared.readPostcondition(frozen({
          spec, phase: "after", step, request,
          bindings: frozen(snapshot(bindings)), responseIdentity: response,
        }));
        if (!readShape(outcome) || outcome.status !== "satisfied")
          throw new Error("postwrite-unverified");
        verified = outcome;
        afterCatalog = await catalog(prepared, spec, bindings, verified);
      } catch { throw new Error("postwrite-unverified"); }
      if (spec.kind.endsWith(".create")) {
        let found: Identity;
        try { found = checkCreateIdentity(spec, verified, response, afterCatalog); }
        catch { throw new Error("create-id-mismatch"); }
        bindings[step.logicalId] = found;
      } else if (verified.identity !== undefined &&
        spec.kind === "issue.update" && afterCatalog &&
        !coherent(identity(verified.identity), afterCatalog)) {
        throw new Error("update-id-mismatch");
      }
      // A read returning satisfied only means the CALLER asserted a terminal
      // postcondition. This generic facade cannot prove it read GitHub.
      releaseSafe = true;
      phase = "audit";
      try { await log("verification", "applied", index); }
      catch {
        code = "AUDIT_FAILED";
        releaseSafe = false; // after-write audit wasn't durably acknowledged
        throw new Error("postwrite-audit-failed");
      }
      completed.push(step.id);
      if (prepared.signal?.aborted) {
        phase = "verification"; code = "ABORTED";
        throw new Error("abort-after-terminal-verified-write");
      }
    }
    activeStep = undefined;
    phase = "release"; code = "RELEASE_FAILED";
    await release();
    phase = "audit";
    try { await log("release", "applied"); }
    catch { code = "AUDIT_FAILED"; throw new Error("audit-after-release"); }
    return {
      status: wrote ? "applied" : "already_satisfied",
      runId, completedStepIds: [...completed], skippedStepIds: [...skipped],
      bindings: snapshot(bindings), log: accepted.map((entry) => ({ ...entry })),
    };
  } catch {
    if (loggingFailed) code = "AUDIT_FAILED";
    // Record the failure once if the sink has not already failed. A sink error
    // after a possible dispatch is itself a reason to retain the lock.
    if (!loggingFailed) {
      try { await log(phase, "failed", activeStep); }
      catch {
        code = "AUDIT_FAILED";
        if (wrote) releaseSafe = false;
      }
    }
    if (ownerState === "retained" && releaseSafe && !loggingFailed) {
      try { await release(); }
      catch {
        // Retain/unknown: never report a clean lock if release was uncertain.
      }
    }
    throw resultCode(code, phase, ownerState, runId, accepted,
      completed, skipped, activeStep);
  }
}
