---
type: GitHub Reference
title: "GitHub fine-grained token permissions"
description: "Required permissions for read-only planning and potential external execution of its proposed requests."
resource: https://docs.github.com/en/rest/overview/permissions-required-for-fine-grained-personal-access-tokens
tags: [github, rest, permissions]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:22:39.331+01:00 }
sources:
  - resource: https://docs.github.com/en/rest/overview/permissions-required-for-fine-grained-personal-access-tokens
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
---

## Summary

Required permissions for read-only planning and potential external execution of its proposed requests.

## Verified endpoints and access

| Permission | Applied to | Phase |
| --- | --- | --- |
| Metadata: read | Repository details and repository issue type catalog | REST discovery |
| Issues: read | Issue/milestone/label reads, relationship details, assignee eligibility, per-issue field values | REST discovery |
| Organization Issue Fields: read | List issue fields for an organization-owned repository | Conditional discovery |
| Issues: write | Create/update issues and milestones; labels, assignees, field values, native relationships | External executor only |
| Organization Projects: read | Read referenced organization-owned Projects v2 boards, field metadata and repository-scoped items | Project discovery |
| Organization Projects: write | Add existing issues/PRs as project items; PATCH supported fields | External executor only |
| User-owned Projects REST | GitHub documents fine-grained PAT and GitHub App tokens are unsupported for user-owned project endpoints | Token compatibility warning |
| Pull requests: read | Filter relevant open PRs; read PR detail and pending reviewer requests | PR discovery |
| Contents: read | Validate head/base refs and compare commits ahead of base | New PR discovery |
| Pull requests: write | PR create/close/update and add/remove reviewer requests | External executor only |

## Verified source and scope

These labels describe **GitHub's documented fine-grained access-token permission sets**, not the currently connected agent-hachi token's actual grants. Read-only planning requires only the read permissions relevant to requested operations. Organization-owned repositories using custom issue fields additionally require the *organization-level* **Issue Fields: read** permission, distinct from repository Issues: read. The repository `/issue-types` catalog uses **Metadata: read**. Writing through a future external executor requires **Issues: write** for issue and relationship mutations. Some generic issue/PR endpoints accept Pull requests permission as an alternative, but Issues: write is the uniform requirement for the issue-centric planner.

Projects v2 reads require **organization Projects: read** for organization boards; a separate executor needs **organization Projects: write** to add existing content as an item and set its supported fields. GitHub's 2026-03-10 REST documentation supports *creating project fields*, but this planner intentionally does not. User-owned board endpoints have different token-class restrictions; no current token grants or user-owned access were tested.

PR compilation does not require merging permission: the planner never proposes a merge. A future external executor would need **Pull requests: write** to create or patch PRs or request reviews. PR labels/assignees use GitHub issue endpoints and may be authorized by Issues: write (or Pull requests: write where GitHub documents an alternative). No active-token grants were tested.

Read-only endpoints for public resources can sometimes be requested unauthenticated; private repositories require a token with the appropriate installation/repository access. API version `2026-03-10` is used by the current transport. **No write-permission probe** was performed in this documentation-only work unit, and this bundle does not claim authorization to apply a plan.

Official documentation checked 2026-11-16: [Repository issue types](https://docs.github.com/en/rest/repos/issue-types), [Organization issue fields](https://docs.github.com/en/rest/orgs/issue-fields), [Issues](https://docs.github.com/en/rest/issues/issues), [Issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies), [Issue field values](https://docs.github.com/en/rest/issues/issue-field-values), [Assignees](https://docs.github.com/en/rest/issues/assignees), [Sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [PRs](https://docs.github.com/en/rest/pulls/pulls), [Reviews](https://docs.github.com/en/rest/pulls/review-requests), [References](https://docs.github.com/en/rest/git/refs) and [Commits](https://docs.github.com/en/rest/commits/commits), [Projects](https://docs.github.com/en/rest/projects/projects), [Project fields](https://docs.github.com/en/rest/projects/fields) and [Project items](https://docs.github.com/en/rest/projects/items).
