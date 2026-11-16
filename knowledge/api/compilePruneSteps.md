---
type: API
title: "compilePruneSteps"
description: "Purely reports orphaned issue markers and duplicate clashes, and compiles guarded close or GraphQL-only deletion proposals."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/prune-compiler.ts
tags: [api, safety, prune, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:56:12.762+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/prune-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
  - resource: https://docs.github.com/en/rest/issues/issues
  - resource: https://docs.github.com/en/graphql/reference/issues
---

## Summary

Purely reports orphaned issue markers and duplicate clashes, and compiles guarded close or GraphQL-only deletion proposals.

## Contract

```ts
compilePruneSteps(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
  mode?: GithubPlannerMode,
): PruneCompilationResult
```

## I/O and failure behavior

**Pure.** No network calls or writes. Returns deterministic `steps`, `noops`, informational `warnings`, blocking `blockers` and explicitly `unsupported` diagnostics. Default report produces no mutations. Issue discovery already excludes PR entries; no additional HTTP GET is needed.

`prune:"close"` permits only a safely recognized canonical marker orphan close (`state_reason:not_planned`) or exact shared-marker duplicate close against an explicitly selected canonical issue. The duplicate comment step precedes the close PATCH, which carries `state_reason:duplicate` and the canonical REST ID. No step uses an issue title as authorization. Both closes are marked non-destructive and reversible.

`deleteDuplicates:true` with `mode:"rest"` blocks with `DUPLICATE_DELETION_UNSUPPORTED`; a pure GraphQL compilation request can describe `deleteIssue` only for observed duplicate node IDs after a canonical retained-audit comment. That deletion is `destructive:true` and `reversible:false`. **The public `planGithub()` entrypoint continues to block GraphQL mode** until an independently authorized transport exists; no executor is implemented.
