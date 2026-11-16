---
type: API
title: "compileRelationshipSteps"
description: "Compiles parent, dependency and related-to native GitHub relations."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/relationship-compiler.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/relationship-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Compiles parent, dependency and related-to native GitHub relations. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
compileRelationshipSteps(desired: NormalizedDesiredStateGraph, diff: GithubDiffResult, observed: GithubStateSnapshot, resolutions: ResourceResolution[], transport?: GithubPlannerMode) => RelationshipCompilationResult
```

`blocks` becomes inverse blocked_by; related-to is symmetric; additive mode preserves undeclared existing edges.

## I/O and failure behavior

Pure; conflicts and unsupported modes surface diagnostics. No network I/O.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
