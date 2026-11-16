---
type: API
title: "compileRepositoryLabelSteps"
description: "Compiles repository-label creation and partial metadata updates."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/repository-label-compiler.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/repository-label-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Compiles repository-label creation and partial metadata updates. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
compileRepositoryLabelSteps(desired: NormalizedDesiredStateGraph, diff: GithubDiffResult, observed: GithubStateSnapshot) => RepositoryLabelCompilationResult
```

Labels are identified by case-insensitive name. Neither rename nor delete is planned.

## I/O and failure behavior

Pure. Reference-only missing labels block; no network calls or deletions.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
