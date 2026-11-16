---
type: Schema Element
title: "Prune and duplicate schema element"
description: "Report orphaned gh-plan issue markers and duplicate clashes by default; opt in to reversible close or restricted GraphQL deletion."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
tags: [schema, prune, safety, issues]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:09:43.760+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/authoring-schema.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/prune-compiler.ts
  - resource: https://docs.github.com/en/graphql/reference/issues
---

## Summary

Report orphaned gh-plan issue markers and duplicate clashes by default; opt in to reversible close or restricted GraphQL deletion. See the [issue deletion safety decision](/decisions/issue-deletion-policy.md) and [pure compiler](/api/compilePruneSteps.md).

# Schema

| Root property | Allowed values | Default |
| --- | --- | --- |
| `prune` | `"report"` or `"close"` | `"report"` |
| `deleteDuplicates` | boolean; true requires `prune: "close"` | false |

A gh-plan owned orphan is an ordinary issue whose **entire standalone marker comment** (`<!-- gh-plan:logicalId -->`) is not declared among authored issue logical IDs. Reporting may recognize standalone markers later in a document, but **proposed closure or deletion requires the exact marker as the issue body's first line**. Quoted examples cannot authorize mutation. Report-only mode emits `ORPHAN_ISSUE` informational diagnostics. `prune:"close"` proposes `PATCH /issues/{number}` with `{state:"closed",state_reason:"not_planned"}` for a uniquely marked, currently open orphan; previously closed issues are left alone.

Duplicate marker collisions and issue-title collisions are reported. A **duplicate close** requires the same exact gh-plan marker on both observed issues, plus an explicitly identified and safely resolved **managed** canonical issue. Before a reversible duplicate close (`state_reason:"duplicate"`, `duplicate_issue_id` canonical REST ID), a comment on the duplicate must record the canonical URL and reason. Titles alone never authorize closing or deletion; unmarked issues, PRs, multiple-marker bodies and independently declared resources remain protected.

`deleteDuplicates:true` requests the **irreversible** GraphQL `deleteIssue` mutation for a verified duplicate, with an observed GraphQL node ID. The pure compiler can describe this only in `graphql` mode after an audit comment is proposed on the surviving canonical issue. In ordinary REST mode this request is **blocked as unsupported**. The top-level `planGithub({mode:"graphql"})` permits a **narrow, explicit exception** only when both `prune:"close"` and `deleteDuplicates:true` are set: it still performs REST GET discovery and emits an inert mixed REST-comment/GraphQL-deletion plan. All other GraphQL-mode requests block, and **no executor or GraphQL network transport is implemented**.

# Examples

This is a complete authoring document, validated against the generated JSON Schema, `normalizeSchema()`, and TypeScript in CI. The canonical issue number is illustrative and must match observed marker ownership before any close step is proposed.

```json
{
  "repository": "attention-spa/example",
  "prune": "close",
  "deleteDuplicates": false,
  "issues": [
    {
      "logicalId": "PRIMARY",
      "title": "Canonical task",
      "identity": {
        "number": 42
      }
    }
  ]
}
```
