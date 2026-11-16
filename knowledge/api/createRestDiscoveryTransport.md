---
type: API
title: "createRestDiscoveryTransport"
description: "Builds an authenticated read-only GitHub REST discovery adapter."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/rest.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/rest.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Builds an authenticated read-only GitHub REST discovery adapter. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
createRestDiscoveryTransport(config: RestDiscoveryTransportConfig) => GithubDiscoveryTransport
```

Default enrichment concurrency is four. The returned transport never mutates repository state.

## I/O and failure behavior

Factory is pure; returned discover/enrich methods issue GETs. Invalid concurrency throws RangeError; HTTP/pagination failures throw GithubRestTransportError.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
