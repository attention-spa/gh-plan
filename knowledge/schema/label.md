---
type: Schema Element
title: "Label schema element"
description: "Repository label creation and metadata updates by name, plus issue label assignments."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [schema, authoring, planning]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:22:14.293+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/schema/gh-plan.schema.json
---

## Summary

Repository label creation and metadata updates by name, plus issue label assignments. See the [desired-state graph](/concepts/desired-state-graph.md) and [public authoring contract](/api/types-authoring.md).

# Schema

| Property | Presence | Meaning |
| --- | --- | --- |
| `labels[] at root` | optional | Repository label declarations, keyed case-insensitively by name |
| `name` | required | Nonempty trimmed repository-label name |
| `color` | managed optional | Six hexadecimal digits, without `#`; omission preserves |
| `description` | managed optional | String up to 100 characters; empty clears |
| `management` | optional | `managed` or `reference` |
| `issues[].labels` | optional | Exact set or targeted add/remove of existing or declared managed labels |

Repository labels are never renamed or deleted. A missing managed root label is created before an issue assignment that references it. A missing reference-only label blocks; omitting a label from the root is not a delete request.

# Examples

The following JSON is a complete `GithubPlanSchema` value and is validated by the test suite both against the TypeScript authoring type and through `normalizeSchema()`.

```json
{
  "repository": "attention-spa/example",
  "labels": [
    {
      "name": "triage",
      "color": "aabbcc",
      "description": "Awaiting review"
    }
  ],
  "issues": [
    {
      "logicalId": "ISSUE",
      "title": "Review",
      "labels": {
        "add": [
          "triage"
        ]
      }
    }
  ]
}
```
