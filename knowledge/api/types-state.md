---
type: API
title: "Desired and observed state types"
description: "NormalizedDesiredStateGraph, desired-resource unions, observed snapshots and resolution statuses."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:00:14.448+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

NormalizedDesiredStateGraph, desired-resource unions, observed snapshots and resolution statuses.

## Public symbols

- `NormalizedDesiredStateGraph`
- `DesiredProjectReference`
- `DesiredProjectItemAssignment`
- `ObservedProject`
- `ObservedProjectItem`
- `ObservedProjectField`
- `DesiredPullRequestResource`
- `DesiredPullRequestState`
- `ObservedPullRequest`
- `PullRequestBranchCheck`
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

The `DesiredMilestoneState.due_on` property holds an explicit set/remove of a calendar date. `ObservedMilestone.due_on` holds GitHub's ISO timestamp or `null`; an absent optional value indicates that it was not observed and blocks managed comparisons.

The graph retains only explicit `prune:"close"` and `deleteDuplicates:true` controls; omission is report-only. Observed issues expose bodies, titles, state, REST IDs and optional node IDs for conservative duplicate detection.

## Contract boundary

Normalized desired state is not observed GitHub state. Optional snapshot fields may mean not discovered rather than empty.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
