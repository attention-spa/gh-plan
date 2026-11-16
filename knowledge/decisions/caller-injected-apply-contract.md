---
type: Decision
title: "Caller-injected public apply contract"
description: "Expose a callback-based applyPlan in the private package, with explicit caller trust and independently gated GitHub-safe adapters."
tags: ["github", "apply", "api", "audit", "security"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T12:15:00+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/issues/166
  - resource: https://github.com/attention-spa/gh-plan/issues/163
  - resource: https://github.com/attention-spa/gh-plan/issues/164
  - resource: https://github.com/attention-spa/gh-plan/issues/165
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/execute-steps.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/docs/public-contract.md
  - resource: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
---

## Summary

**Architecture decision C2, explicitly selected by the owner for [#166](https://github.com/attention-spa/gh-plan/issues/166):** the first optional public `applyPlan()` in the existing **private** `@attention-spa/gh-plan` package will be a **dependency-injected callback executor**, not a built-in authenticated GitHub REST writer. Its caller supplies `dispatch`, `readPostcondition`, create-catalog readers and cooperative ownership callbacks; all GitHub credentials, transport policy and actual GitHub state verification remain the caller's responsibility. `planGithub()` stays read-only and the module does nothing on import.

**Important limitation:** no package-side check can prove that a caller's callbacks actually read GitHub, use an A1 CAS lock, obey rate limits or report honest postconditions. The callback facade must never be marketed as a safe built-in authenticated `applyPlan()`, verified reconciliation or a global exactly-once writer. Merely injecting a reader claiming `satisfied` is **not evidence** of live GitHub state. C1 (trusted built-in transport) and C3 (separate CLI/package) were not selected.

## Proposed public TypeScript contract (decision, not yet exported)

```ts
export interface ApplyPlanOptions {
  plan: GithubPlan;
  dispatch: PlanStepDispatcher; // caller-trusted, from internal core
  readPostcondition: PlanStepPostconditionReader; // caller-trusted
  readIssueCatalog?: PlanIssueCatalogReader; // required by issue.create
  readMilestoneCatalog?: PlanMilestoneCatalogReader; // required by milestone.create
  ownership: ApplyOwnershipAdapter; // caller-trusted; no bypass option in v1
  acknowledgeCallbackTrust: true; // explicit opt-in, checked at runtime
  signal?: AbortSignal;
  onLog?: (entry: Readonly<SafeApplyLogEntry>) => void | Promise<void>;
}
export interface ApplyOwnershipAdapter {
  acquire(repositoryFullName: string): Promise<{ ownerId: string }>;
  assertOwned(repositoryFullName: string, ownerId: string): Promise<boolean>;
  release(repositoryFullName: string, ownerId: string): Promise<void>;
}
export interface SafeApplyLogEntry {
  runId: string; // opaque per-call identifier
  sequence: number; // strictly increasing; idempotent sink key with runId
  stepIndex?: number; // ordinal only; no user-provided text
  phase: "preflight" | "ownership" | "precondition" | "dispatch" |
         "verification" | "audit" | "release";
  outcome: "started" | "applied" | "skipped" | "failed";
}
export interface ApplyPlanResult {
  status: "applied" | "already_satisfied";
  runId: string;
  completedStepIds: string[];
  skippedStepIds: string[];
  bindings: PlanBindings;
  log: SafeApplyLogEntry[]; // safe acknowledged entries
}
export type ApplyPlanErrorCode =
  | "INVALID_PLAN" | "UNSUPPORTED_PLAN" | "CALLBACK_INVALID"
  | "OWNER_CONFLICT" | "OWNER_LOST" | "OWNER_UNCERTAIN"
  | "UNVERIFIED_STATE" | "INDETERMINATE_WRITE" | "VERIFICATION_FAILED"
  | "AUDIT_FAILED" | "ABORTED" | "DISPATCH_FAILED" | "RELEASE_FAILED";
export class ApplyPlanError extends Error {
  readonly code: ApplyPlanErrorCode;
  readonly phase: SafeApplyLogEntry["phase"];
  readonly stepIndex?: number;
  readonly runId?: string;
  readonly ownerState: "not_acquired" | "released" | "retained" | "unknown";
  readonly log: readonly SafeApplyLogEntry[];
  readonly completedStepIds: readonly string[];
  readonly skippedStepIds: readonly string[];
}
export declare function applyPlan(options: ApplyPlanOptions): Promise<ApplyPlanResult>;
```

The example above is the **original architecture sketch**, not a canonical current declaration. [#187](https://github.com/attention-spa/gh-plan/issues/187) now implements named **public types** and a sanitized public `ApplyPlanError` class in `src/index.ts`, with actual signatures defined in [`src/apply-contract.ts`](https://github.com/attention-spa/gh-plan/blob/main/src/apply-contract.ts). [#188](https://github.com/attention-spa/gh-plan/issues/188) will add callback lifecycle semantics and [#190](https://github.com/attention-spa/gh-plan/issues/190) alone may export the executable `applyPlan()`. This staged contract does **not** export that function. Any callback-related public types must be exported by name; there is no `auth`, `fetch`, `apiBaseUrl` or bundled GitHub writer in the C2 public options. The reference adapter under [#189](https://github.com/attention-spa/gh-plan/issues/189) may accept runtime-only credentials independently. Do not expose secret-bearing callback errors in `cause`, diagnostics or JSON serialization.

## #187 implementation checkpoint — named types and fail-closed preflight

[PR #197](https://github.com/attention-spa/gh-plan/pull/197) stages the named C2 callback types and a sanitized, JSON-safe `ApplyPlanError` class in the private package's existing single entrypoint. The exact signature is in [`src/apply-contract.ts`](https://github.com/attention-spa/gh-plan/blob/main/src/apply-contract.ts). Public types include `ApplyPlanOptions`, `ApplyPlanResult`, `ApplyOwnershipAdapter`, `ApplyDispatcher`, `ApplyPostconditionReader`, typed B1 postcondition context/observation, open+closed issue and milestone catalog readers, safe audit log types, error codes and owner state. The one required opt-in is `acknowledgeCallbackTrust: true`; no public `auth`, `fetch`, base URL or lock bypass is permitted.

The internal `prepareApplyPlan(input)` gateway **clones and deep-freezes** the complete plan and its version-1 typed B1 descriptors, runs the existing [#178](https://github.com/attention-spa/gh-plan/issues/178) whole-plan strict four-kind preflight **before accessing callback fields**, validates callable dispatch/read/catalog/ownership/audit inputs, requires relevant catalog callbacks for issue/milestone creates, and refuses aborts before any side effect. Unsupported operation kinds, silently unrepresented intent, blocked plans, stale noops, duplicate/foreign identities, wrong repo/method/path/body and broken DAG/late references cause a sanitized error with **zero callbacks or lock attempts**. An unsupported last step rejects the entire plan atomically even when prior steps are valid. A separate compile-time/dist fixture proves the named types exist, while the actual executable `applyPlan()` remains absent.

**Explicit trust limitation:** this stage cannot prove any callback performs a real GitHub GET, holds A1 ownership, respects rate limits or reports actual postconditions. Nor does it make GitHub issue writes atomic or globally exactly-once. Only [#188](https://github.com/attention-spa/gh-plan/issues/188) may implement the ordered callback/owner lifecycle, [#189](https://github.com/attention-spa/gh-plan/issues/189) the separately tested trusted GitHub reference adapter, [#181](https://github.com/attention-spa/gh-plan/issues/181) live four-kind proof, and [#190](https://github.com/attention-spa/gh-plan/issues/190) the public function export. No GitHub resource mutation, lock call, API credential or package publication occurs in #187.

## Invariants and trust boundary

1. **Static fail-closed B1 preflight remains mandatory**, before *any* callback, credential lookup, lock/Git operation or resource write. Validate plan version/readiness, repository, every planned operation, request shape, managed intent and noops (including static noop consistency), late-bound references, DAG, identity selectors and targets. Only the four B1 exact candidate kinds are eligible; all other 29 kinds, unsupported properties, destructive requests and mixed-repository plans reject atomically. A stale noop requires authoritative confirmation or replan *under ownership* using the trusted callbacks; no original planning snapshot counts.
2. **Required caller-provided ownership:** call `ownership.acquire` before any resource write; require `assertOwned` before each dispatch and check release under known terminal conditions. For *actual* GitHub execution, the adapter must implement [A1 repository-wide CAS](/decisions/github-native-apply-ownership.md) using `refs/heads/gh-plan/locks/repository`, with exact-ref readbacks, serial resource writes, no auto-steal, and manual recovery. But injected `ownership` callbacks are **not independently trustworthy**; the facade promises only to call/check them in the defined order.
3. **Required caller-provided authoritative readers:** `readPostcondition` must inspect GitHub, compare the full versioned B1 predicate and reject uncertain reads; issue-create requires full open/closed issue catalog excluding PRs, milestone-create requires full open/closed milestone catalog, and all creates must verify fresh identity. The facade can check return types, ordering and verified-reference consistency but **cannot prove callbacks actually performed GitHub GETs**. No acceptance solely on HTTP 2xx or on the planner's human-readable `expectedPostconditions` strings.
4. **Ordering and uncertainty:** serialized dependency-ordered dispatch with validated late bindings. A callback throwing or returning an ambiguous result must not trigger blind POST/PATCH retries. Re-query only via authoritative adapters. If identity cannot be uniquely resolved, stop and flag `INDETERMINATE_WRITE`; no subsequent resource writes. An unverified mutation may remain in flight; it is never safe to assert it was canceled.
5. **Abort and ownership loss:** `signal` is cooperative. Stop before a new dispatch; if a write was already accepted, obtain a terminal authoritative outcome before releasing ownership. Callback loss, unexpected owner changes, ambiguous release and stale-run recovery fail closed. A1 does not fence noncooperating GitHub API writers and does not guarantee global exactly-once.
6. **Safe audit:** invoke and await `onLog` in ordered `(runId, sequence)` events. The sink may deduplicate the key to persist a prefix; absence of `onLog` only provides in-memory logs. A failed sink stops further writes. A log failure after a possible mutation, or an unknown write result, retains ownership when terminality is not proven and returns a sanitized error with acknowledged prefix, never success. No request/response bodies, arbitrary exception messages, auth headers, resource names or URLs in public logs.
7. **Outcome:** return `applied` or `already_satisfied` only after each step's callback-claimed satisfied predicate, acknowledged audit events (if any) and confirmed release. The word "satisfied" is an *adapter assertion*, not an intrinsic GitHub guarantee. Failed release means error, not successful apply. A resumed invocation must acquire a new owner, refresh state and use verified identities; no automatic replay of uncertain writes.

The public facade cannot protect against malicious, buggy or incorrect callbacks; callers own that trust boundary. An implementation may additionally reject structurally malformed callback results, ownership metadata and nonsensical identity bindings, but it cannot make them authoritative.

## GitHub reference adapter and permission/transport policy

A **separate, test-backed reference adapter** is planned under [#189](https://github.com/attention-spa/gh-plan/issues/189). This is not an automatically selected public transport. It will provide (or wire) trusted GitHub-backed `dispatch`, verification readers and A1 ownership, with explicit runtime authentication and a single canonical target repository.

- Require repository **Issues: read/write** for B1 issue/milestone POST/PATCH and verification; **Contents: read/write** for Git commit/ref CAS operations; issue creation with a milestone may additionally require GitHub's documented push access. Preferred credential is an appropriately scoped GitHub App installation token. Validate actual permissions, branch rulesets and GraphQL `updateRefs` behavior only against an approved disposable **private** repository.
- Restrict to `https://api.github.com`, exact allowed methods and paths, safe fully resolved path fragments and no cross-origin redirect or unapproved GraphQL resource mutation. Use the repo's pinned API version `2026-03-10`; any version change requires separate contract testing.
- Follow complete pagination for issue/milestone catalogs (including closed), authoritative GET-by-number, strict REST number versus `id` versus `node_id` identity validation, bounded read retries and fresh before/after reads.
- Serialize resource mutations, pace GitHub mutation requests at least one second apart, obey `Retry-After`, primary and secondary rate limits, and never blindly retry unknown-effect POST/PATCH. After response loss, re-query and continue only on unambiguous full predicate match. A1 owner commit/CAS itself also needs specific uncertain-outcome handling; no external lease/automatic TTL/steal.
- No privilege-sensitive or destructive GraphQL writes, automatic npm publication, production repository mutation or active-token permission changes are approved by this **architecture-only** decision.

The GitHub REST/GraphQL read/write behavior belongs to the **reference adapter**, not to the generic C2 package interface. An arbitrary alternate callback implementation can violate all GitHub-specific policies; the library must never claim to enforce what it cannot inspect.

## Distribution and acceptance plan

- [#187](https://github.com/attention-spa/gh-plan/issues/187) is the public C2 type/preflight work; [#188](https://github.com/attention-spa/gh-plan/issues/188) implements guarded callback ordering, errors and audit; [#189](https://github.com/attention-spa/gh-plan/issues/189) supplies the separately selected GitHub reference adapter; [#190](https://github.com/attention-spa/gh-plan/issues/190) exports the public facade after the disposable live evidence from [#181](https://github.com/attention-spa/gh-plan/issues/181).
- Preserve the existing single `package.json` `exports["."]` for the package; new **named** `applyPlan`, `ApplyPlanError`, `ApplyPlanOptions`, `ApplyPlanResult`, `ApplyPlanErrorCode`, `SafeApplyLogEntry`, ownership and callback types are future additions to `src/index.ts` and generated `dist/index.d.ts`, with distribution import, declaration and `npm pack --dry-run` tests. Package `"private": true` remains unchanged.
- Synthetic tests must prove preflight zero callbacks/writes for a rejected last step, callback failure/malice scenarios, abort, audit failure, lock-loss/unknown state, and zero-write verified rerun. Disposable-repository tests must separately prove real A1/B1 behavior, authorization scope, rate-limit/transport path constraints, create recovery, lost replies, drift, and all four B1 kinds. No tests of a mock callback alone may be called a live GitHub safety proof.

**Status:** accepted architecture; the #187 public types/internal static preflight stage is implemented, but the C2 executable callback lifecycle, GitHub reference adapter and public `applyPlan()` export are **not** implemented. C2 replaces the former *built-in authenticated transport* goal while preserving A1 (for a trustworthy GitHub adapter) and B1 (mandatory structural allowlist). The standalone callback facade is intrinsically less protective than C1. This decision authorizes architecture documents and implementation planning only; follow-up work requires separate authorization.