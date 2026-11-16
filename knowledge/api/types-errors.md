---
type: API
title: "Diagnostics and error types"
description: "GithubDiagnostic and related typed error outcomes for planning and request binding."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

GithubDiagnostic and related typed error outcomes for planning and request binding.

## Public symbols

- `GithubDiagnostic`
- `DiagnosticCode`
- `DiagnosticSeverity`
- `GithubDiff`
- `GithubDiffResult`
- `GithubDiffStatus`
- `PlanBindingError`
- `PlanBindingErrorCode`
- `GithubRestTransportError`
- `GithubRestTransportErrorCode`

## Contract boundary

Normalization and compilation report blockers. Direct bind/transport calls may throw typed errors; planners sanitize expected transport failures.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
