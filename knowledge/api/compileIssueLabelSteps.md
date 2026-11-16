---
type: API
title: "compileIssueLabelSteps"
description: "Compiles issue-label exact sets and targeted add/remove operations."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-label-compiler.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-label-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Compiles issue-label exact sets and targeted add/remove operations. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
compileIssueLabelSteps(desired: NormalizedDesiredStateGraph, diff: GithubDiffResult, observed: GithubStateSnapshot, resolutions: ResourceResolution[]) => IssueLabelCompilationResult
```

A new root managed label creates a dependency before issue label assignment.

## I/O and failure behavior

Pure. Unknown/ambiguous labels block. No HTTP requests are sent.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
