---
type: API
title: "bindPlanRequest"
description: "Substitutes externally obtained post-create identities in inert requests."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Substitutes externally obtained post-create identities in inert requests. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
bindPlanRequest(request: PlanRequest, bindings: PlanBindings) => BoundPlanRequest
```

Returns a new object and does not mutate the original PlanRequest or bindings.

## I/O and failure behavior

Pure. Invalid or missing binding values throw PlanBindingError; no HTTP request is sent.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
