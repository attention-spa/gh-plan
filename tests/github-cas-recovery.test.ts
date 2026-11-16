import {
  inspectAbandonedGithubLock, recoverAbandonedGithubLock, GithubRecoveryError,
} from "../src/github-cas-recovery.ts";
import type {
  RecoveryDossier, RecoveryContext, RecoveryAuditRecord, AbandonedLockInspection,
} from "../src/github-cas-recovery.ts";
import {
  GITHUB_CAS_LOCK_REF, GITHUB_CAS_ZERO_OID,
} from "../src/github-cas-lock.ts";
import type {
  CasRepository, CasCommit, CasRef, GithubCasBackend,
} from "../src/github-cas-lock.ts";

function assert(value: unknown, why: string): asserts value {
  if (!value) throw Error(why);
}
function equal(actual: unknown, expected: unknown, why: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(why + "; actual=" + JSON.stringify(actual) +
      " expected=" + JSON.stringify(expected));
}
async function denies(name: string, fn: () => Promise<unknown>,
  code: GithubRecoveryError["code"], phase?: GithubRecoveryError["phase"]): Promise<void> {
  let found: unknown;
  try { await fn(); } catch (error) { found = error; }
  assert(found instanceof GithubRecoveryError, name + " must fail with sanitized error.");
  equal(found.code, code, name + " code");
  if (phase) equal(found.phase, phase, name + " phase");
  assert(!found.message.includes("DO_NOT_LOG") &&
    !JSON.stringify(found).includes("DO_NOT_LOG"),
    name + " must not leak caller secrets.");
}
const fullName = "acme/widgets", repoNode = "R_acmewidgets";
const baseOid = "1".repeat(40), treeOid = "2".repeat(40);
const aOid = "a".repeat(40), bOid = "b".repeat(40);
const UUID = "00000000-0000-4000-8000-000000000001";
const gh = "https://github.com/acme/widgets/issues/9";
const stopUrl = "https://github.com/acme/widgets/issues/9#issuecomment-101";
const resourceUrl = "https://github.com/acme/widgets/issues/9#issuecomment-102";
const approvalUrl = "https://github.com/acme/widgets/issues/9#issuecomment-103";
const repo: CasRepository = {
  fullName, id: 101, nodeId: repoNode, defaultBranch: "main",
};
const baseCommit: CasCommit = {
  oid: baseOid, treeOid, parentOids: [], message: "Init",
};
function owner(oid: string, overrides: Partial<CasCommit> = {}): CasCommit {
  return {
    oid, treeOid, parentOids: [baseOid],
    message: [
      "gh-plan-cas/v1", "repository=" + fullName,
      "repository-id=101", "repository-node-id=" + repoNode,
      "run-id=operator-lost-run", "nonce=" + UUID, "base=" + baseOid,
    ].join("\n"),
    ...overrides,
  };
}
class Fake implements Pick<GithubCasBackend, "repository" | "lockRef" | "commit" | "cas"> {
  current: string | null = aOid;
  commits = new Map<string, CasCommit>([[baseOid, baseCommit], [aOid, owner(aOid)],
    [bOid, owner(bOid)]]);
  calls: string[] = [];
  casCalls: Array<{ repositoryNodeId: string; before: string; after: string }> = [];
  readCount = 0;
  mutateOnRead = 0;
  wrongRef = false;
  changedRepo = false;
  denied = false;
  lostAfter = false;
  lostBefore = false;
  noReadAfter = false;
  repoDeniedAfter = false;
  async repository(name: string): Promise<CasRepository> {
    this.calls.push("repository");
    if (this.denied || this.repoDeniedAfter && this.casCalls.length > 0)
      throw Error("DO_NOT_LOG permission denied");
    return { ...repo, fullName: this.changedRepo ? "wrong/other" : name };
  }
  async lockRef(name: string): Promise<CasRef | null> {
    this.calls.push("lockRef");
    this.readCount++;
    if (this.denied) throw Error("DO_NOT_LOG unexpected permission failure");
    if (this.noReadAfter && this.casCalls.length) throw Error("DO_NOT_LOG readback unavailable");
    if (this.mutateOnRead === this.readCount) this.current = bOid;
    return this.current === null ? null :
      { ref: this.wrongRef ? "refs/heads/other" : GITHUB_CAS_LOCK_REF,
        oid: this.current, type: "commit" };
  }
  async commit(name: string, oid: string): Promise<CasCommit> {
    this.calls.push("commit");
    const found = this.commits.get(oid);
    if (!found) throw Error("DO_NOT_LOG missing commit");
    return { ...found, parentOids: [...found.parentOids] };
  }
  async cas(repositoryNodeId: string, before: string, after: string): Promise<void> {
    this.calls.push("cas");
    this.casCalls.push({ repositoryNodeId, before, after });
    if (this.lostBefore) throw Error("DO_NOT_LOG CAS denied / response lost");
    if (this.current !== before) throw Error("DO_NOT_LOG CAS conflict");
    this.current = after === GITHUB_CAS_ZERO_OID ? null : after;
    if (this.lostAfter) throw Error("DO_NOT_LOG CAS committed but reply missing");
  }
}
interface Rig {
  backend: Fake;
  audits: RecoveryAuditRecord[];
  context: RecoveryContext;
  inspection: AbandonedLockInspection;
  dossier: RecoveryDossier;
}
function dossier(): RecoveryDossier {
  return {
    repository: fullName, repositoryId: repo.id,
    repositoryNodeId: repoNode, observedOwnerOid: aOid,
    observedRunId: "operator-lost-run", operatorLogin: "operator",
    reason: "crashed_owner", incidentUrl: gh,
    stopProof: {
      processTerminated: true, otherWorkersStopped: true,
      allNetworkRequestsTerminal: true, evidenceUrl: stopUrl,
      verifiedAt: "2026-11-16T19:10:00.000Z",
    },
    resourceReview: {
      disposition: "all_operations_reconciled",
      unresolvedOperations: 0, evidenceUrl: resourceUrl,
      verifiedAt: "2026-11-16T19:11:00.000Z",
    },
    humanApproval: {
      explicitlyApproved: true, approverLogin: "human-reviewer",
      approvedRepository: fullName, approvedOwnerOid: aOid,
      approvalUrl, approvedAt: "2026-11-16T19:12:00.000Z",
    },
  };
}
async function setup(): Promise<Rig> {
  const backend = new Fake();
  const audits: RecoveryAuditRecord[] = [];
  const context: RecoveryContext = {
    backend, recordAudit: async (record) => {
      audits.push(JSON.parse(JSON.stringify(record)) as RecoveryAuditRecord);
    },
  };
  const inspection = await inspectAbandonedGithubLock(fullName, context);
  return { backend, context, audits, inspection, dossier: dossier() };
}

