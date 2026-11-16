---
type: API
title: "compileProjectItemSteps"
description: "Purely compiles Projects v2 item membership and supported custom-field requests against an existing observed board."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/project-item-compiler.ts
tags: [api, public-contract, projects-v2]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T06:20:52.153+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/project-item-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
  - resource: https://docs.github.com/en/rest/projects/items
---

## Summary

Purely compiles Projects v2 item membership and supported custom-field requests against an existing observed board.

## Contract

```ts
compileProjectItemSteps(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
  resolutions: ResourceResolution[],
): ProjectItemCompilationResult
```

## I/O and failure behavior

**Pure: no network or writes.** Requires previously discovered existing board references, field metadata, numeric item IDs, field values and safely resolved issue/PR identities. Returns `steps`, `noops` and `blockers` with deterministic ordering; unknown/missing boards or fields, ambiguous duplicate items, unsupported types, missing option/iteration selections and invalid values block.

The compiler emits only `POST .../projectsV2/{number}/items` (`project.item.add`) and `PATCH .../projectsV2/{number}/items/{item_id}` (`project.item.fields.set`). New item ID placeholders use the `project.item.add` producer; new issue/PR membership also depends on `issue.create` or `pull_request.create`. No projects or fields are created, removed or renamed.
