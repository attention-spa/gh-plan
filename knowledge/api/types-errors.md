---
type: API
title: "Diagnostics and error types"
description: "GithubDiagnostic and related typed error outcomes for planning and request binding."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:59:33.118+01:00 }
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
- `ApplyPlanError`
- `ApplyPlanErrorCode`
- `ApplyPlanPhase`
- `ApplyOwnerState`
- `ApplyPlanErrorDetails`

## Contract boundary

Prune diagnostics include informational `ORPHAN_ISSUE`, `DUPLICATE_ISSUE_MARKER` and `DUPLICATE_ISSUE_TITLE`. Unsafe canonical selection and `DUPLICATE_DELETION_UNSUPPORTED` in REST mode are blocking. A title match is never proof of issue ownership.

Normalization and compilation report blockers. Direct bind/transport calls may throw typed errors; planners sanitize expected transport failures. The separately opted-in [public `applyPlan()` callback facade](/api/applyPlan.md) throws sanitized `ApplyPlanError` values containing only stable phase/code, owner status and safe partial audit/step indices. It never includes the untrusted callback's underlying exception, remote HTTP payload, request body or token. Its caller is responsible for trustworthy GitHub reads and cooperative ownership; a type-correct callback alone proves neither.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).
