import {
  GITHUB_CAS_LOCK_REF, GITHUB_CAS_ZERO_OID,
} from "./github-cas-lock.ts";
import type { CasCommit, CasRepository, GithubCasBackend } from "./github-cas-lock.ts";

/**
 * Operator-only recovery of an abandoned A1 lock. The required evidence and
 * authorization must be independently verified by a HUMAN before invoking.
 * The library can validate the dossier's shape and cross-check GitHub OIDs;
 * it CANNOT attest that a process or its in-flight REST requests have stopped.
 *
 * No TTL, automatic reaper, lease theft, plan resume or issue-write dispatch.
 * This module is deliberately not exported by src/index.ts.
 */
export type RecoveryPhase = "inspect" | "authorize" | "attempt" | "verify";
export type RecoveryFailureCode =
  | "INVALID_TARGET" | "NO_LOCK" | "WRONG_REPOSITORY" | "WRONG_REF"
  | "OWNER_MISMATCH" | "UNRECOGNIZED_OWNER" | "UNSAFE_EVIDENCE"
  | "UNAUTHORIZED_RECOVERY" | "PROOF_UNCERTAIN" | "AUDIT_FAILED"
  | "READ_FAILED" | "CAS_UNCERTAIN" | "RESULT_UNCERTAIN" | "ABORTED";

export class GithubRecoveryError extends Error {
  readonly code: RecoveryFailureCode;
  readonly phase: RecoveryPhase;
  constructor(code: RecoveryFailureCode, phase: RecoveryPhase) {
    super("GitHub lock recovery stopped (" + code + ").");
    this.name = "GithubRecoveryError";
    this.code = code;
    this.phase = phase;
  }
  toJSON(): { code: RecoveryFailureCode; phase: RecoveryPhase } {
    return { code: this.code, phase: this.phase };
  }
}

export interface AbandonedLockInspection {
  readonly repository: string;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly lockRef: typeof GITHUB_CAS_LOCK_REF;
  readonly ownerOid: string;
  readonly ownerRunId: string;
  readonly ownerNonce: string;
  readonly baseOid: string;
}

/** All links point to a durable, access-controlled GitHub incident/audit record. */
export interface RecoveryDossier {
  repository: string;
  repositoryId: number;
  repositoryNodeId: string;
  observedOwnerOid: string;
  observedRunId: string;
  operatorLogin: string;
  reason: "crashed_owner" | "terminated_owner" | "disposable_test";
  incidentUrl: string;
  /**
   * The operator must independently establish ALL THREE conditions; an old
   * timestamp, idle runner or finished Actions job cannot establish them.
   */
  stopProof: {
    processTerminated: true;
    otherWorkersStopped: true;
    allNetworkRequestsTerminal: true;
    evidenceUrl: string;
    verifiedAt: string;
  };
  /** Read all possibly affected resources independently before clearing. */
  resourceReview: {
    disposition: "no_writes_started" | "all_operations_reconciled";
    unresolvedOperations: 0;
    evidenceUrl: string;
    verifiedAt: string;
  };
  /** Human approval must name the exact target and immutable owner OID. */
  humanApproval: {
    explicitlyApproved: true;
    approverLogin: string;
    approvedRepository: string;
    approvedOwnerOid: string;
    approvalUrl: string;
    approvedAt: string;
  };
}

export type RecoveryAuditEvent = "authorized_attempt" | "confirmed_release";
export interface RecoveryAuditRecord {
  version: 1;
  event: RecoveryAuditEvent;
  repository: string;
  ownerOid: string;
  ownerRunId: string;
  operatorLogin: string;
  approverLogin: string;
  reason: RecoveryDossier["reason"];
  incidentUrl: string;
  stopProofUrl: string;
  resourceReviewUrl: string;
  approvalUrl: string;
  recordedAt: string;
}
export interface RecoveryContext {
  backend: Pick<GithubCasBackend, "repository" | "lockRef" | "commit" | "cas">;
  /** Must resolve only after a durable incident/audit record is persisted. */
  recordAudit: (entry: Readonly<RecoveryAuditRecord>) => Promise<void>;
  signal?: AbortSignal;
}
export interface RecoveryResult {
  status: "released";
  repository: string;
  ownerOid: string;
  audit: Readonly<RecoveryAuditRecord>;
}

