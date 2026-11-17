import { preflightApplyPlan } from "./apply-preflight.ts";
import type { ApplyPostconditionSpec } from "./apply-preflight.ts";
import type { BoundPlanRequest } from "./plan-bindings.ts";
import type {
  GithubPlan, ObservedIssue, ObservedMilestone, PlanBindings, PlanStep,
} from "./types.ts";

/**
 * C2 public callback contract and strict, pure whole-plan B1 preflight.
 * Public applyPlan() is explicitly opt-in and caller-injected (#190).
 *
 * All callbacks, including those claiming authoritative reads and A1 CAS
 * ownership, are CALLER-TRUSTED. Types and structural checks cannot prove
 * actual GitHub access, stop arbitrary external writers, or promise
 * global exactly-once/at-most-once semantics.
 */

export type ApplyPlanPhase =
  | "preflight" | "ownership" | "precondition" | "dispatch"
  | "verification" | "audit" | "release";
export type ApplyOwnerState =
  | "not_acquired" | "released" | "retained" | "unknown";
export type ApplyPlanErrorCode =
  | "INVALID_PLAN" | "UNSUPPORTED_PLAN" | "CALLBACK_INVALID"
  | "OWNER_CONFLICT" | "OWNER_LOST" | "OWNER_UNCERTAIN"
  | "UNVERIFIED_STATE" | "INDETERMINATE_WRITE" | "VERIFICATION_FAILED"
  | "AUDIT_FAILED" | "ABORTED" | "DISPATCH_FAILED" | "RELEASE_FAILED";

export interface SafeApplyLogEntry {
  /** Generated per invocation; opaque, nonsecret, never derived from a request. */
  runId: string;
  /** Strictly increasing within runId, for idempotent append-only audit sinks. */
  sequence: number;
  /** Ordinal only: never exposes caller-controlled step IDs or request data. */
  stepIndex?: number;
  phase: ApplyPlanPhase;
  outcome: "started" | "applied" | "skipped" | "failed";
}
export type ApplyLogSink = (
  entry: Readonly<SafeApplyLogEntry>,
) => void | Promise<void>;

export interface ApplyOwnershipAdapter {
  /** Must acquire cooperative ownership for the exact validated target. */
  acquire(repositoryFullName: string): Promise<{ ownerId: string }>;
  /** Must independently verify ownership before EVERY resource mutation. */
  assertOwned(repositoryFullName: string, ownerId: string): Promise<boolean>;
  /** Must refuse release unless terminality is independently established. */
  release(repositoryFullName: string, ownerId: string): Promise<void>;
}

/** Caller must independently verify the complete versioned B1 predicate. */
export type ApplyPostconditionRead =
  | { status: "unsatisfied" }
  | { status: "satisfied"; identity?: {
      number: number; id?: number; nodeId?: string;
    } };
export interface ApplyPostconditionContext {
  spec: Readonly<ApplyPostconditionSpec>;
  phase: "before" | "after";
  step: Readonly<PlanStep>;
  request: Readonly<BoundPlanRequest>;
  bindings: Readonly<PlanBindings>;
  /** Only for a post-dispatch check; a response alone is not authoritative. */
  responseIdentity?: unknown;
}
export type ApplyPostconditionReader = (
  context: Readonly<ApplyPostconditionContext>,
) => Promise<ApplyPostconditionRead>;

/** Caller-trusted mutation callback; NOT a built-in GitHub writer. */
export type ApplyDispatcher = (
  request: Readonly<BoundPlanRequest>,
  step: Readonly<PlanStep>,
) => Promise<unknown>;

/** Must freshly read ALL pages of open + closed issues, excluding PRs. */
export type ApplyIssueCatalogReader = (
  repositoryFullName: string,
) => Promise<readonly ObservedIssue[]>;

/** Must freshly read ALL pages of open + closed milestones. */
export type ApplyMilestoneCatalogReader = (
  repositoryFullName: string,
) => Promise<readonly ObservedMilestone[]>;

/**
 * Named public TypeScript contract. At runtime the generic C2 executor may
 * validate callback shapes, but it CANNOT establish their authority or
 * whether ownership is a real A1 ref. #189 independently verifies a
 * reference GitHub adapter, which deliberately stays internal.
 *
 * There is deliberately NO auth/fetch/baseUrl option or ownership bypass.
 */
