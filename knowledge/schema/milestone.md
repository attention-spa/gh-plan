---
type: Schema Element
title: "Milestone schema element"
description: "Managed milestones with partial title/description/state/due date and reference-only milestone identities."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [schema, authoring, planning]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:39:10.683+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/schema/gh-plan.schema.json
---

## Summary

Managed milestones with partial title/description/state/due date and reference-only milestone identities. See the [desired-state graph](/concepts/desired-state-graph.md) and [public authoring contract](/api/types-authoring.md).

# Schema

| Property | Presence | Meaning |
| --- | --- | --- |
| `logicalId` | required | Unique logical key |
| `management` | optional | `managed` (default) or `reference` |
| `identity` | optional | Explicit number/id/nodeId |
| `title` | managed | String or `{op:set,value:string}`, no remove |
| `description` | managed | String, set or explicit remove |
| `state` | managed | `open` or `closed`, optionally explicit set |
| `due_on` | managed | UTC calendar date `YYYY-MM-DD`, `{op:"set",value:"YYYY-MM-DD"}`, or `{op:"remove"}` |

Exact milestone title is the fallback identity when an explicit ID is absent. Reference milestones must exist and cannot carry desired metadata. A `due_on` calendar date must be real (including leap-year checks); authoring ISO timestamps or `null` is invalid. A **set** emits the full GitHub REST ISO timestamp `YYYY-MM-DDT00:00:00Z`. An explicit **remove** emits `due_on: null` for an existing deadline and omits the property on creation; an omitted `due_on` never changes the deadline. GitHub's returned timestamp is compared by **UTC calendar date**, so hours/minutes alone do not cause a patch. This is planning only, not an executed clear request. See the [milestone API compiler](/api/compileMilestoneSteps.md) and [REST mapping](/github/rest-step-operations.md).

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
      },
      "due_on": "2026-12-20"
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
