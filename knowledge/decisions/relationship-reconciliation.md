---
type: Decision
title: "Relationship reconciliation policy"
description: "Reconcile managed native edges by default while allowing additive-only updates and respecting reference boundaries."
tags: ["relationships", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:13:51.663+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/relationship-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/12
  - resource: https://github.com/attention-spa/gh-plan/issues/22
---

## Summary

Native parent, blocked-by and related-to edges are part of the declared [desired-state graph](/concepts/desired-state-graph.md). They may need to be added or removed without mutating unrelated resources.

## Decision

Use `relationshipMode: reconcile` as the default for managed issue relationship sets. `relationshipMode: additive` adds missing declared edges while leaving undeclared observed edges in place. `blocks` is the reverse of `blocked_by`; `relates_to` is symmetric, and its endpoint order does not confer ownership.

## Rationale and consequences

Reconciliation supports Git-authoritative relationships, while additive mode offers a safer migration path for partially managed repositories. Parent conflicts, invalid endpoints and reference-only boundaries must block unsafe changes. Removing a *relationship edge* is not permission to delete an issue. See [relationships](/concepts/relationships.md) and [issue deletion policy](/decisions/issue-deletion-policy.md).
