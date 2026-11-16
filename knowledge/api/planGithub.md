---
type: API
title: "planGithub"
description: "Plans a repository from a typed schema without executing mutations."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Plans a repository from a typed schema without executing mutations. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
planGithub(config: GithubPlannerConfig) => Promise<GithubPlan>
```

Returned steps form a topologically ordered DAG. Callers must reject `readiness: blocked` before executing any requests.

## I/O and failure behavior

Read-only REST GETs for discovery; transport failures and schema problems produce blocking diagnostics, not executed writes.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
