---
type: API
title: "Plan and request types"
description: "GithubPlan and PlanStep request DAG, readiness, identity refs and execution boundary."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:21:42.849+01:00 }
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
- `PlanStringTemplate`
- `PlanBindings`
- `GithubPlannerConfig`
- `GithubPlannerMode`
- `PlanGithub`
- `PlanStepStatus`

## Contract boundary

Projects v2 membership and fields use `project.item.add` and `project.item.fields.set`. A new project's item REST ID is late-bound from its producing add step, and new issue/PR content must be created before membership.

The planner produces only inert requests. An executor must reject `blocked` readiness, honor full step dependencies and provide values for PlanValueRef.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
