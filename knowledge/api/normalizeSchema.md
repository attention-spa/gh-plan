---
type: API
title: "normalizeSchema"
description: "Canonicalizes authored shorthands, nested resources and relationship edges."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:39:10.683+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Canonicalizes authored shorthands, nested resources and relationship edges. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
normalizeSchema(schema: object) => NormalizationResult
```

Milestone `due_on` supports a date-only `YYYY-MM-DD` shorthand, explicit set or explicit remove. Normalization checks Gregorian calendar validity, including leap years, and blocks timestamp strings, invalid dates, `null` and due-date mutations on reference-only milestones.

The normalized graph is the authoritative input to discovery, identity resolution and diff.

## I/O and failure behavior

Pure; no I/O. Invalid input yields blocking diagnostics and no graph; unknown keys warn.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
