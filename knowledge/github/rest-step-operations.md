---
type: GitHub Reference
title: "Planned REST operation matrix"
description: "Planned HTTP methods and endpoint paths mapped to the current PlanOperationKind vocabulary."
resource: https://docs.github.com/en/rest/issues/issues
tags: [github, rest, permissions]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:11:04.172+01:00 }
sources:
  - resource: https://docs.github.com/en/rest/issues/issues
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/relationship-compiler.ts
---

## Summary

Planned HTTP methods and endpoint paths mapped to the current PlanOperationKind vocabulary.

## Verified endpoints and access

| Method | Endpoint | Plan step kind | Permission |
| --- | --- | --- | --- |
| POST | /orgs/{org}/projectsV2/{project_number}/items | project.item.add | Organization Projects: write |
| PATCH | /orgs/{org}/projectsV2/{project_number}/items/{item_id} | project.item.fields.set | Organization Projects: write |
| POST | /users/{username}/projectsV2/{project_number}/items | project.item.add | User project token restrictions |
| PATCH | /users/{username}/projectsV2/{project_number}/items/{item_id} | project.item.fields.set | User project token restrictions |
| POST | /repos/{owner}/{repo}/pulls | pull_request.create | Pull requests: write |
| PATCH | /repos/{owner}/{repo}/pulls/{number} | pull_request.update | Pull requests: write |
| POST | /repos/{owner}/{repo}/pulls/{number}/requested_reviewers | pull_request.reviewer.add | Pull requests: write |
| DELETE | /repos/{owner}/{repo}/pulls/{number}/requested_reviewers | pull_request.reviewer.remove | Pull requests: write |
| PATCH | /repos/{owner}/{repo}/issues/{number} | issue.orphan.close, issue.duplicate.close | Issues: write |
| POST | /repos/{owner}/{repo}/issues/{number}/comments | issue.duplicate.comment | Issues: write |
| GraphQL (non-REST) | deleteIssue(input:{issueId:ID!}) | issue.duplicate.delete (pure GraphQL proposal; public planner mode blocked) | Separate GraphQL transport / deletion authorization |
| POST | /repos/{owner}/{repo}/milestones | milestone.create | Issues: write |
| PATCH | /repos/{owner}/{repo}/milestones/{number} | milestone.update | Issues: write |
| POST | /repos/{owner}/{repo}/issues | issue.create | Issues: write |
| PATCH | /repos/{owner}/{repo}/issues/{number} | issue.update, issue.type.set, issue.marker.adopt | Issues: write |
| POST | /repos/{owner}/{repo}/issues/{number}/issue-field-values | issue.field.set | Issues: write |
| DELETE | /repos/{owner}/{repo}/issues/{number}/issue-field-values/{field_id} | issue.field.remove | Issues: write |
| POST | /repos/{owner}/{repo}/labels | label.create | Issues: write |
| PATCH | /repos/{owner}/{repo}/labels/{name} | label.update | Issues: write |
| PUT | /repos/{owner}/{repo}/issues/{number}/labels | issue.label.set | Issues: write |
| POST | /repos/{owner}/{repo}/issues/{number}/labels | issue.label.add | Issues: write |
| DELETE | /repos/{owner}/{repo}/issues/{number}/labels/{name} | issue.label.remove | Issues: write |
| POST | /repos/{owner}/{repo}/issues/{number}/assignees | issue.assignee.add | Issues: write |
| DELETE | /repos/{owner}/{repo}/issues/{number}/assignees | issue.assignee.remove | Issues: write |
| POST | /repos/{owner}/{repo}/issues/{number}/sub_issues | issue.parent.set | Issues: write |
| DELETE | /repos/{owner}/{repo}/issues/{number}/sub_issue | issue.parent.remove | Issues: write |
| POST | /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by | issue.dependency.add | Issues: write |
| DELETE | /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by/{issue_id} | issue.dependency.remove | Issues: write |
| POST | /repos/{owner}/{repo}/issues/{number}/relates_to | issue.relates_to.add | Issues: write |
| DELETE | /repos/{owner}/{repo}/issues/{number}/relates_to/{issue_id} | issue.relates_to.remove | Issues: write |

## Initial live-apply capability (approved design only)

