---
type: Schema Element
title: "Milestone schema element"
description: "Managed milestones with partial title/description/state and reference-only milestone identities."
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

Managed milestones with partial title/description/state and reference-only milestone identities. See the [desired-state graph](/concepts/desired-state-graph.md) and [public authoring contract](/api/types-authoring.md).

# Schema

| Property | Presence | Meaning |
| --- | --- | --- |
| `logicalId` | required | Unique logical key |
| `management` | optional | `managed` (default) or `reference` |
| `identity` | optional | Explicit number/id/nodeId |
| `title` | managed | String or `{op:set,value:string}`, no remove |
| `description` | managed | String, set or explicit remove |
| `state` | managed | `open` or `closed`, optionally explicit set |

Exact milestone title is the fallback identity when an explicit ID is absent. Reference milestones must exist and cannot carry desired metadata. The `due_on` field is not supported in M6.2 (planned for M7.3).

# Examples

The following JSON is a complete `GithubPlanSchema` value and is validated by the test suite both against the TypeScript authoring type and through `normalizeSchema()`.

```json
{
  "repository": "attention-spa/example",
  "milestones": [
    {
      "logicalId": "M1",
      "title": "Iteration 1",
      "description": {
        "op": "set",
        "value": "First milestone"
      }
    }
  ],
  "issues": [
    {
      "logicalId": "TASK",
      "title": "Delivery",
      "milestone": "M1"
    }
  ]
}
```