const noLock = new Fake();
noLock.current = null;
await denies("crash before lock acquisition: nothing to recover", () =>
  inspectAbandonedGithubLock(fullName, { backend: noLock,
    recordAudit: async () => {} }), "NO_LOCK", "inspect");
equal(noLock.casCalls.length, 0, "Missing lock cannot trigger delete.");

const baseline = await setup();
equal(baseline.inspection, {
  repository: fullName, repositoryId: 101, repositoryNodeId: repoNode,
  lockRef: GITHUB_CAS_LOCK_REF, ownerOid: aOid,
  ownerRunId: "operator-lost-run", ownerNonce: UUID, baseOid,
}, "Inspection is exact, typed, and bound to owner commit.");
equal(baseline.backend.casCalls.length, 0, "Inspection is strictly read-only.");
const released = await recoverAbandonedGithubLock(
  baseline.inspection, baseline.dossier, baseline.context);
equal(released.status, "released", "Approved exact-owner CAS delete succeeds.");
equal(released.repository, fullName, "Recovery cannot change target repository.");
equal(baseline.backend.current, null, "Lock ref absent after exact CAS deletion.");
equal(baseline.backend.casCalls, [{
  repositoryNodeId: repoNode, before: aOid, after: GITHUB_CAS_ZERO_OID,
}], "Only a single exact-owner non-force CAS delete is issued.");
equal(baseline.audits.map((x) => x.event),
  ["authorized_attempt", "confirmed_release"],
  "Audit intent persisted before CAS, success recorded after readback.");
assert(baseline.backend.calls.indexOf("cas") > baseline.backend.calls.indexOf("lockRef"),
  "Recovery requires fresh ownership checks before any write.");
assert(baseline.audits.every((x) =>
  x.approvalUrl === approvalUrl && x.ownerOid === aOid &&
  x.operatorLogin === "operator" && x.approverLogin === "human-reviewer"),
  "Every audit event binds immutable target, approval, actors and exact OID.");
await denies("recovery cannot rerun after first delete", () =>
  recoverAbandonedGithubLock(baseline.inspection, baseline.dossier,
    baseline.context), "NO_LOCK");
equal(baseline.backend.casCalls.length, 1, "No speculative repeat deletion.");