export interface ApplyPlanOptions {
  plan: GithubPlan;
  dispatch: ApplyDispatcher;
  readPostcondition: ApplyPostconditionReader;
  readIssueCatalog?: ApplyIssueCatalogReader;
  readMilestoneCatalog?: ApplyMilestoneCatalogReader;
  ownership: ApplyOwnershipAdapter;
  acknowledgeCallbackTrust: true;
  signal?: AbortSignal;
  onLog?: ApplyLogSink;
}
export interface ApplyPlanResult {
  status: "applied" | "already_satisfied";
  runId: string;
  completedStepIds: string[];
  skippedStepIds: string[];
  bindings: PlanBindings;
  /** Only acknowledged, sanitized log entries, not arbitrary HTTP results. */
  log: SafeApplyLogEntry[];
}

export interface ApplyPlanErrorDetails {
  code: ApplyPlanErrorCode;
  phase: ApplyPlanPhase;
  stepIndex?: number;
  runId?: string;
  ownerState?: ApplyOwnerState;
  log?: readonly SafeApplyLogEntry[];
  completedStepIds?: readonly string[];
  skippedStepIds?: readonly string[];
}
/** Typed, JSON-safe, sanitized public error; never stores cause/HTTP text. */
export class ApplyPlanError extends Error {
  readonly code: ApplyPlanErrorCode;
  readonly phase: ApplyPlanPhase;
  readonly stepIndex?: number;
  readonly runId?: string;
  readonly ownerState: ApplyOwnerState;
  readonly log: readonly SafeApplyLogEntry[];
  readonly completedStepIds: readonly string[];
  readonly skippedStepIds: readonly string[];

  constructor(details: ApplyPlanErrorDetails) {
    super("Apply plan stopped (" + details.code + ").");
    this.name = "ApplyPlanError";
    this.code = details.code;
    this.phase = details.phase;
    this.ownerState = details.ownerState ?? "not_acquired";
    if (details.stepIndex !== undefined) this.stepIndex = details.stepIndex;
    if (details.runId !== undefined) this.runId = details.runId;
    this.log = Object.freeze((details.log ?? []).map((entry) =>
      Object.freeze({ ...entry })));
    this.completedStepIds = Object.freeze([...(details.completedStepIds ?? [])]);
    this.skippedStepIds = Object.freeze([...(details.skippedStepIds ?? [])]);
  }
  toJSON(): {
    code: ApplyPlanErrorCode; phase: ApplyPlanPhase;
    ownerState: ApplyOwnerState; stepIndex?: number; runId?: string;
    log: readonly SafeApplyLogEntry[];
    completedStepIds: readonly string[]; skippedStepIds: readonly string[];
  } {
    return {
      code: this.code, phase: this.phase, ownerState: this.ownerState,
      ...(this.stepIndex === undefined ? {} : { stepIndex: this.stepIndex }),
      ...(this.runId === undefined ? {} : { runId: this.runId }),
      log: this.log, completedStepIds: this.completedStepIds,
      skippedStepIds: this.skippedStepIds,
    };
  }
}

/**
 * Internal validated handoff for the #190 public callback facade.
 * The plan AND typed descriptors are deep-frozen cloned snapshots, preventing
 * caller mutation after preflight from changing what the next unit will use.
 */
export interface PreparedApplyPlan {
  readonly plan: Readonly<GithubPlan>;
  readonly postconditions: readonly Readonly<ApplyPostconditionSpec>[];
  readonly dispatch: ApplyDispatcher;
  readonly readPostcondition: ApplyPostconditionReader;
  readonly readIssueCatalog?: ApplyIssueCatalogReader;
  readonly readMilestoneCatalog?: ApplyMilestoneCatalogReader;
  readonly ownership: Readonly<ApplyOwnershipAdapter>;
  readonly signal?: AbortSignal;
  readonly onLog?: ApplyLogSink;
}

