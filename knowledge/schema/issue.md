---
type: Schema Element
title: "Issue schema element"
description: "Managed and reference-only issues, nested children, named fields, labels, assignees and identity hints."
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

Managed and reference-only issues, nested children, named fields, labels, assignees and identity hints. See the [desired-state graph](/concepts/desired-state-graph.md) and [public authoring contract](/api/types-authoring.md).

# Schema

| Property | Presence | Meaning |
| --- | --- | --- |
| `logicalId` | required | Stable resource key (`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`) |
| `management` | optional | `managed` (default) or `reference` |
| `identity` | optional | `number?`, `id?`, `nodeId?`, `marker?`; explicit IDs must agree |
| `title/body/state` | managed | Omission leaves unchanged; body supports `remove`, title does not |
| `type/fields` | managed | Issue type and organization fields addressed by user-visible names |
| `labels/assignees` | managed | Exact array or `{op: set, value}`; incremental `{add?, remove?}` |
| `milestone` | managed | Logical ID/object/set or remove |
| `children/blockedBy/blocks/relatesTo` | managed | Nested issues and inline relationship references |

A reference-only issue may carry only `logicalId`, `management: reference` and optional `identity`, and must resolve to an existing issue. Managed issue properties omitted from the document are not cleared. Title-only adoption of existing issues requires explicit `adoptByTitle` at runtime.

# Examples

The following JSON is a complete `GithubPlanSchema` value and is validated by the test suite both against the TypeScript authoring type and through `normalizeSchema()`.

```json
{
  "repository": "attention-spa/example",
  "issues": [
    {
      "logicalId": "PARENT",
      "title": "Release",
      "labels": {
        "add": [
          "triage"
        ]
      },
      "assignees": [
        "agent-hachi"
      ],
      "children": [
        {
          "logicalId": "CHILD",
          "title": "Implement",
          "blockedBy": [
            "PARENT"
          ]
        }
      ]
    }
  ]
}
```
