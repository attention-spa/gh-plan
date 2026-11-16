---
type: API
title: "compileIssueSteps"
description: "Compiles managed issue create, core updates and issue-type requests."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-compiler.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Compiles managed issue create, core updates and issue-type requests. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
compileIssueSteps(desired: NormalizedDesiredStateGraph, result: GithubDiffResult, observed: GithubStateSnapshot, resolutions: ResourceResolution[]) => IssueCompilationResult
```

Created issue bodies include canonical markers; milestone references can be late-bound.

## I/O and failure behavior

Pure. Unsafe references and unresolved identities block; no requests are executed.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
