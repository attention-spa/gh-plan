---
type: Concept
title: "Plans and Steps"
description: "Deterministic read-only reconciliation proposals with dependency-ordered REST requests."
tags: ["planning", "dag"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T09:00:00+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/execute-steps.ts
---

## Summary

`planGithub()` performs normalization, read-only discovery and enrichment, identity resolution, semantic diffing and compilation. It returns a serializable `GithubPlan`; it **never executes** its proposed GitHub mutations.

## Plan structure

A plan includes repository identity, metadata, resource resolutions, topologically ordered `steps`, `noops`, warnings, blockers, unsupported diagnostics, counts and `readiness`.

- `ready` has no blockers.
- `ready_with_warnings` has nonblocking warnings.
- `blocked` must not be executed, even if it contains candidate steps.

Each `PlanStep` has a full operation `id`, a `kind`, a logical resource ID, a status, a reason, optional request, conditions and `dependsOn` **step IDs** (e.g. `issue.create:A`). `reversible: "partial"` indicates that rollback cannot fully restore the former state, notably after creates.

## PR plans

[Pull requests](/schema/pull-request.md) are separate managed resources with `pull_request.create`, `pull_request.update` and reviewer-request steps. Existing M4 issue-label and assignee steps can operate on a PR number but depend on `pull_request.create` when necessary. The normal REST update cannot toggle an existing PR's draft flag; no merge step is ever proposed. `Closes #` references to new issues use a string template with explicit producing `issue.create` dependencies.

## Projects v2 item plans

References to [existing Projects v2 boards](/schema/projects-v2.md) can add issue/PR membership and set supplied custom fields. Missing boards, fields, selections or unsupported field types block. A new item produces a `project.item.add` request, then `project.item.fields.set` depends on its new numeric item ID; newly created issues and PRs are prerequisite producers. No board/field creation or membership removal is planned.

## Orphan and duplicate steps

The default [prune policy](/schema/prune-duplicates.md) reports orphaned canonical issue-body markers and duplicate marker/title collisions as information. Explicit `prune:"close"` permits non-destructive, reversible `issue.orphan.close`, or `issue.duplicate.comment` followed by `issue.duplicate.close` against an explicitly identified canonical issue. REST-mode deletion requests block. The `issue.duplicate.delete` proposal is irreversible and available only through explicit `prune:"close", deleteDuplicates:true` with `planGithub({mode:"graphql"})`. Other GraphQL-mode plans block. The planner still issues only REST GETs during discovery and never executes any proposed mutation.

## Execution boundary

The package entrypoint remains read-only. The internal (not exported) `executePlanSteps(plan, dispatch, readPostcondition)` staging primitive checks the entire DAG for blocked/incomplete steps, duplicate IDs, missing dependencies, cycles and invalid future references **before any dispatch**. It then evaluates each step sequentially in dependency order, late-binding any produced identities using `bindPlanRequest()`.

M8.1.2 requires an explicitly injected **fresh, authoritative postcondition reader** before **every** planned mutation. It receives the step, bound request and current identities and must independently read GitHub's latest state (not reuse the planner snapshot), confirming **all** of that step's postconditions. A `satisfied` result skips the write; `unsatisfied` dispatches it. Missing, ambiguous or failed reads stop execution. Skipped create steps must return observed, validated identities or execution fails closed; satisfied steps are retained in `completedStepIds` and listed separately in `skippedStepIds`. The postcondition strings in `PlanStep` are *descriptive*, not machine-executable; this stage **does not implement a GitHub-backed reader**.

M8.1.3 adds a second, authoritative **complete issue-catalog** read before every `issue.create`, using the canonical/custom identity marker embedded in the outgoing issue body. The internal `createRestIssueCatalogReader()` uses the existing GitHub GET client, fetches all open and closed issue pages and excludes PRs. If exactly one marked issue exists **and** the postcondition reader reports satisfied with matching identity, the create is skipped and the observed IDs bind downstream requests. Duplicate markers, marker/postcondition disagreement, invalid identities and failed catalog reads stop execution, never trigger another create. The marker's absence permits the create only after both fresh reads. A lost create response can therefore be recovered on the next invocation without another POST, provided GitHub's listing has converged.

M8.1.4 requires a **second, independent postcondition read after every dispatched mutation** and before the next planned step. Create-response identities must agree with verified identities; issue creates also reread the complete marker catalog after writing. An unsatisfied or inconclusive verification result, exception, invalid identity or log-sink failure halts immediately. `PlanExecutionError` contains only a safe step ordinal, allowlisted failure phase, stable code and partial execution log, never transport exception text or credentials.

The internal executor now returns a `log` of `{stepIndex, outcome, phase}` entries, including skipped steps. A fifth optional `onLog` callback can persist each sanitized entry sequentially; a failing callback stops execution. The index identifies the step in dependency order; no potentially sensitive user-supplied IDs or request payloads are logged. See [the no-secrets decision](/decisions/no-secrets-in-plans.md).

This remains staging, **not** a safe public `applyPlan()`: recovery checks are not a cross-process transaction lock, a concrete GitHub-specific postcondition reader is not supplied, and final M8.1.5 integration fixtures are pending. Do not use it against a live repository until the remaining M8.1 gates are implemented. Deterministic output and [secret-free plans](/decisions/no-secrets-in-plans.md) make review possible before writing.
