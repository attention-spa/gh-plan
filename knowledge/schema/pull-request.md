---
type: Schema Element
title: "Pull request schema element"
description: "Managed same-repository pull requests keyed by an open head/base pair, with named reviewers and safe Closes references."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [schema, authoring, pull-requests]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:58:42.961+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://docs.github.com/en/rest/pulls/pulls
---

## Summary

A `pullRequests` root array declares managed PRs by unique same-repository `head`/`base` branch pair. The planner never opens or merges a PR itself; it emits dependency-ordered REST proposals. See [PR planning API](/api/compilePullRequestSteps.md).

# Schema

| Property | Form | Semantics |
| --- | --- | --- |
| `logicalId` | required string | Unique across issues, milestones, labels and PRs. |
| `head` / `base` | required branch strings | Same repository; an open pair is the natural identity. No fork support. |
| `identity` | optional explicit `number`/`id`/`nodeId` | Numbers allow closed PR lookup and changing an existing base. |
| `title` / `body` / `state` | partial managed values | Create requires title; existing properties are patched only when declared. |
| `draft` | boolean or `{op:"set",value:boolean}` | Supported on creation; changed draft status on existing PRs blocks in REST mode. |
| `labels` / `assignees` | exact or targeted set | Uses native issue label/assignee endpoints via existing M4 compilers. |
| `reviewers` | exact or targeted GitHub user logins | Uses `/pulls/{number}/requested_reviewers`, not an approval or team reviewer. |
| `closes` | logical issue ID array | Reconciles a single managed `Closes #number` body block, retaining unrelated human text; new issue numbers bind after creation. |

The planner checks head/base existence and head-ahead commits using read-only GitHub references/comparison GETs before proposing a create. PR discovery uses `/issues` PR metadata, a filtered open head/base query, and detailed `/pulls/{number}` only for matching PRs. Identical branch refs, malformed closure blocks and unsafe identity matches block. Merging and REST draft toggles are **not** supported.

# Examples

This complete document is extracted, JSON Schema validated, normalized and typechecked in CI. The referenced issue must already exist in the real repository; normalization alone does not verify its existence.

```json
{
  "repository": "attention-spa/example",
  "issues": [
    {
      "logicalId": "TASK",
      "management": "reference",
      "identity": {
        "number": 12
      }
    }
  ],
  "pullRequests": [
    {
      "logicalId": "PR",
      "head": "feature/docs",
      "base": "main",
      "title": "Document the feature",
      "body": "Documents the implementation.",
      "closes": [
        "TASK"
      ],
      "draft": true,
      "labels": {
        "add": [
          "docs"
        ]
      },
      "assignees": {
        "add": [
          "agent-hachi"
        ]
      },
      "reviewers": {
        "add": [
          "reviewer"
        ]
      }
    }
  ]
}
```