const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;
const OID = /^[0-9a-f]{40}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function oid(value: unknown): value is string {
  return typeof value === "string" && OID.test(value) && value !== GITHUB_CAS_ZERO_OID;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function fail(code: RecoveryFailureCode, phase: RecoveryPhase): never {
  throw new GithubRecoveryError(code, phase);
}
function githubEvidence(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 1024) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" &&
      !parsed.username && !parsed.password && !parsed.search &&
      /^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/[1-9][0-9]*$/.test(parsed.pathname) &&
      (!parsed.hash || /^#issuecomment-[1-9][0-9]*$/.test(parsed.hash));
  } catch { return false; }
}
function isoDate(value: unknown): number | null {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return null;
  const number = Date.parse(value);
  return Number.isFinite(number) && new Date(number).toISOString() === value
    ? number : null;
}
function ownerMessage(commit: CasCommit, repository: CasRepository):
  Pick<AbandonedLockInspection, "ownerRunId" | "ownerNonce" | "baseOid"> {
  if (!record(commit) || !oid(commit.oid) || !oid(commit.treeOid) ||
      !Array.isArray(commit.parentOids) || commit.parentOids.length !== 1 ||
      !oid(commit.parentOids[0]) || typeof commit.message !== "string")
    fail("UNRECOGNIZED_OWNER", "inspect");
  const parts = commit.message.split("\n");
  if (parts.length !== 7 || parts[0] !== "gh-plan-cas/v1" ||
      parts[1] !== "repository=" + repository.fullName ||
      parts[2] !== "repository-id=" + repository.id ||
      parts[3] !== "repository-node-id=" + repository.nodeId ||
      !parts[4]?.startsWith("run-id=") ||
      !parts[5]?.startsWith("nonce=") ||
      parts[6] !== "base=" + commit.parentOids[0])
    fail("UNRECOGNIZED_OWNER", "inspect");
  const runId = parts[4]!.slice(7);
  const nonce = parts[5]!.slice(6);
  if (!RUN.test(runId) || !UUID.test(nonce)) fail("UNRECOGNIZED_OWNER", "inspect");
  return { ownerRunId: runId, ownerNonce: nonce, baseOid: commit.parentOids[0]! };
}
function checkContext(context: RecoveryContext, phase: RecoveryPhase): void {
  if (!record(context) || !record(context.backend) ||
    typeof context.backend.repository !== "function" ||
    typeof context.backend.lockRef !== "function" ||
    typeof context.backend.commit !== "function" ||
    typeof context.backend.cas !== "function" ||
    typeof context.recordAudit !== "function")
    fail("INVALID_TARGET", phase);
}
function aborted(signal: AbortSignal | undefined, phase: RecoveryPhase): void {
  if (signal?.aborted) fail("ABORTED", phase);
}

