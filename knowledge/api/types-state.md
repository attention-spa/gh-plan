---
type: API
title: "Desired and observed state types"
description: "NormalizedDesiredStateGraph, desired-resource unions, observed snapshots and resolution statuses."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

NormalizedDesiredStateGraph, desired-resource unions, observed snapshots and resolution statuses.

## Public symbols

- `NormalizedDesiredStateGraph`
- `DesiredResource`
- `ManagedIssueResource`
- `ReferencedIssueResource`
- `ManagedMilestoneResource`
- `ReferencedMilestoneResource`
- `DesiredRelationship`
- `DesiredIssueState`
- `DesiredMilestoneState`
- `DesiredRepositoryLabel`
- `GithubStateSnapshot`
- `ObservedIssue`
- `ObservedMilestone`
- `ObservedLabel`
- `ResourceResolution`

## Contract boundary

Normalized desired state is not observed GitHub state. Optional snapshot fields may mean not discovered rather than empty.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
