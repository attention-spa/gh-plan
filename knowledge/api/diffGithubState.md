---
type: API
title: "diffGithubState"
description: "Builds deterministic semantic deltas independent of request encoding."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/diff.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:39:10.683+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/diff.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

Builds deterministic semantic deltas independent of request encoding. Exported from `@attention-spa/gh-plan` via [the package entrypoint](/api/types-plan.md).

## Contract

```ts
diffGithubState(desired: NormalizedDesiredStateGraph, observed: GithubStateSnapshot, resolutions: ResourceResolution[]) => GithubDiffResult
```

For managed milestone `due_on`, the diff compares the desired UTC **calendar day** against the date represented by the observed ISO timestamp. A differing time of day within the same UTC day is a noop; an observed null is an absent deadline, while an undiscovered/malformed timestamp blocks rather than implicitly clearing.

Compilers consume this result; it contains intent but does not issue HTTP requests.

## I/O and failure behavior

Pure. Missing catalog items, unknown issue types/options or unsafe resolution produce blockers/unsupported diagnostics.

See the [planner and request DAG](/concepts/plan-and-steps.md) and [REST reference](/github/rest-discovery.md).