/** Always GET the exact ref and Git commit; never inspect prefix-matching refs. */
export async function inspectAbandonedGithubLock(repository: string,
  context: RecoveryContext): Promise<AbandonedLockInspection> {
  checkContext(context, "inspect");
  if (typeof repository !== "string" || !REPOSITORY.test(repository))
    fail("INVALID_TARGET", "inspect");
  aborted(context.signal, "inspect");
  let actual: CasRepository;
  try { actual = await context.backend.repository(repository); }
  catch { return fail("READ_FAILED", "inspect"); }
  if (!record(actual) || actual.fullName !== repository ||
      !positive(actual.id) || typeof actual.nodeId !== "string" || !actual.nodeId)
    fail("WRONG_REPOSITORY", "inspect");
  let ref: Awaited<ReturnType<RecoveryContext["backend"]["lockRef"]>>;
  try { ref = await context.backend.lockRef(repository); }
  catch { return fail("READ_FAILED", "inspect"); }
  if (ref === null) fail("NO_LOCK", "inspect");
  if (!record(ref) || ref.ref !== GITHUB_CAS_LOCK_REF ||
      ref.type !== "commit" || !oid(ref.oid))
    fail("WRONG_REF", "inspect");
  let owner: CasCommit;
  try { owner = await context.backend.commit(repository, ref.oid); }
  catch { return fail("READ_FAILED", "inspect"); }
  if (!record(owner) || owner.oid !== ref.oid) fail("OWNER_MISMATCH", "inspect");
  const parsed = ownerMessage(owner, actual);
  // Verify that the owner was built from a real parent with identical tree,
  // not merely a crafted ref pointing to unrelated Git history.
  let base: CasCommit;
  try { base = await context.backend.commit(repository, parsed.baseOid); }
  catch { return fail("READ_FAILED", "inspect"); }
  if (!record(base) || base.oid !== parsed.baseOid || base.treeOid !== owner.treeOid)
    fail("UNRECOGNIZED_OWNER", "inspect");
  return Object.freeze({
    repository, repositoryId: actual.id, repositoryNodeId: actual.nodeId,
    lockRef: GITHUB_CAS_LOCK_REF, ownerOid: ref.oid,
    ...parsed,
  });
}
function approve(inspection: AbandonedLockInspection, data: RecoveryDossier): void {
  if (!record(data) || !record(data.stopProof) ||
      !record(data.resourceReview) || !record(data.humanApproval) ||
      !REPOSITORY.test(data.repository) || !positive(data.repositoryId) ||
      typeof data.repositoryNodeId !== "string" || !data.repositoryNodeId ||
      !oid(data.observedOwnerOid) || !RUN.test(data.observedRunId) ||
      !LOGIN.test(data.operatorLogin) ||
      !["crashed_owner", "terminated_owner", "disposable_test"].includes(data.reason) ||
      !githubEvidence(data.incidentUrl))
    fail("UNSAFE_EVIDENCE", "authorize");
  if (data.repository !== inspection.repository ||
      data.repositoryId !== inspection.repositoryId ||
      data.repositoryNodeId !== inspection.repositoryNodeId ||
      data.observedOwnerOid !== inspection.ownerOid ||
      data.observedRunId !== inspection.ownerRunId)
    fail("OWNER_MISMATCH", "authorize");
  if (data.stopProof.processTerminated !== true ||
      data.stopProof.otherWorkersStopped !== true ||
      data.stopProof.allNetworkRequestsTerminal !== true ||
      !githubEvidence(data.stopProof.evidenceUrl) ||
      data.resourceReview.unresolvedOperations !== 0 ||
      !["no_writes_started", "all_operations_reconciled"].includes(
        data.resourceReview.disposition) ||
      !githubEvidence(data.resourceReview.evidenceUrl))
    fail("PROOF_UNCERTAIN", "authorize");
  if (data.humanApproval.explicitlyApproved !== true ||
      !LOGIN.test(data.humanApproval.approverLogin) ||
      data.humanApproval.approvedRepository !== inspection.repository ||
      data.humanApproval.approvedOwnerOid !== inspection.ownerOid ||
      !githubEvidence(data.humanApproval.approvalUrl))
    fail("UNAUTHORIZED_RECOVERY", "authorize");
  const stop = isoDate(data.stopProof.verifiedAt);
  const review = isoDate(data.resourceReview.verifiedAt);
  const approved = isoDate(data.humanApproval.approvedAt);
  if (stop === null || review === null || approved === null ||
      approved < stop || approved < review)
    fail("PROOF_UNCERTAIN", "authorize");
}

