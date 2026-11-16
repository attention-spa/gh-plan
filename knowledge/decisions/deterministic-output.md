---
type: Decision
title: "Deterministic plan output"
description: "Emit sorted semantic diffs and topologically ordered steps so identical inputs produce equivalent plans."
tags: ["planning", "reproducibility"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:13:51.663+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/diff.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/17
  - resource: https://github.com/attention-spa/gh-plan/issues/23
---

## Summary

A plan is a reviewable, serializable description of intended GitHub mutations. Given the same [desired graph](/concepts/desired-state-graph.md), observed snapshot, and resolution inputs, the planner should emit equivalent results irrespective of API completion order.

## Decision

Normalize resource order, canonicalize symmetric edges, sort diagnostics and noops, and generate stable step identifiers and dependency order. REST enrichment is bounded and restores input order after parallel requests. All planned references are expressed through explicit [late-bound IDs](/concepts/late-binding-refs.md) rather than guessed numbers.

## Rationale and consequences

Stable output enables reproducible tests, safe review, meaningful diffs and interruption recovery. It does not mean actual GitHub state is frozen between planning and execution; an executor would need its own revalidation. See [plans and steps](/concepts/plan-and-steps.md).
