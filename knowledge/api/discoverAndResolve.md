---
type: API
title: "discoverAndResolve"
description: "Discovers broad repository state and enriches only relevant existing issues."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/discovery.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:59:23.581+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/discovery.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Discovers broad repository state and enriches only relevant existing issues. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
discoverAndResolve(desired: NormalizedDesiredStateGraph, transport: GithubDiscoveryTransport, options?: IdentityResolutionOptions) => Promise<DiscoveryResolutionResult>
```

PR candidates come from the existing `/issues` listing, with relevant head/base filtering and only matching `/pulls/{number}` enrichment. New PRs receive read-only Git reference and commit-comparison checks. Unrelated PRs are not fetched individually.

Relationship-only endpoints may be enriched; each distinct addition login triggers eligibility GET.

## I/O and failure behavior

Read-only I/O through transport; propagates transport errors. Volume depends on selected issues and added assignees.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
