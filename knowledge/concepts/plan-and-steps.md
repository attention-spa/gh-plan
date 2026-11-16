---
type: Concept
title: "Plans and Steps"
description: "Deterministic read-only reconciliation proposals with dependency-ordered REST requests."
tags: ["planning", "dag"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:09:43.760+01:00 }
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

## Projects v2 item plans

References to [existing Projects v2 boards](/schema/projects-v2.md) can add issue/PR membership and set supplied custom fields. Missing boards, fields, selections or unsupported field types block. A new item produces a `project.item.add` request, then `project.item.fields.set` depends on its new numeric item ID; newly created issues and PRs are prerequisite producers. No board/field creation or membership removal is planned.

## Orphan and duplicate steps

The default [prune policy](/schema/prune-duplicates.md) reports orphaned canonical issue-body markers and duplicate marker/title collisions as information. Explicit `prune:"close"` permits non-destructive, reversible `issue.orphan.close`, or `issue.duplicate.comment` followed by `issue.duplicate.close` against an explicitly identified canonical issue. REST-mode deletion requests block. The `issue.duplicate.delete` proposal is irreversible and available only through explicit `prune:"close", deleteDuplicates:true` with `planGithub({mode:"graphql"})`. Other GraphQL-mode plans block. The planner still issues only REST GETs during discovery and never executes any proposed mutation.

## Execution boundary

An external executor may later use the proposed HTTP method/path/body and [late-bound references](/concepts/late-binding-refs.md). Such execution is not part of v0.1. Deterministic output and [secret-free plans](/decisions/no-secrets-in-plans.md) make review possible before writing.
