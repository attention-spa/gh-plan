---
type: Concept
title: "Plans and Steps"
description: "Deterministic read-only reconciliation proposals with dependency-ordered REST requests."
tags: ["planning", "dag"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:59:23.581+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
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

## Execution boundary

An external executor may later use the proposed HTTP method/path/body and [late-bound references](/concepts/late-binding-refs.md). Such execution is not part of v0.1. Deterministic output and [secret-free plans](/decisions/no-secrets-in-plans.md) make review possible before writing.