async function refuse(name: string, edit: (rig: Rig) => void,
  expected: GithubRecoveryError["code"], phase?: GithubRecoveryError["phase"]) {
  const rig = await setup();
  edit(rig);
  await denies(name, () => recoverAbandonedGithubLock(
    rig.inspection, rig.dossier, rig.context), expected, phase);
  equal(rig.backend.casCalls.length, 0, name + ": zero mutations.");
}
await refuse("idle-but-alive owner", (r) => {
  (r.dossier.stopProof as unknown as { processTerminated: boolean }).processTerminated = false;
}, "PROOF_UNCERTAIN", "authorize");
await refuse("other cooperating worker still alive", (r) => {
  (r.dossier.stopProof as unknown as { otherWorkersStopped: boolean }).otherWorkersStopped = false;
}, "PROOF_UNCERTAIN");
await refuse("in-flight REST call possibly unfinished", (r) => {
  (r.dossier.stopProof as unknown as { allNetworkRequestsTerminal: boolean }).allNetworkRequestsTerminal = false;
}, "PROOF_UNCERTAIN");
await refuse("outstanding resource operations", (r) => {
  (r.dossier.resourceReview as unknown as { unresolvedOperations: number }).unresolvedOperations = 1;
}, "PROOF_UNCERTAIN");
await refuse("outstanding readback unverified", (r) => {
  (r.dossier.resourceReview as unknown as { disposition: string }).disposition = "unknown";
}, "PROOF_UNCERTAIN");
await refuse("no actual approval", (r) => {
  (r.dossier.humanApproval as unknown as { explicitlyApproved: boolean }).explicitlyApproved = false;
}, "UNAUTHORIZED_RECOVERY");
await refuse("approval tied to another OID", (r) => {
  r.dossier.humanApproval.approvedOwnerOid = bOid;
}, "UNAUTHORIZED_RECOVERY");
await refuse("approval tied to another repo", (r) => {
  r.dossier.humanApproval.approvedRepository = "another/repo";
}, "UNAUTHORIZED_RECOVERY");
await refuse("approval precedes independent proof", (r) => {
  r.dossier.humanApproval.approvedAt = "2026-11-16T19:00:00.000Z";
}, "PROOF_UNCERTAIN");
await refuse("wrong OID dossier", (r) => {
  r.dossier.observedOwnerOid = bOid;
}, "OWNER_MISMATCH");
await refuse("wrong node ID in dossier", (r) => {
  r.dossier.repositoryNodeId = "R_other";
}, "OWNER_MISMATCH");
await refuse("wrong owner run ID in dossier", (r) => {
  r.dossier.observedRunId = "someone-else";
}, "OWNER_MISMATCH");
await refuse("no audit incident link", (r) => {
  r.dossier.incidentUrl = "";
}, "UNSAFE_EVIDENCE");
await refuse("URL cannot contain credentials or query", (r) => {
  r.dossier.stopProof.evidenceUrl = gh + "?token=DO_NOT_LOG";
}, "PROOF_UNCERTAIN");
await refuse("non-durable audit link", (r) => {
  r.dossier.humanApproval.approvalUrl = "https://github.com/";
}, "UNAUTHORIZED_RECOVERY");
await refuse("old timestamps cannot replace human permission", (r) => {
  r.dossier.humanApproval.approvedAt = "2000-01-01T00:00:00.000Z";
}, "PROOF_UNCERTAIN");
await refuse("wrong repo during readback", (r) => { r.backend.changedRepo = true; },
  "WRONG_REPOSITORY");
await refuse("wrong lock-ref name", (r) => { r.backend.wrongRef = true; },
  "WRONG_REF");
await refuse("stale owner OID replaced by foreign owner", (r) => {
  r.backend.current = bOid;
}, "OWNER_MISMATCH");
await refuse("owner commit metadata altered", (r) => {
  r.backend.commits.get(aOid)!.message = "foreign owner";
}, "UNRECOGNIZED_OWNER");
await refuse("owner base tree tampered", (r) => {
  r.backend.commits.get(aOid)!.treeOid = bOid;
}, "UNRECOGNIZED_OWNER");
await refuse("owner parent missing", (r) => {
  r.backend.commits.get(aOid)!.parentOids = [];
}, "UNRECOGNIZED_OWNER");
await refuse("GitHub read permission denied", (r) => { r.backend.denied = true; },
  "READ_FAILED");
await refuse("invalid proposed repository", (r) => {
  r.inspection = { ...r.inspection, repository: "a/b/other" };
}, "INVALID_TARGET");
await refuse("cancelled before validation", (r) => {
  const controller = new AbortController();
  controller.abort();
  r.context.signal = controller.signal;
}, "ABORTED");

const changedAtCas = await setup();
// Initial (inspection) GET took one ref read; recovery does two more reads.
changedAtCas.backend.mutateOnRead = changedAtCas.backend.readCount + 2;
await denies("ref swapped immediately before CAS", () =>
  recoverAbandonedGithubLock(changedAtCas.inspection,
    changedAtCas.dossier, changedAtCas.context), "OWNER_MISMATCH", "attempt");
