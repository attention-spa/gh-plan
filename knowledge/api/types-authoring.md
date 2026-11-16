---
type: API
title: "Authoring type contracts"
description: "Typed GithubPlanSchema and its exported shorthand issue, milestone, label and relationship types."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:59:23.581+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Typed GithubPlanSchema and its exported shorthand issue, milestone, label and relationship types.

## Public symbols

- `GithubPlanSchema`
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

## Contract boundary

Type-level authoring contract. `schema/gh-plan.schema.json` is generated from these types; `normalizeSchema()` remains authoritative for runtime cross-resource checks.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
