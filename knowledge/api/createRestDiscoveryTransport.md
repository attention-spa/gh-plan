---
type: API
title: "createRestDiscoveryTransport"
description: "Builds an authenticated read-only GitHub REST discovery adapter."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/rest.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:39:10.683+01:00 }
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

Optional `enrichPullRequests()` performs scoped `/pulls` filtering, detailed PR reads, reviewer snapshots and branch/compare GETs when PRs are requested. It never creates, updates, closes or merges a PR.

The optional `enrichProjects()` method reads only declared existing Projects v2 boards via `GET /projectsV2/{number}`, their fields and repository-scoped items. It never creates projects or fields and never changes membership. Read permission differs between organization and user projects.

Milestone list discovery now maps `due_on` from the existing paginated `GET /milestones?state=all` response, retaining `null` for an absent deadline and validating non-null ISO timestamps. No extra GETs are required for `due_on`; the REST adapter still performs reads only.

Default enrichment concurrency is four. The returned transport never mutates repository state.

## I/O and failure behavior

Factory is pure; returned discover/enrich methods issue GETs. Invalid concurrency throws RangeError; HTTP/pagination failures throw GithubRestTransportError.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