equal(changedAtCas.backend.casCalls.length, 0,
  "Detected ref replacement before CAS must not issue a write.");

const changedDuringCas = await setup();
changedDuringCas.backend.cas = async (node, before, after) => {
  changedDuringCas.backend.casCalls.push({
    repositoryNodeId: node, before, after,
  });
  changedDuringCas.backend.current = bOid;
  throw Error("DO_NOT_LOG CAS compare-and-swap rejected: moved ref");
};
await denies("ref changes after final preflight, CAS rejects", () =>
  recoverAbandonedGithubLock(changedDuringCas.inspection,
    changedDuringCas.dossier, changedDuringCas.context), "CAS_UNCERTAIN", "verify");
equal(changedDuringCas.backend.current, bOid, "New owner remains safe on CAS refusal.");
equal(changedDuringCas.backend.casCalls.length, 1, "No CAS retry under contention.");
equal(changedDuringCas.audits.map((x) => x.event), ["authorized_attempt"],
  "Contested CAS cannot produce a confirmed-release audit record.");

const noReplyBefore = await setup();
noReplyBefore.backend.lostBefore = true;
await denies("network fails before conditional deletion", () =>
  recoverAbandonedGithubLock(noReplyBefore.inspection, noReplyBefore.dossier,
    noReplyBefore.context), "CAS_UNCERTAIN");
equal(noReplyBefore.backend.current, aOid, "Old lock retained after failed attempt.");
equal(noReplyBefore.backend.casCalls.length, 1, "Never retry uncertain CAS request.");
const noReplyAfter = await setup();
noReplyAfter.backend.lostAfter = true;
await denies("network fails after CAS committed", () =>
  recoverAbandonedGithubLock(noReplyAfter.inspection, noReplyAfter.dossier,
    noReplyAfter.context), "CAS_UNCERTAIN");
equal(noReplyAfter.backend.current, null, "Ref may be gone even though caller must stop.");
equal(noReplyAfter.backend.casCalls.length, 1, "No blind replay even on ref absence.");
const unreadableAfter = await setup();
unreadableAfter.backend.noReadAfter = true;
await denies("verification transport fails after successful CAS", () =>
  recoverAbandonedGithubLock(unreadableAfter.inspection, unreadableAfter.dossier,
    unreadableAfter.context), "RESULT_UNCERTAIN");
equal(unreadableAfter.backend.current, null, "Unknown readback may follow deletion.");
const hiddenRepositoryAfter = await setup();
hiddenRepositoryAfter.backend.repoDeniedAfter = true;
await denies("ref 404 without canonical repository access cannot prove release", () =>
  recoverAbandonedGithubLock(hiddenRepositoryAfter.inspection,
    hiddenRepositoryAfter.dossier, hiddenRepositoryAfter.context), "RESULT_UNCERTAIN");
equal(hiddenRepositoryAfter.backend.current, null,
  "Failed post-CAS repo identity check retains uncertain outcome, not a retry.");
equal(hiddenRepositoryAfter.backend.casCalls.length, 1,
  "Hidden/denied repository access cannot trigger a second CAS.");

const refusedAudit = await setup();
refusedAudit.context.recordAudit = async () => { throw Error("DO_NOT_LOG audit storage down"); };
await denies("audit must persist before ref deletion", () =>
  recoverAbandonedGithubLock(refusedAudit.inspection, refusedAudit.dossier,
    refusedAudit.context), "AUDIT_FAILED", "attempt");
equal(refusedAudit.backend.casCalls.length, 0,
  "No audit durability => no CAS deletion.");
const failedAfterAudit = await setup();
failedAfterAudit.context.recordAudit = async (entry) => {
  failedAfterAudit.audits.push(entry as RecoveryAuditRecord);
  if (entry.event === "confirmed_release") throw Error("DO_NOT_LOG");
};
await denies("post-release audit failure is uncertain", () =>
  recoverAbandonedGithubLock(failedAfterAudit.inspection,
    failedAfterAudit.dossier, failedAfterAudit.context), "RESULT_UNCERTAIN");
equal(failedAfterAudit.backend.current, null,
  "Audit failure after deletion does not restore or silently retry.");
equal(failedAfterAudit.backend.casCalls.length, 1,
  "No second deletion attempt to address audit failure.");

const absent = await setup();
absent.backend.current = null;
await denies("owner crashed before acquiring ref", () =>
  recoverAbandonedGithubLock(absent.inspection, absent.dossier, absent.context),
  "NO_LOCK");
equal(absent.backend.casCalls.length, 0, "Never delete nonexistent ref.");

console.log("A1 #176 manual recovery: evidence and explicit approval gate, live owner readback, exact CAS, audit and fail-closed tests passed.");
