---
type: Decision
title: "Title adoption requires explicit opt-in"
description: "Prevent accidental management of similarly titled issues by requiring adoptByTitle for issue-title fallback."
tags: ["identity", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:13:51.663+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/identity.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/15
  - resource: https://github.com/attention-spa/gh-plan/issues/8
---

## Summary

Issue titles are mutable and nonunique. A managed desired-state issue with the same title as an existing issue is not automatically authorized to take control of that issue.

## Decision

Use explicit REST/node/number identities first, then unique body markers. If an existing issue matches only by normalized title, `adoptByTitle: true` must be explicitly supplied. Without it, return `TITLE_MATCH_REQUIRES_ADOPTION` with candidate issue numbers. Multiple candidate title matches remain ambiguous even with opt-in.

## Rationale and consequences

This preserves unrelated issues when an author chooses a common title. Milestones continue to use exact-title matching when necessary because they do not carry canonical issue-body markers. Users can avoid title adoption by providing explicit identities or a unique marker. See [identity resolution](/concepts/identity-resolution.md) and [body markers](/decisions/markers-in-body.md).
