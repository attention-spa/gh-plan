---
type: API
title: "requestReferences"
description: "Finds distinct future-resource logical IDs referenced in a request."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Finds distinct future-resource logical IDs referenced in a request. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
requestReferences(request: PlanRequest) => string[]
```

Scans REST path/body and GraphQL variables; returns sorted logical IDs.

## I/O and failure behavior

Pure. Invalid reference syntax throws PlanBindingError.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
