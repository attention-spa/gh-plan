---
type: Concept
title: "Identity Resolution"
description: "Safe matching from logical resources to existing GitHub identities or proposed creates."
tags: ["identity", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:12:55.558+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/identity.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/discovery.ts
---

## Summary

Identity resolution maps each desired logical issue or milestone to `existing`, `new`, `unresolved` or `ambiguous`. It is pure and uses the discovered repository snapshot, not a mutation.

## Precedence

1. **Explicit identity**: supplied REST `id`, node `nodeId` and `number` must all match the same observed resource.
2. **Unique issue marker**: a canonical or custom body marker identifies one issue. Marker conflicts with explicit identity block.
3. **Title fallback**: milestones can use an exact title; an issue-title match requires `adoptByTitle: true`.

Unknown reference-only targets produce blockers instead of creates. Multiple matches or contradictory hints are reported as ambiguity, not silently adopted. Unmatched managed resources can be planned as new.

## Rationale

The precedence prevents accidental modification of unrelated issues that happen to share a title. See [body markers](/decisions/markers-in-body.md) and [title adoption opt-in](/decisions/title-adoption-opt-in.md).
