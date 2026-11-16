---
type: API
title: "compilePullRequestSteps"
description: "Pure PR create/update and reviewer planner, reusing issue-label and assignee compilers without mutation."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/pull-request-compiler.ts
tags: [api, public-contract, typescript, pull-requests]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:58:42.961+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/pull-request-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
  - resource: https://docs.github.com/en/rest/pulls/pulls
---

## Summary

Compiles managed PR declarations into REST create/update requests, reviewer requests, existing issue-label and assignee operations, semantic noops, identity resolutions and blockers.

## Contract

```ts
compilePullRequestSteps(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
  issueResolutions: ResourceResolution[],
): PullRequestCompilationResult
```

## I/O and failure behavior

**Pure.** All network discovery, relevant PR enrichment and branch comparison must already be present in `observed`. The compiler never calls HTTP or issues a merge request. Missing branches/compares, unsafe identities, merged PRs and changed existing draft status emit blocking diagnostics; attempted REST draft transitions are listed as unsupported.

For PR-specific reviewer requests, `POST`/`DELETE` `requested_reviewers` use GitHub logins, while labels/assignees reuse the [M4 endpoints](/github/rest-step-operations.md). New PRs can depend on `issue.create` steps via [late-bound string templates](/concepts/late-binding-refs.md), and downstream requests depend on `pull_request.create`.
