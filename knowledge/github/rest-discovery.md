---
type: GitHub Reference
title: "Read-only REST discovery"
description: "GitHub REST GET catalog, enrichment and assignee-eligibility endpoints used by the planner."
resource: https://docs.github.com/en/rest/issues/issues
tags: [github, rest, permissions]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T08:25:57+01:00 }
sources:
  - resource: https://docs.github.com/en/rest/issues/issues
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/rest.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/execute-steps.ts
---

## Summary

GitHub REST GET catalog, enrichment and assignee-eligibility endpoints used by the planner.

## Recovery-specific read contract

M8.1.3's internal `createRestIssueCatalogReader()` uses `GET /repos/{owner}/{repo}/issues?state=all&per_page=100` with **every** Link pagination page, without relying on the original planning snapshot. It uses the existing sanitized transport errors, validates issue response shapes, excludes pull-request entries and never performs a mutation. The complete list allows an exact-marker uniqueness check immediately before each `issue.create`; failed pages prohibit dispatch. This read requires repository Issues: read. It does not provide a cross-process uniqueness lock.

## Verified endpoints and access

| Method | Endpoint | Purpose | Permission |
| --- | --- | --- | --- |
| GET | /repos/{owner}/{repo} | Repository metadata | Metadata: read |
| GET | /repos/{owner}/{repo}/issues?state=all&per_page=100 | Issues summary listing | Issues: read |
| GET | /repos/{owner}/{repo}/milestones?state=all&per_page=100 | Milestones, title identity and nullable ISO `due_on` timestamp | Issues: read |
| GET | /repos/{owner}/{repo}/issue-types | Optional repository issue types (200 or 404) | Metadata: read |
| GET | /repos/{owner}/{repo}/labels?per_page=100 | Root/issue label catalog, only when managed | Issues: read |
| GET | /orgs/{org}/issue-fields | Organization issue-field catalog, only for org-owned repos | Organization Issue Fields: read |
| GET | /repos/{owner}/{repo}/issues/{number}/issue-field-values?per_page=100 | Selected issue field values, when fields available | Issues: read |
| GET | /repos/{owner}/{repo}/issues/{number}/parent | Selected issue parent; 404 means no parent | Issues: read |
| GET | /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by?per_page=100 | Selected issue blockers | Issues: read |
| GET | /repos/{owner}/{repo}/issues/{number}/relates_to?per_page=100 | Selected related issues | Issues: read |
| GET | /repos/{owner}/{repo}/assignees/{login} | Eligibility when adding an assignee; 204/404 | Issues: read |
| GET | /orgs/{org}/projectsV2/{project_number} | Read a declared organization-owned existing project; 404 means missing | Organization Projects: read |
| GET | /orgs/{org}/projectsV2/{project_number}/fields?per_page=100 | Read existing custom field IDs, types and options/iterations | Organization Projects: read |
| GET | /orgs/{org}/projectsV2/{project_number}/items?q=repo:{owner}/{repo}&fields={numeric_ids}&per_page=100 | Read only target repository items and selected numeric field values | Organization Projects: read |
| GET | /users/{username}/projectsV2/{project_number} | Equivalent read for a user-owned existing project; token compatibility differs | User-owned Projects REST token restrictions |
| GET | /users/{username}/projectsV2/{project_number}/fields?per_page=100 | User-owned project fields | User-owned Projects REST token restrictions |
| GET | /users/{username}/projectsV2/{project_number}/items?q=repo:{owner}/{repo}&fields={numeric_ids}&per_page=100 | User-owned project scoped items | User-owned Projects REST token restrictions |
| GET | /repos/{owner}/{repo}/pulls?state=open&head={owner}:{head}&base={base}&per_page=100 | Filter open same-repo PR pair from issue-list PR candidates | Pull requests: read |
| GET | /repos/{owner}/{repo}/pulls/{number} | Enrich only matching/explicitly numbered PR | Pull requests: read |
| GET | /repos/{owner}/{repo}/pulls/{number}/requested_reviewers | Snapshot pending user reviewer requests | Pull requests: read |
| GET | /repos/{owner}/{repo}/git/ref/heads/{branch} | Verify new PR head/base refs exist | Contents: read |
| GET | /repos/{owner}/{repo}/compare/{base}...{head} | Verify head contains commits ahead of base | Contents: read |

## Runtime behavior

Milestone `due_on` is included in the existing paginated milestone GET and requires no additional request. Non-null values are validated as ISO timestamps and normalized to UTC calendar dates for semantic comparison; `null` denotes no deadline.

Pruning uses only the existing paginated `GET /issues?state=all` list. The REST adapter already excludes PRs. Canonical issue-body markers and title collisions require **no additional request**, and no mutation is executed by the planner.

For declared Projects v2, the transport performs only read-only GETs on the referenced project by owner/number, field metadata, and a repository-filtered item listing with explicit numeric field selectors. It never lists unrelated boards or requests project/field creation. Project list pagination is followed safely as with existing REST catalogs. User-owned board GETs are supported in the adapter but GitHub documents that they do **not** support fine-grained token classes; authentication failures are blockers.

For declared PRs, the broad `/issues` listing also supplies candidate PR numbers. The transport filters each requested open head/base pair, then enriches **only** relevant `/pulls/{number}` and `requested_reviewers` state. New pairs trigger branch-ref and compare GETs, never PR creates. No PR-related reads are added for plans without `pullRequests`.

The factory `createRestDiscoveryTransport()` performs no network I/O; `discover()` first reads broad repository data, and `enrich()` then reads only selected existing issues. Each chosen issue normally requires three relationship GETs, and issue field values add one when org field metadata exists. Pagination may add requests. Explicit assignment additions cause eligibility GETs; removal-only instructions do not. The worker pool defaults to four concurrent details.

The transport sends `X-GitHub-Api-Version: 2026-03-10` and `Accept: application/vnd.github+json`. It never sends POST/PATCH/DELETE. Permission statements here are *GitHub's documented fine-grained token requirements* as of 2026-11-16, not an inspection of the active token's current grants. Some public GET endpoints work unauthenticated. [Permission notes](/github/token-permissions.md) distinguish repository and organization grants.

Official docs: [Issues](https://docs.github.com/en/rest/issues/issues), [Milestones](https://docs.github.com/en/rest/issues/milestones), [Repository issue types](https://docs.github.com/en/rest/repos/issue-types), [Labels](https://docs.github.com/en/rest/issues/labels), [Issue-field values](https://docs.github.com/en/rest/issues/issue-field-values), [Organization issue fields](https://docs.github.com/en/rest/orgs/issue-fields), [Sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [Dependencies](https://docs.github.com/en/rest/issues/issue-dependencies) and [Assignees](https://docs.github.com/en/rest/issues/assignees), [Pull requests](https://docs.github.com/en/rest/pulls/pulls), [Review requests](https://docs.github.com/en/rest/pulls/review-requests), [Git references](https://docs.github.com/en/rest/git/refs) and [Commit comparison](https://docs.github.com/en/rest/commits/commits), [Projects](https://docs.github.com/en/rest/projects/projects), [Project fields](https://docs.github.com/en/rest/projects/fields) and [Project items](https://docs.github.com/en/rest/projects/items).
