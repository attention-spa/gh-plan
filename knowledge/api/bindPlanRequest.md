---
type: API
title: "bindPlanRequest"
description: "Substitutes externally obtained post-create identities in inert requests."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:21:42.849+01:00 }
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

An additional `PlanStringTemplate` can contain literal strings and `PlanValueRef` tokens, allowing a PR `Closes #` body to be assembled from post-create issue numbers. Its producer must be an explicit `dependsOn` step; malformed templates raise `PlanBindingError`.

A new Project v2 item uses an `item.id` reference produced by `project.item.add` to bind the subsequent REST PATCH path. The producer is explicitly listed in `dependsOn`, and newly created issue/PR content must also precede membership.

Returns a new object and does not mutate the original PlanRequest or bindings.

## I/O and failure behavior

Pure. Invalid or missing binding values throw PlanBindingError; no HTTP request is sent.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
