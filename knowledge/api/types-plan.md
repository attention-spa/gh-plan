---
type: API
title: "Plan and request types"
description: "GithubPlan and PlanStep request DAG, readiness, identity refs and execution boundary."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:09:43.760+01:00 }
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

The `issue.orphan.close` and `issue.duplicate.close` steps are reversible, non-destructive REST proposals. `issue.duplicate.comment` records a canonical link and justification before a close. The opt-in `issue.duplicate.delete` is an irreversible **GraphQL** proposal: REST blocks it, and `planGithub()` emits it only when GraphQL mode and both explicit policy opt-ins are selected. Discovery remains GET-only, and there is no executor.

## Contract boundary

Projects v2 membership and fields use `project.item.add` and `project.item.fields.set`. A new project's item REST ID is late-bound from its producing add step, and new issue/PR content must be created before membership.

The planner produces only inert requests. An executor must reject `blocked` readiness, honor full step dependencies and provide values for PlanValueRef.

The approved but **not exported** [C2 callback apply contract](/decisions/caller-injected-apply-contract.md) will add a public opt-in executor requiring caller-supplied dispatch, verification, catalogs and ownership. Type correctness cannot establish that a callback read GitHub. The B1 four-kind fail-closed preflight and A1 reference GitHub adapter remain independent implementation requirements; no current public apply export or GitHub write transport exists.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
