---
type: API
title: "resolveResourceIdentities"
description: "Resolves logical issues and milestones to existing or new GitHub identities."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/identity.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:59:33.118+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/identity.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Resolves logical issues and milestones to existing or new GitHub identities. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
resolveResourceIdentities(desired: NormalizedDesiredStateGraph, observed: GithubStateSnapshot, options?: IdentityResolutionOptions) => IdentityResolutionResult
```

Explicit REST/node/number hints must agree; a unique issue marker outranks title fallback.

When `prune:"close"` is explicit, one canonical issue can resolve within a duplicated-marker group **only when all supplied explicit identity hints select that marked issue**. Otherwise marker multiplicity remains an ambiguity blocker. Issue-title collisions alone never authorize duplicate closure.

## I/O and failure behavior

Pure; unresolved reference or ambiguous hints produce blockers. Title adoption is disabled by default.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
