---
type: Schema Element
title: "Set and remove operations"
description: "Shorthand values, explicit sets, removal operators and omitted-property reconciliation semantics."
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

Shorthand values, explicit sets, removal operators and omitted-property reconciliation semantics. See the [desired-state graph](/concepts/desired-state-graph.md) and [public authoring contract](/api/types-authoring.md).

# Schema

| Property | Presence | Meaning |
| --- | --- | --- |
| `absent property` | default | No reconciliation of that property |
| `string/direct value` | shorthand | Normalized to `{op:'set',value}` where supported |
| `{op:'set',value}` | explicit | Reconcile a property to the supplied value |
| `{op:'remove'}` | explicit | Clear supported nullable properties, e.g. body, description, milestone and named fields |
| `labels/assignees` | special | Exact `{op:'set',value:[...]}` or targeted `{add?,remove?}` operations |

The sample declares an issue-label addition without declaring the repository label; it **normalizes** but would need `triage` to exist in discovery for a ready plan. Removal is not allowed for `title` or issue `type`; `null` is not equivalent to `{op:'remove'}`.

# Examples

The following JSON is a complete `GithubPlanSchema` value and is validated by the test suite both against the TypeScript authoring type and through `normalizeSchema()`.

```json
{
  "repository": "attention-spa/example",
  "milestones": [
    {
      "logicalId": "M1",
      "title": "Milestone",
      "description": {
        "op": "remove"
      }
    }
  ],
  "issues": [
    {
      "logicalId": "TASK",
      "title": "Task",
      "body": {
        "op": "remove"
      },
      "milestone": {
        "op": "remove"
      },
      "fields": {
        "Priority": {
          "op": "remove"
        }
      },
      "labels": {
        "add": [
          "triage"
        ]
      }
    }
  ]
}
```
