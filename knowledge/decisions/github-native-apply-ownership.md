---
type: Decision
title: "GitHub-native cooperative apply ownership"
description: "Serialize participating apply workers per target repository using a compare-and-swap Git ref; require manual abandoned-lock recovery."
tags: ["github", "concurrency", "security", "apply"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T10:08:00+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/issues/164
  - resource: https://github.com/attention-spa/gh-plan/issues/163
  - resource: https://docs.github.com/en/graphql/reference/git#updaterefs
  - resource: https://docs.github.com/en/rest/git/refs
  - resource: https://docs.github.com/en/rest/git/commits
---

## Summary

**Architecture decision A1, accepted in [#164](https://github.com/attention-spa/gh-plan/issues/164):** future direct and Actions callers of the optional public `applyPlan()` must cooperate through a GitHub-native, per-target-repository **exclusive ref ownership** protocol. No external lease database, GitHub Actions-only restriction or automatic stale-lock takeover is required for the first version. This is **an approved design, not an implemented lock or public executor**; delivery is tracked separately in [#175](https://github.com/attention-spa/gh-plan/issues/175) and [#176](https://github.com/attention-spa/gh-plan/issues/176), both blocked by the [complete architecture gate](https://github.com/attention-spa/gh-plan/issues/163).

## Decision and scope

- **One lock per target repository**, regardless of logical namespace or which issues are managed. The single canonical branch ref is `refs/heads/gh-plan/locks/repository`. All cooperating writers, including local callers, agents and GitHub Actions, must use it. Resolve canonical repository identity and enforce target-repository equality before accessing the lock.
- **Owner identity is a unique Git commit object OID**, not just a reusable branch head SHA. Before acquisition, construct an off-ref Git commit using the current default-branch tree and parent commit, with no file changes. Its nonsecret message embeds a newly generated random run nonce and opaque owner/run ID. Create the commit object via `POST /repos/{owner}/{repo}/git/commits`; it does not move any branch. The resulting unique 40-hex commit SHA must be checked against the commit message/owner record before use. The exact nonce format and metadata parser are implementation details covered by contract tests.
- **Exclusive acquire:** send a single GraphQL `updateRefs(input:{ repositoryId, refUpdates:[{name:"refs/heads/gh-plan/locks/repository", beforeOid:ZERO, afterOid:OWNER_OID, force:false}] })`, where `ZERO` is exactly 40 zeroes. A successful CAS writes the ref only if no such ref existed. Perform an independent authenticated exact-ref GET and verify the observed commit OID and owner marker before allowing any GitHub resource mutation. If CAS fails, has an unknown transport outcome or the read is ambiguous, **stop**. After a lost CAS response, only an exact owner-identity read can establish acquisition; never blindly retry the mutation.
- **Ownership invariant:** before **each** mutating resource request, independently re-read the full ref (use the exact `GET /git/ref/heads/gh-plan/locks/repository` path and require exact `ref` value, not a prefix-matching list), its type and commit OID. Compare against the acquired owner OID and local execution context. Mismatch, absence, permission failure or unclear result halts execution without dispatching another write. Disallow concurrent mutations **within one owner**; at most one in-flight GitHub resource mutation per owner.
- **Exclusive release:** only after all in-flight operations have terminally resolved and post-write verification/audit is completed, reread exact ownership and GraphQL-CAS `beforeOid:OWNER_OID`, `afterOid:ZERO`, `force:false`. Read back the ref state. Do **not** use unconditional REST ref deletion; never release another owner's lock. If the release response is uncertain or the ref changed, stop and require investigation rather than claiming success.
- **Credentials:** lock needs target-repository Git objects/ref read and write access, typically `Contents:read/write` for fine-grained app tokens. Validate actual GraphQL permission behavior, ref namespace and branch/ruleset restrictions on an isolated disposable repository before enabling. It is distinct from the `Issues` permissions for executing planned work. All auth stays runtime-only; plans/logs never contain it.

## Crash and abandoned-lock recovery

There is **no TTL, heartbeat-based steal, clock-based expiry, automatic ref deletion or unattended reaper** in v1. A crashed owner leaves its ref intact, intentionally making other runs refuse to write. The owner may release the lock normally only if it still controls the exact ref and has no unresolved in-flight mutation. A lost process cannot implicitly authorize a successor.

An operator may authorize a *manual*, fully audited abandoned-lock clearance **only** after independently establishing that the old process is terminated and **all its in-flight GitHub writes** have ended. Read the owner commit/ref and the affected resource state, record proof of stop and the exact OID, request separate human authorization, then CAS-delete the ref with `beforeOid` equal to the observed abandoned owner OID and `afterOid:ZERO`. Abort on changed ownership or uncertain API response. Merely seeing an old timestamp, completed GitHub Actions run or idle runner is **not** sufficient proof. Unlocking neither reruns nor resumes a plan. The next caller must acquire with a fresh owner OID and perform independent plan preflight and postcondition reads.

The audited recovery runbook and disposable-repository tests are separately tracked in [#176](https://github.com/attention-spa/gh-plan/issues/176), after [#175](https://github.com/attention-spa/gh-plan/issues/175) implements the primitive.

## Guarantees, limits and alternatives

- GitHub [`updateRefs`](https://docs.github.com/en/graphql/reference/git#updaterefs) documents atomic updates with `beforeOid`; zero verifies nonexistence, and zero as `afterOid` deletes a ref. This establishes an **atomic cooperative acquisition/release claim**, not a transaction covering GitHub Issues/PR/Projects REST writes. The current live GraphQL schema exposes `updateRefs` and `RefUpdate.beforeOid`, but **no lock mutation or live contention test has been performed**.
- Cooperative exclusion requires **every participating writer** to honor the lock and requires operators not to reclaim it while any old mutation can still complete. GitHub Issues mutations do **not** accept a corresponding lock fencing token. A resource write could be accepted after a last ownership GET if a privileged external actor removes the ref in that interval. Malicious/uncooperative actors, force ref changes, GitHub eventual consistency, process crashes and API failures prevent a **global at-most-once or exactly-once guarantee**. The internal marker-based create recovery and authoritative postconditions remain necessary.
- Do not treat the lock branch as ordinary feature work: auto-delete-merged-branches or bulk cleanup must never delete `refs/heads/gh-plan/locks/repository`. A ref with this name may be subject to organization/repository rulesets; a lock denied by protection policy is a hard blocker, not a reason to bypass branch protections. Never operate on a production repository to validate CAS behavior.
- External linearizable leases (A2) add a storage service and independent fencing complexity without GitHub REST support for fence checks. Actions `concurrency` (A3) only coordinates participating workflow runs, not direct library callers. Marker-only optimistic reads have no atomic exclusivity and are rejected.

## Required implementation evidence

**[#175](https://github.com/attention-spa/gh-plan/issues/175):** synthetic two-writer CAS contention (exactly one winner), commit uniqueness, owner readback, lost acquisition/release replies, checked release, duplicate/foreign/tampered ref, protected or missing ref, 403/409/422 errors, wrong target repository, invalid token scope, cancellation, and loss between pre-read and attempted write. Validate the full acquire/ownership/release lifecycle with a **disposable private repository**, including correct permission requirements and ref naming.

**[#176](https://github.com/attention-spa/gh-plan/issues/176):** manual recovery runbook with auditable proof of old-run termination, active-but-idle and in-flight refusal, CAS-delete only on exact abandoned owner OID, changed-ref rejection, error recovery, and separate explicit human sign-off. Validate successful and contested recovery only on a disposable repository.

Neither leaf authorizes implementation by itself. The broader [#163](https://github.com/attention-spa/gh-plan/issues/163) public-execution gate, including machine-verifiable postcondition coverage and the owner-approved [C2 caller-injected public API](/decisions/caller-injected-apply-contract.md), remains open pending documentation reconciliation. The generic C2 facade **cannot independently verify that arbitrary owner callbacks implement A1**; the reference GitHub adapter must enforce this policy. No new exported `applyPlan()` or runtime writer is added by this decision.
