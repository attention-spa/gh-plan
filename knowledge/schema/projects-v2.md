---
type: Schema Element
title: "Projects v2 schema element"
description: "Reference existing Projects v2 boards by owner and number; issue and pull-request field maps manage membership and five supported field types."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [schema, projects, rest]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:20:52.153+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://docs.github.com/en/rest/projects/items
---

## Summary

Reference existing Projects v2 boards by owner and number; issue and pull-request field maps manage membership and five supported field types.

# Schema

Define `projects: [{logicalId,owner,number}]` at the root, optionally setting `ownerType: "user"` (defaults to `"org"`). These are **references**, not declarations to create projects. `management: "managed"` and field/project definition properties are blocking unsupported input.

On a managed issue, reference-only issue or managed PR, `projects` maps each referenced project logical ID to a field-name/value map. `projects: {roadmap: {}}` requests membership without field changes. Omission does not manage membership; removal is unsupported. Values may be finite numbers or strings; invalid dates, missing field names, unknown selections and unsupported field types block the plan.

| Existing field type | Authoring value | REST project item update value |
| --- | --- | --- |
| `text` | String | String |
| `number` | Finite number | Number |
| `date` | `YYYY-MM-DD` string | Same date |
| `single_select` | Existing option name | Existing option ID |
| `iteration` | Existing iteration title | Existing iteration ID |

The planner reads referenced board metadata and fields, and lists existing items scoped to the target repository. A new item produces `project.item.add`; changed fields produce `project.item.fields.set` depending on item creation. Newly planned issue/PR content is late-bound by its create-step output. **Project creation, project-field creation, unsupported field kinds, item deletion and membership removal are deliberately not planned.** User-owned project REST endpoints may require a token class other than fine-grained tokens or GitHub App tokens.

# Examples

Complete, typechecked authoring JSON. It does **not** require a live board to validate; actual plans must resolve the existing board and its field catalog.

```json
{
  "repository": "attention-spa/example",
  "projects": [
    {
      "logicalId": "roadmap",
      "owner": "attention-spa",
      "number": 7
    }
  ],
  "issues": [
    {
      "logicalId": "task",
      "management": "reference",
      "identity": {
        "number": 42
      },
      "projects": {
        "roadmap": {
          "Status": "In Progress",
          "Effort": 3
        }
      }
    }
  ],
  "pullRequests": [
    {
      "logicalId": "review",
      "head": "feature/docs",
      "base": "main",
      "title": "Document integration",
      "projects": {
        "roadmap": {
          "Notes": "Needs review",
          "Due": "2026-12-01"
        }
      }
    }
  ]
}
```
