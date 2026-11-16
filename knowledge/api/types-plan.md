---
type: API
title: "Plan and request types"
description: "GithubPlan and PlanStep request DAG, readiness, identity refs and execution boundary."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

GithubPlan and PlanStep request DAG, readiness, identity refs and execution boundary.

## Public symbols

- `GithubPlan`
- `GithubPlanSummary`
- `GithubPlanReadiness`
- `PlanStep`
- `PlanOperationKind`
- `PlanRequest`
- `RestPlanRequest`
- `PlanPath`
- `PlanValueRef`
- `PlanBindings`
- `GithubPlannerConfig`
- `GithubPlannerMode`
- `PlanGithub`
- `PlanStepStatus`

## Contract boundary

The planner produces only inert requests. An executor must reject `blocked` readiness, honor full step dependencies and provide values for PlanValueRef.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