const ALLOWED_KEYS = [
  "plan", "dispatch", "readPostcondition", "readIssueCatalog",
  "readMilestoneCatalog", "ownership", "acknowledgeCallbackTrust",
  "signal", "onLog",
] as const;
const OWNERSHIP_KEYS = ["acquire", "assertOwned", "release"] as const;
function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype ||
      Object.getPrototypeOf(input) === null);
}
function hasOnlyKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every((key) => names.includes(key));
}
function failure(code: ApplyPlanErrorCode): never {
  throw new ApplyPlanError({ code, phase: "preflight" });
}
function deepFreeze<T>(input: T): T {
  if (!input || typeof input !== "object" || Object.isFrozen(input)) return input;
  for (const value of Object.values(input)) deepFreeze(value);
  return Object.freeze(input);
}
function snapshot(plan: unknown): GithubPlan {
  try { return structuredClone(plan) as GithubPlan; }
  catch { return failure("INVALID_PLAN"); }
}

/**
 * INTERNAL preflight for the public C2 applyPlan. Validates the FULL cloned
 * plan via the strict #178 B1 allowlist BEFORE reading ANY callback, taking
 * ownership or writing. A failed final step means zero callbacks/lock attempts.
 */
export function prepareApplyPlan(input: unknown): PreparedApplyPlan {
  try {
    if (!isRecord(input)) failure("CALLBACK_INVALID");
    // Do not inspect callback properties until the entire plan passes B1.
    const candidate = snapshot(input.plan);
    const result = preflightApplyPlan(candidate);
    if (!result.ok) {
      if (result.errors.some((entry) =>
        entry.code === "UNSUPPORTED_OPERATION" ||
        entry.code === "UNSUPPORTED_INTENT")) failure("UNSUPPORTED_PLAN");
      failure("INVALID_PLAN");
    }
    if (!hasOnlyKeys(input, ALLOWED_KEYS) ||
        input.acknowledgeCallbackTrust !== true ||
        typeof input.dispatch !== "function" ||
        typeof input.readPostcondition !== "function" ||
        !isRecord(input.ownership) ||
        !hasOnlyKeys(input.ownership, OWNERSHIP_KEYS) ||
        typeof input.ownership.acquire !== "function" ||
        typeof input.ownership.assertOwned !== "function" ||
        typeof input.ownership.release !== "function" ||
        (input.readIssueCatalog !== undefined &&
          typeof input.readIssueCatalog !== "function") ||
        (input.readMilestoneCatalog !== undefined &&
          typeof input.readMilestoneCatalog !== "function") ||
        (input.onLog !== undefined && typeof input.onLog !== "function") ||
        (input.signal !== undefined && !(input.signal instanceof AbortSignal)))
      failure("CALLBACK_INVALID");
    if (result.postconditions.some((spec) => spec.kind === "issue.create") &&
        typeof input.readIssueCatalog !== "function")
      failure("CALLBACK_INVALID");
    if (result.postconditions.some((spec) => spec.kind === "milestone.create") &&
        typeof input.readMilestoneCatalog !== "function")
      failure("CALLBACK_INVALID");
    if (input.signal?.aborted) failure("ABORTED");

    const options = input as unknown as ApplyPlanOptions;
    // Capture the exact callbacks for this invocation before ownership or writes.
    const owner = Object.freeze({
      acquire: options.ownership.acquire.bind(options.ownership),
      assertOwned: options.ownership.assertOwned.bind(options.ownership),
      release: options.ownership.release.bind(options.ownership),
    });
    const verifiedPlan = deepFreeze(candidate);
    const verifiedSpecs = deepFreeze(result.postconditions);
    return Object.freeze({
      plan: verifiedPlan, postconditions: verifiedSpecs,
      dispatch: options.dispatch, readPostcondition: options.readPostcondition,
      ...(options.readIssueCatalog === undefined
        ? {} : { readIssueCatalog: options.readIssueCatalog }),
      ...(options.readMilestoneCatalog === undefined
        ? {} : { readMilestoneCatalog: options.readMilestoneCatalog }),
      ownership: owner,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    });
  } catch (error) {
    if (error instanceof ApplyPlanError) throw error;
    // Malformed runtime input, cyclic values, hostile getters and proxy traps
    // never leak messages or cause any GitHub callback invocation.
    return failure("INVALID_PLAN");
  }
}
