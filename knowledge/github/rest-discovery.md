---
type: GitHub Reference
title: "Read-only REST discovery"
description: "GitHub REST GET catalog, enrichment and assignee-eligibility endpoints used by the planner."
resource: https://docs.github.com/en/rest/issues/issues
tags: [github, rest, permissions]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:24:25.476+01:00 }
sources:
  - resource: https://docs.github.com/en/rest/issues/issues
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/rest.ts
---

## Summary

GitHub REST GET catalog, enrichment and assignee-eligibility endpoints used by the planner.

## Verified endpoints and access

| Method | Endpoint | Purpose | Permission |
| --- | --- | --- | --- |
| GET | /repos/{owner}/{repo} | Repository metadata | Metadata: read |
| GET | /repos/{owner}/{repo}/issues?state=all&per_page=100 | Issues summary listing | Issues: read |
| GET | /repos/{owner}/{repo}/milestones?state=all&per_page=100 | Milestones and identity by title | Issues: read |
| GET | /repos/{owner}/{repo}/issue-types | Optional repository issue types (200 or 404) | Metadata: read |
| GET | /repos/{owner}/{repo}/labels?per_page=100 | Root/issue label catalog, only when managed | Issues: read |
| GET | /orgs/{org}/issue-fields | Organization issue-field catalog, only for org-owned repos | Organization Issue Fields: read |
| GET | /repos/{owner}/{repo}/issues/{number}/issue-field-values?per_page=100 | Selected issue field values, when fields available | Issues: read |
| GET | /repos/{owner}/{repo}/issues/{number}/parent | Selected issue parent; 404 means no parent | Issues: read |
| GET | /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by?per_page=100 | Selected issue blockers | Issues: read |
| GET | /repos/{owner}/{repo}/issues/{number}/relates_to?per_page=100 | Selected related issues | Issues: read |
| GET | /repos/{owner}/{repo}/assignees/{login} | Eligibility when adding an assignee; 204/404 | Issues: read |

## Runtime behavior

The factory `createRestDiscoveryTransport()` performs no network I/O; `discover()` first reads broad repository data, and `enrich()` then reads only selected existing issues. Each chosen issue normally requires three relationship GETs, and issue field values add one when org field metadata exists. Pagination may add requests. Explicit assignment additions cause eligibility GETs; removal-only instructions do not. The worker pool defaults to four concurrent details.

The transport sends `X-GitHub-Api-Version: 2026-03-10` and `Accept: application/vnd.github+json`. It never sends POST/PATCH/DELETE. Permission statements here are *GitHub's documented fine-grained token requirements* as of 2026-11-16, not an inspection of the active token's current grants. Some public GET endpoints work unauthenticated. [Permission notes](/github/token-permissions.md) distinguish repository and organization grants.

Official docs: [Issues](https://docs.github.com/en/rest/issues/issues), [Milestones](https://docs.github.com/en/rest/issues/milestones), [Repository issue types](https://docs.github.com/en/rest/repos/issue-types), [Labels](https://docs.github.com/en/rest/issues/labels), [Issue-field values](https://docs.github.com/en/rest/issues/issue-field-values), [Organization issue fields](https://docs.github.com/en/rest/orgs/issue-fields), [Sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [Dependencies](https://docs.github.com/en/rest/issues/issue-dependencies) and [Assignees](https://docs.github.com/en/rest/issues/assignees).
