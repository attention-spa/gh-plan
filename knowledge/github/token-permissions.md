---
type: GitHub Reference
title: "GitHub fine-grained token permissions"
description: "Required permissions for read-only planning and potential external execution of its proposed requests."
resource: https://docs.github.com/en/rest/overview/permissions-required-for-fine-grained-personal-access-tokens
tags: [github, rest, permissions]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:11:04.172+01:00 }
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

## #175 live permission check for the A1 CAS Git-ref owner

The internal CAS reference backend reads the canonical repository/default branch and owner Git commit, creates an **off-ref** owner commit, and atomically creates/removes `refs/heads/gh-plan/locks/repository` using GraphQL `updateRefs` and exact conditional OIDs. Documented minimum is **Metadata: read** and **Contents: read/write** on the target repository. It does **not** require Issues:write to acquire the lock; an issue/milestone executor needs Issues:write separately. An agent-hachi **admin** token performed live acquire/release/contender tests in a disposable private repo, proving effective permission rather than least-privilege scope. Private-repository branch-protection/rulesets GETs returned 403 with GitHub's upgrade/private-plan message, so protected ruleset behavior was **not** live-tested. The reference adapter fails closed on denied CAS writes; no production token grants were changed.

## #176 manually approved abandoned-ref recovery

The [manual operator runbook](../../docs/operator-cas-recovery.md) requires repository **Metadata:read** and **Contents:read/write** to inspect the canonical repository, exact Git ref and owner/parent commits and issue precisely one GraphQL matching-OID ref deletion. The optional documented PowerShell procedure additionally requires **Issues:write on the incident/audit repository** (which may differ from the target) to persist before/after audit comments. Nothing authorizes issue or milestone writes in the target. The #176 live fixture used agent-hachi admin access to a disposable private repository, not a least-privilege token nor a human-approved production incident. Privileged/opaque 404, policy-403, expired tokens, protected-ref/ruleset failure and uncertain GraphQL results must stop recovery; they cannot be bypassed. No new production credentials or grants were created.

## C2 callback ownership of permissions (future, not implemented)

The approved [C2 caller-injected API](/decisions/caller-injected-apply-contract.md) has **no public `auth` parameter or built-in GitHub writer**: it accepts caller-provided dispatch, postcondition, catalog and ownership callbacks. The package cannot attest the actual permission scopes or GitHub interactions of those callbacks. A separately selectable GitHub-backed reference adapter is required to apply the A1/B1 documented permission policy and prove it in a disposable private repository. The package remains private/read-only in its current exports.

## B1 planned mutation permissions (not currently exercised)

The [approved B1 four-kind allowlist](/decisions/progressive-apply-postconditions.md) uses `Issues:write` for issue/milestone REST POST/PATCH plus read access for authoritative verification. GitHub also documents `Pull requests:write` as an alternative for certain milestone writes, but not as the uniform MVP requirement. Creating an issue with a milestone additionally requires push access. The A1 Git-ref lock separately needs repository `Contents:read/write`. No live production token/permission check or write was performed by this decision; disposable private-repository tests are required.

## Verified source and scope

These labels describe **GitHub's documented fine-grained access-token permission sets**, not the currently connected agent-hachi token's actual grants. Read-only planning requires only the read permissions relevant to requested operations. Organization-owned repositories using custom issue fields additionally require the *organization-level* **Issue Fields: read** permission, distinct from repository Issues: read. The repository `/issue-types` catalog uses **Metadata: read**. Writing through a future external executor requires **Issues: write** for issue and relationship mutations. Some generic issue/PR endpoints accept Pull requests permission as an alternative, but Issues: write is the uniform requirement for the issue-centric planner.

Projects v2 reads require **organization Projects: read** for organization boards; a separate executor needs **organization Projects: write** to add existing content as an item and set its supported fields. GitHub's 2026-03-10 REST documentation supports *creating project fields*, but this planner intentionally does not. User-owned board endpoints have different token-class restrictions; no current token grants or user-owned access were tested.

Orphan and duplicate reporting reuses repository **Issues: read**. A later executor would need **Issues: write** to post a canonical reason comment or close an issue. Irreversible `deleteIssue` is a **GraphQL** mutation with separate authorization requirements and a narrowly permitted dual-opt-in GraphQL **proposal** path using REST GET discovery, but no GraphQL executor or network transport. The active token's deletion grants were not inspected.

PR compilation does not require merging permission: the planner never proposes a merge. A future external executor would need **Pull requests: write** to create or patch PRs or request reviews. PR labels/assignees use GitHub issue endpoints and may be authorized by Issues: write (or Pull requests: write where GitHub documents an alternative). No active-token grants were tested.

Read-only endpoints for public resources can sometimes be requested unauthenticated; private repositories require a token with the appropriate installation/repository access. API version `2026-03-10` is used by the current transport. **No write-permission probe** was performed in this documentation-only work unit, and this bundle does not claim authorization to apply a plan.

Official documentation checked 2026-11-16: [Repository issue types](https://docs.github.com/en/rest/repos/issue-types), [Organization issue fields](https://docs.github.com/en/rest/orgs/issue-fields), [Issues](https://docs.github.com/en/rest/issues/issues), [Issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies), [Issue field values](https://docs.github.com/en/rest/issues/issue-field-values), [Assignees](https://docs.github.com/en/rest/issues/assignees), [Sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [PRs](https://docs.github.com/en/rest/pulls/pulls), [Reviews](https://docs.github.com/en/rest/pulls/review-requests), [References](https://docs.github.com/en/rest/git/refs) and [Commits](https://docs.github.com/en/rest/commits/commits), [Projects](https://docs.github.com/en/rest/projects/projects), [Project fields](https://docs.github.com/en/rest/projects/fields) and [Project items](https://docs.github.com/en/rest/projects/items).
