---
type: API
title: "compileMilestoneSteps"
description: "Compiles managed milestone create and minimal-update requests."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/milestone-compiler.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:39:10.683+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/milestone-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Compiles managed milestone create and minimal-update requests. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
compileMilestoneSteps(desired: NormalizedDesiredStateGraph, result: GithubDiffResult, resolutions: ResourceResolution[]) => MilestoneCompilationResult
```

Only explicitly changed fields enter PATCH; omission does not clear existing metadata. Milestone `due_on` takes a validated `YYYY-MM-DD` UTC calendar date and becomes an ISO timestamp with `T00:00:00Z` on create/update. On an existing milestone `{op:"remove"}` produces `due_on: null` with a partially reversible step; a new milestone with remove omits the field. Already matching UTC calendar dates and already-clear dates emit noops.

## I/O and failure behavior

Pure; no network calls. Reference-only milestones stay untouched; unresolved identities block.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
