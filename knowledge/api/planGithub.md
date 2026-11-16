---
type: API
title: "planGithub"
description: "Plans a repository from a typed schema without executing mutations."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:09:43.760+01:00 }
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

For [managed PRs](/schema/pull-request.md), the planner uses read-only branch checks and selected PR enrichment and composes [pure PR steps](/api/compilePullRequestSteps.md) alongside issue/milestone operations. PR merging is not planned.

Existing [Projects v2](/schema/projects-v2.md) memberships are planned after the corresponding issue/PR content, using the pure [Project Item compiler](/api/compileProjectItemSteps.md). Existing board and field catalogs are read-only; project/field creation is never planned.

[Prune policy](/schema/prune-duplicates.md) reports orphaned gh-plan markers and duplicate marker/title clashes by default. Explicit close can plan reversible REST issue closes, with a canonical link/reason comment preceding duplicate closure. `deleteDuplicates:true` is **blocked in REST**; only `planGithub({mode:"graphql"})` with both `prune:"close"` and `deleteDuplicates:true` can emit an inert GraphQL deleteIssue request after REST GET discovery. All other GraphQL-mode requests remain blocked; no executor exists. No issue is actually closed or deleted by the planner.

Returned steps form a topologically ordered DAG. Callers must reject `readiness: blocked` before executing any requests.

## I/O and failure behavior

Read-only REST GETs for discovery; transport failures and schema problems produce blocking diagnostics, not executed writes.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
