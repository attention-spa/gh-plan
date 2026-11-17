---
type: API
title: "applyPlan"
description: "Explicitly opted-in caller-injected C2 application facade, limited to four B1 issue/milestone request shapes."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
tags: [api, github, apply, callback, safety]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-17T05:05:00+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/issues/190
  - resource: https://github.com/attention-spa/gh-plan/issues/181
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/apply-contract.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/apply-lifecycle.ts
---

## Summary

The **optional public** `applyPlan(options: ApplyPlanOptions): Promise<ApplyPlanResult>` from `@attention-spa/gh-plan` executes a validated four-kind B1 plan **only through explicitly supplied, caller-trusted callbacks**. It is **not an authenticated GitHub REST writer** and never contacts GitHub merely because the module is imported. [`planGithub()`](/api/planGithub.md) remains a strictly read-only planner. The private npm package is not published.

## Public API and required inputs

```ts
import { applyPlan, ApplyPlanError } from "@attention-spa/gh-plan";
import type {
  ApplyPlanOptions, ApplyPlanResult, ApplyOwnershipAdapter,
  ApplyDispatcher, ApplyPostconditionReader, ApplyIssueCatalogReader,
  ApplyMilestoneCatalogReader, ApplyLogSink, SafeApplyLogEntry,
} from "@attention-spa/gh-plan";

const result: ApplyPlanResult = await applyPlan({
  plan, // A complete, ready GithubPlan with a recognized B1 applyIntent
  acknowledgeCallbackTrust: true, // mandatory explicit trust decision
  dispatch, // CALLER's actual per-request mutation callback
  readPostcondition, // CALLER's independent before/after typed B1 reader
  readIssueCatalog, // required if any issue.create; all open/closed issues, no PRs
  readMilestoneCatalog, // required if any milestone.create; all open/closed milestones
  ownership, // CALLER's acquire/assertOwned/release cooperation mechanism
  onLog, // optional async, ideally durably persisted before acknowledging
  signal, // optional AbortSignal; an in-flight write may still commit remotely
});
```

The named input variables in the example are supplied by the caller; no built-in `auth`, `fetch`, `baseUrl`, default dispatcher, GitHub token or ownership bypass is accepted. The public entrypoint exports `applyPlan`, `ApplyPlanError`, the listed callback types and sanitized result/error types. It **does not export** `executeCallbackApplyPlan`, `prepareApplyPlan`, raw dispatch, A1 CAS helpers, or the internal GitHub reference adapter factory.

## Invariants, errors and trust boundary

- **Closed B1 capability:** only `milestone.create`, `milestone.update`, `issue.create` and `issue.update`, each with the recognized exact REST request/intent shape. The **whole cloned plan** undergoes pure fail-closed preflight before any callback, lock or write; unsupported last steps, missing dependencies, wrong repositories and malformed fields reject the entire run.
- **Cooperative ownership:** caller-provided `ownership` must hold the intended target and recheck before each resource mutation. There is no TTL, global fencing against uncooperative writers, implicit unlock, or safe automated abandoned-lock recovery. The independent [A1 manual recovery policy](/decisions/github-native-apply-ownership.md) still applies.
- **Authoritative reads:** caller-provided `readPostcondition` must actually verify each versioned B1 predicate before/after mutation. Issue and milestone creates additionally require full, fresh catalog callbacks with unique marker/title and stable number/REST ID/node identity. Dependent requests bind only *verified* producer numbers. Conflicts or uncertain reads stop the graph.
- **No blind mutation retries:** a remotely committed POST/PATCH with a lost reply may have succeeded. The executor never repeats that write; safe continuation requires independent reconciliation. A lock may be retained if a write outcome is uncertain or durable audit fails.
- **Audit, cancellation and errors:** an `onLog` callback receives only `runId`, monotonically increasing `sequence`, ordinal `stepIndex`, phase and outcome. The executor awaits each acknowledgement before another write; supply a durable journal when recovery matters. An `AbortSignal` stops new writes, not necessarily an already in-flight remote operation. Failures throw `ApplyPlanError` with typed `code`, `phase`, `ownerState` and safe partial outcomes, never raw headers, token, body or exception causes.
- **Caller trust is not authentication:** the package **cannot prove** that an arbitrary injected callback reads real GitHub state, honors A1 CAS, uses approved permissions, or reports honest outcomes. A lying callback can falsely claim `satisfied`. Exposing `applyPlan` does **not** turn the facade into a universally safe GitHub reconciler or promise exactly-once mutations.

## Distribution and independent reference verification

[`#181` real private-repository proof](https://github.com/attention-spa/gh-plan/issues/181#issuecomment-6936578455) ran the **internal, separately selected** reference GitHub adapter through the same C2 lifecycle using real pinned GitHub REST `2026-03-10`, verified all four B1 kinds, zero-resource-write replay and conditional A1 CAS release. [Full details](https://github.com/attention-spa/gh-plan/blob/main/docs/live-private-acceptance-181.md). Synthetic public API integration tests exercise drift, unknown POST outcomes, lock loss, audit exceptions, cancellation and permission/read failures, but their callbacks are **not proof** of live GitHub authority.

A built package exposes the named function in `dist/index.js` and C2 types in `dist/index.d.ts`; a single package `exports["."]` map blocks internal module deep imports. `npm pack --dry-run` is tested without publishing. The package retains `"private": true`. Production GitHub mutation and npm publication require separate authorization.
