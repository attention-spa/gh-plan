---
type: API
title: "Authoring type contracts"
description: "Typed GithubPlanSchema and its exported shorthand issue, milestone, label and relationship types."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:11:04.172+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Typed GithubPlanSchema and its exported shorthand issue, milestone, label and relationship types.

## Public symbols

- `GithubPlanSchema`
- `AuthoringProjectReference`
- `AuthoringProjectAssignments`
- `AuthoringPullRequest`
- `AuthoringIssue`
- `AuthoringManagedIssue`
- `AuthoringReferencedIssue`
- `AuthoringMilestone`
- `AuthoringRepositoryLabel`
- `AuthoringRelationship`
- `AuthoringIssueLabels`
- `AuthoringIssueAssignees`
- `AuthoringIdentity`
- `AuthoringMilestoneRef`
- `AuthoringSet`
- `AuthoringRemove`

A managed `AuthoringMilestone` may specify `due_on` as `YYYY-MM-DD`, `{op:"set",value:"YYYY-MM-DD"}`, or `{op:"remove"}`. The normalizer rejects invalid calendar days and disallows due-date metadata on reference-only milestones.

The root authoring schema supports `prune: "report" | "close"` and `deleteDuplicates?: boolean`; removing issues from desired state does not imply closing or deletion. Deletion requires `prune:"close"`, `deleteDuplicates:true` and `mode:"graphql"`; this narrow proposal-only path uses REST GET discovery and no GraphQL executor. All other GraphQL modes remain blocked. See [safe pruning](/schema/prune-duplicates.md).

## Contract boundary

Type-level authoring contract. `schema/gh-plan.schema.json` is generated from these types; `normalizeSchema()` remains authoritative for runtime cross-resource checks.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
