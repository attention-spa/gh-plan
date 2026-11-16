---
type: Schema Element
title: "Repository schema element"
description: "Target repository selector and the scope of all desired GitHub resources."
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

Target repository selector and the scope of all desired GitHub resources. See the [desired-state graph](/concepts/desired-state-graph.md) and [public authoring contract](/api/types-authoring.md).

# Schema

| Property | Presence | Meaning |
| --- | --- | --- |
| `repository` | required | owner/name string or `{fullName, id?, nodeId?}` |
| `$schema` | optional | Absolute JSON Schema URI used only for authoring/editor validation |
| `relationshipMode` | optional | `reconcile` (default) or `additive` |

The repository selector is required. A GitHub repository must already exist; the planner does not create repositories. The target is verified against read-only discovery before any plan is produced.

# Examples

The following JSON is a complete `GithubPlanSchema` value and is validated by the test suite both against the TypeScript authoring type and through `normalizeSchema()`.

```json
{
  "repository": {
    "fullName": "attention-spa/example"
  },
  "issues": [
    {
      "logicalId": "BACKLOG",
      "title": "Backlog"
    }
  ]
}
```
