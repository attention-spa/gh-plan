---
type: API
title: "compileIssueAssigneeSteps"
description: "Compiles exact and incremental GitHub issue assignee changes."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-assignee-compiler.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-assignee-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Compiles exact and incremental GitHub issue assignee changes. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
compileIssueAssigneeSteps(desired: NormalizedDesiredStateGraph, diff: GithubDiffResult, observed: GithubStateSnapshot, resolutions: ResourceResolution[]) => IssueAssigneeCompilationResult
```

Exact assignments reconcile as targeted changes; removals require no eligibility lookup.

## I/O and failure behavior

Pure. Ineligible additions yield blockers based on earlier GET discovery.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
