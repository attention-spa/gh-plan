---
type: API
title: "compileIssueFieldSteps"
description: "Compiles explicit organization issue-field changes by field/option name."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-field-compiler.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-field-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Compiles explicit organization issue-field changes by field/option name. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
compileIssueFieldSteps(desired: NormalizedDesiredStateGraph, result: GithubDiffResult, observed: GithubStateSnapshot, resolutions: ResourceResolution[]) => IssueFieldCompilationResult
```

Uses targeted field-value POST/DELETE, not broad PUT replacement of unrelated fields.

## I/O and failure behavior

Pure. Unknown field or option names block or are unsupported; no HTTP calls.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
