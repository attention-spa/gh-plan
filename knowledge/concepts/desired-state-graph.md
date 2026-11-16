---
type: Concept
title: "Desired State Graph"
description: "The normalized, flattened representation of desired repository resources and relationships."
tags: ["schema", "normalization"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:12:55.558+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
---

## Summary

The desired-state graph is the deterministic result of [normalization](/concepts/logical-id.md) of a `GithubPlanSchema` input. It is the contract passed to discovery, identity resolution and the semantic diff engine. The graph describes intent, not the state of GitHub after any mutation.

## Structure

- `repository` identifies a GitHub owner/repository.
- `resources` holds flattened managed and reference-only issues and milestones.
- `labels` contains optional repository-label declarations, identified by label name.
- `relationships` contains normalized parent, dependency and related-to edges.
- `relationshipMode` is omitted for default reconciliation or set to `additive`.

Nested `children` declarations become flat issue resources plus directed parent edges. Shorthand values become explicit set/remove instructions. **Absence is intentionally different from removal:** the planner must preserve unspecified properties. An invalid schema produces blocking diagnostics instead of a graph.

## Connections

Stable [logical IDs](/concepts/logical-id.md) connect resources and [relationships](/concepts/relationships.md). [Management modes](/concepts/management-modes.md) govern whether matching resources can be modified. [Plan steps](/concepts/plan-and-steps.md) are built only after the graph has been compared against an observed snapshot.
