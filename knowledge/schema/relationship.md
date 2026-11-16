---
type: Schema Element
title: "Relationship schema element"
description: "Directional parent and blocker edges and symmetric GitHub related-to associations."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [schema, authoring, relationships]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:22:14.293+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/schema/gh-plan.schema.json
---

## Summary

Directional parent and blocker edges and symmetric GitHub related-to associations. See the [desired-state graph](/concepts/desired-state-graph.md) and [public authoring contract](/api/types-authoring.md).

# Schema

| Property | Presence | Meaning |
| --- | --- | --- |
| `kind: parent` | required variant | `{kind:'parent',parent,child}` gives a directed parent/child link |
| `kind: blocked_by` | required variant | `{kind:'blocked_by',issue,blocker}` means issue depends on blocker |
| `kind: blocks` | required variant | `{kind:'blocks',issue,blocked}` normalizes to inverse blocked_by |
| `kind: relates_to` | required variant | `{kind:'relates_to',from,to}` is symmetric |
| `relationshipMode` | optional root | `reconcile` (default) or `additive` (do not remove existing) |

All relationship endpoints must be declared by logical ID and must have the correct resource kind. Cycles and multiple parent assignments block. Native related-to is symmetric; `blocks` is normalized to `blocked_by`.

# Examples

The following JSON is a complete `GithubPlanSchema` value and is validated by the test suite both against the TypeScript authoring type and through `normalizeSchema()`.

```json
{
  "repository": "attention-spa/example",
  "issues": [
    {
      "logicalId": "EPIC",
      "title": "Epic"
    },
    {
      "logicalId": "TASK",
      "title": "Task"
    },
    {
      "logicalId": "REVIEW",
      "title": "Review"
    }
  ],
  "relationships": [
    {
      "kind": "parent",
      "parent": "EPIC",
      "child": "TASK"
    },
    {
      "kind": "blocked_by",
      "issue": "REVIEW",
      "blocker": "TASK"
    },
    {
      "kind": "relates_to",
      "from": "EPIC",
      "to": "REVIEW"
    }
  ]
}
```