The [B1 coverage decision](/decisions/progressive-apply-postconditions.md) allows only four conditional candidate kinds for a future executor: `milestone.create`, `milestone.update`, `issue.create`, and `issue.update`. This table above lists *everything the planner can propose*; it is **not** an executable allowlist. B1 additionally rejects unsupported request fields/shapes, incomplete/ambiguous postconditions and all other kinds after whole-plan preflight. Unique issue body markers, unique milestone titles and authoritative GETs across open/closed resources are required to verify creates. This is not yet implemented; no runtime writer or public export exists.

## Interpretation

Projects v2 `project.item.add` accepts an `Issue` or `PullRequest` REST content ID (or repo owner/name/number) to add existing content. New issues/PRs are late-bound after their create steps. `project.item.fields.set` PATCH sends `{fields: [{id: numericFieldId, value: scalarOrOptionId}]}` using existing board field metadata and a discovered or newly created project-item REST ID. Only text, number, date, single-select and iteration values are supported; **no project/field create, item delete or membership remove operations are emitted**. Project-field creation REST exists, but it is deliberately outside gh-plan's authority.

The [M7.4 prune policy](/schema/prune-duplicates.md) reports markers/title collisions by default. Explicit `prune:"close"` plans `PATCH /issues/{number}` with `state:"closed",state_reason:"not_planned"` for uniquely marked orphans. Duplicates with an explicitly identified canonical issue receive a prior reason comment, then `state_reason:"duplicate"` and `duplicate_issue_id` (canonical REST ID). Both closures are non-destructive and reversible. `issue.duplicate.delete` is an irreversible GraphQL-only pure proposal, **never a REST mutation**; top-level GraphQL planning permits only dual-opt-in duplicate deletion proposals, while all other GraphQL use remains blocked.

Milestone `due_on` is a date-only `YYYY-MM-DD` in authoring. The planner proposes `YYYY-MM-DDT00:00:00Z` for POST/PATCH sets, and `due_on: null` on PATCH when explicitly cleared; omission leaves the existing date untouched. A matching observed timestamp on the same UTC calendar date is a noop. This is based on the documented ISO 8601 REST field; no real clear operation was executed in M7.3.

PR create includes `head`, `base`, title and optional initial `draft` flag. PR PATCH supports only explicitly managed title, body, base and open/closed state. Existing **draft transitions** and **merging** are deliberately unsupported. Reviewers are user logins via `requested_reviewers`, not approvals. PR label/assignee operations continue to use the issue endpoints with the PR number, depending on `pull_request.create` when new.

These are **inert request proposals** returned by compilers; gh-plan performs no mutation. Issue creation may emit a second `issue.update` to close a newly created issue after its ID becomes available. `issue.assignee.set` is a semantic operation represented by add/remove deltas, not a standalone PUT endpoint. `verification.read` is a reserved plan kind without a mutation endpoint.

For parent relations, a POST targets the **parent's** `sub_issues` path; removal uses the former **parent's** `sub_issue` path with `sub_issue_id` in the body. Dependency `blocked_by` targets the **blocked issue**; related-to is symmetric. A newly created endpoint uses [PlanValueRef](/concepts/late-binding-refs.md) placeholders and explicit `dependsOn` create-step IDs.

The *documented* minimum for this all-issue workflow is fine-grained repository **Issues: write**; a number of generic labels/assignee/milestone operations also accept **Pull requests: write** as an alternative. Organization issue-field discovery additionally requires organization **Issue Fields: read**. Actual token grants have **not** been inspected or tested for writes.

Official docs: [Issues](https://docs.github.com/en/rest/issues/issues), [Milestones](https://docs.github.com/en/rest/issues/milestones), [Labels](https://docs.github.com/en/rest/issues/labels), [Assignees](https://docs.github.com/en/rest/issues/assignees), [Issue-field values](https://docs.github.com/en/rest/issues/issue-field-values), [Sub-issues](https://docs.github.com/en/rest/issues/sub-issues) [Dependencies](https://docs.github.com/en/rest/issues/issue-dependencies), [Pull requests](https://docs.github.com/en/rest/pulls/pulls) and [Review requests](https://docs.github.com/en/rest/pulls/review-requests), [Issue comments](https://docs.github.com/en/rest/issues/comments), [GraphQL issue deletion](https://docs.github.com/en/graphql/reference/issues), [Projects](https://docs.github.com/en/rest/projects/projects), [Project fields](https://docs.github.com/en/rest/projects/fields) and [Project items](https://docs.github.com/en/rest/projects/items).
