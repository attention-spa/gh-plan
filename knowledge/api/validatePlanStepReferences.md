---
type: API
title: "validatePlanStepReferences"
description: "Validates that late-bound references depend on a unique planned create producer."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Validates that late-bound references depend on a unique planned create producer. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
validatePlanStepReferences(steps: readonly PlanStep[]) => GithubDiagnostic[]
```

`dependsOn` lists full step IDs such as `issue.create:A`, never bare logical IDs.

## I/O and failure behavior

Pure. Invalid references result in blocking diagnostics, not HTTP calls.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
