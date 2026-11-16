---
type: Decision
title: "Issue deletion policy"
description: "Default to no issue deletion; permanent duplicate deletion requires an explicit GraphQL-only opt-in and verified identities."
tags: ["deletion", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:09:43.760+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/11
  - resource: https://github.com/attention-spa/gh-plan/issues/23
---

## Summary

A desired-state document is not an implicit list of issues that should exist to the exclusion of all others. Unmentioned GitHub issues must not be deleted simply because they are absent from the schema.

## Decision

The default `prune:"report"` policy **never emits orphan or duplicate mutations**. It scans only exact, standalone canonical gh-plan issue-body markers (never titles alone); mutations additionally require a leading first-line marker, and reports orphaned marker issues as nonblocking informational warnings. `prune:"close"` explicitly permits non-destructive, reversible closure of uniquely marked orphan issues using `state_reason:not_planned`. It may also propose a duplicate's canonical-link comment before a reversible `state_reason:duplicate` close, but only when an explicitly identified managed canonical issue shares the duplicate's marker. Declared identities and ambiguous marker groups remain protected.

Permanent deletion is **not a REST issue operation**. With `deleteDuplicates:true` and `prune:"close"`, the pure [prune compiler](/api/compilePruneSteps.md) can describe an irreversible GraphQL `deleteIssue` only for a demonstrably duplicated issue with a known node ID, after a reason comment on the surviving canonical issue. In REST mode this is a blocking unsupported diagnostic; the top-level planner permits this narrowly scoped, dual-opt-in GraphQL **proposal** while continuing to discover solely via REST GET. All other GraphQL-mode plans block, and no executor exists, so no mutation is performed.

## Rationale and consequences

Issue deletion is irreversible in practice and can destroy discussions, audit trails and links. Existing REST mode has **no deletion mechanism**, and an explicit close is always preferred. The [M7.4 schema](/schema/prune-duplicates.md) limits risk to a demonstrable shared marker and a user-selected canonical issue; it never treats title collisions as sufficient authorization. The later [M8 executor](https://github.com/attention-spa/gh-plan/issues/37) remains unscheduled and is not authorized to execute any of these requests.