/**
 * Single, manually authorized CAS deletion. This checks the saved inspection
 * against a new authoritative exact-ref/commit read, persists intent, then
 * sends ONE matching-before-OID CAS. No operation automatically resumes.
 */
export async function recoverAbandonedGithubLock(
  inspection: AbandonedLockInspection,
  dossier: RecoveryDossier,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  checkContext(context, "authorize");
  if (!record(inspection) || inspection.lockRef !== GITHUB_CAS_LOCK_REF ||
      typeof inspection.repository !== "string" ||
      !REPOSITORY.test(inspection.repository) ||
      !oid(inspection.ownerOid) || !RUN.test(inspection.ownerRunId))
    fail("INVALID_TARGET", "authorize");
  aborted(context.signal, "authorize");
  approve(inspection, dossier);
  const current = await inspectAbandonedGithubLock(inspection.repository, context);
  if (current.repository !== inspection.repository ||
      current.repositoryId !== inspection.repositoryId ||
      current.repositoryNodeId !== inspection.repositoryNodeId ||
      current.ownerOid !== inspection.ownerOid ||
      current.ownerRunId !== inspection.ownerRunId ||
      current.ownerNonce !== inspection.ownerNonce ||
      current.baseOid !== inspection.baseOid)
    fail("OWNER_MISMATCH", "authorize");
  aborted(context.signal, "attempt");
  const shared = {
    version: 1 as const, repository: current.repository, ownerOid: current.ownerOid,
    ownerRunId: current.ownerRunId,
    operatorLogin: dossier.operatorLogin,
    approverLogin: dossier.humanApproval.approverLogin,
    reason: dossier.reason, incidentUrl: dossier.incidentUrl,
    stopProofUrl: dossier.stopProof.evidenceUrl,
    resourceReviewUrl: dossier.resourceReview.evidenceUrl,
    approvalUrl: dossier.humanApproval.approvalUrl,
  };
  const attempted: RecoveryAuditRecord = Object.freeze({
    ...shared, event: "authorized_attempt", recordedAt: new Date().toISOString(),
  });
  try { await context.recordAudit(attempted); }
  catch { return fail("AUDIT_FAILED", "attempt"); }
  aborted(context.signal, "attempt");
  // Re-read immediately before CAS; if ownership changed, refuse. CAS itself
  // closes the remaining race by requiring the old owner OID exactly.
  let beforeCas: AbandonedLockInspection;
  try { beforeCas = await inspectAbandonedGithubLock(inspection.repository, context); }
  catch { return fail("READ_FAILED", "attempt"); }
  if (beforeCas.ownerOid !== inspection.ownerOid ||
      beforeCas.ownerRunId !== inspection.ownerRunId ||
      beforeCas.ownerNonce !== inspection.ownerNonce)
    fail("OWNER_MISMATCH", "attempt");
  let lostReply = false;
  try {
    await context.backend.cas(current.repositoryNodeId,
      current.ownerOid, GITHUB_CAS_ZERO_OID);
  } catch { lostReply = true; }
  // A GraphQL response may be lost even if deletion committed. Regardless of
  // observed absence, a lost reply is never proof that this CAS succeeded.
  let afterCas: Awaited<ReturnType<RecoveryContext["backend"]["lockRef"]>>;
  try { afterCas = await context.backend.lockRef(current.repository); }
  catch { return fail("RESULT_UNCERTAIN", "verify"); }
  if (lostReply) fail("CAS_UNCERTAIN", "verify");
  if (afterCas !== null) fail("RESULT_UNCERTAIN", "verify");
  const completed: RecoveryAuditRecord = Object.freeze({
    ...shared, event: "confirmed_release", recordedAt: new Date().toISOString(),
  });
  try { await context.recordAudit(completed); }
  catch { return fail("RESULT_UNCERTAIN", "verify"); }
  return Object.freeze({
    status: "released", repository: current.repository,
    ownerOid: current.ownerOid, audit: completed,
  });
}
