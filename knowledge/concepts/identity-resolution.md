---
type: Concept
title: "Identity Resolution"
description: "Safe matching from logical resources to existing GitHub identities or proposed creates."
tags: ["identity", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T08:25:57+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/identity.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/discovery.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/execute-steps.ts
---

## Summary

Identity resolution maps each desired logical issue or milestone to `existing`, `new`, `unresolved` or `ambiguous`. It is pure and uses the discovered repository snapshot, not a mutation.

## Precedence

1. **Explicit identity**: supplied REST `id`, node `nodeId` and `number` must all match the same observed resource.
2. **Unique issue marker**: a canonical or custom body marker identifies one issue. Marker conflicts with explicit identity block.
3. **Title fallback**: milestones can use an exact title; an issue-title match requires `adoptByTitle: true`.

When `prune:"close"` is explicitly selected, consistent explicit identity hints can designate a canonical issue despite other observed issues carrying its marker. Without this explicit opt-in, multiple matches remain ambiguous. Titles alone never justify closing or deleting another issue.

Unknown reference-only targets produce blockers instead of creates. Multiple matches or contradictory hints are reported as ambiguity, not silently adopted. Unmatched managed resources can be planned as new.

## Execution-time recovery

Unlike read-only planning, M8.1.3's **internal** executor performs a fresh, complete paginated GET of all open and closed issues before every `issue.create` and checks the exact canonical or whole-token custom marker. A unique match can be reused only if the separate fresh postcondition read confirms it is satisfied with a matching identity. A duplicate marker, unrelated/missing marker, failed catalog read or drifted postconditions halts execution rather than creating another issue. Recovery does not adopt an issue by title, never treats a PR as an issue, and never guesses a number. The read-only planner's identity precedence remains unchanged.

## Pull request identity

A managed PR is resolved by an exact, unique **open head/base branch pair**. When supplied, `identity.number` may select a closed PR and authorize a base update; conflicting identity hints or a changed head block. Discovery reads candidate PR numbers from `/issues`, filters by the requested open pair, and only enriches relevant `/pulls/{number}` details. New PRs require both branches to exist and the head to be ahead of base in the GitHub compare response.

## Rationale

The precedence prevents accidental modification of unrelated issues that happen to share a title. See [body markers](/decisions/markers-in-body.md) and [title adoption opt-in](/decisions/title-adoption-opt-in.md).
