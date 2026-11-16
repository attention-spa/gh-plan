---
type: Concept
title: "Relationships"
description: "Directed parent and dependency edges plus symmetric native related-to associations."
tags: ["relationships", "github"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:12:55.558+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/relationship-compiler.ts
---

## Summary

The graph supports four authoring forms for GitHub issue relationships:

- `parent(parent, child)` states the child belongs beneath the parent.
- `blocked_by(issue, blocker)` states that the blocker prevents the issue.
- `blocks(issue, blocked)` is the reverse spelling of `blocked_by`, normalized to the same edge.
- `relates_to(from, to)` is symmetric; endpoint order does not matter.

Inline `children`, `blockedBy`, `blocks` and `relatesTo` are canonicalized with explicit `relationships`. Duplicate symmetric edges are deduplicated; missing endpoints, cycles and invalid parent structures are rejected.

## Reconciliation

The default mode treats managed relationships as desired sets, subject to reference-only boundaries and parent-conflict blockers. `additive` mode adds declarations without removing undeclared existing relations. The [relationship reconciliation decision](/decisions/relationship-reconciliation.md) explains the safety distinction.

Relationship requests remain **proposals**. New endpoint numbers require [late binding](/concepts/late-binding-refs.md) and prerequisite create steps.
