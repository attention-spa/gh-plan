---
type: Decision
title: "Canonical issue body markers"
description: "Use unique issue-body markers as durable discovery identity, with exact matching and injection-resistant logical IDs."
tags: ["identity", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:13:51.663+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/identity.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/13
  - resource: https://github.com/attention-spa/gh-plan/issues/20
---

## Summary

Issues created and managed by gh-plan carry a canonical body marker containing the resource's [logical ID](/concepts/logical-id.md), for example `<!-- gh-plan:A -->`. Discovery can recover that identity without relying on mutable issue titles. Custom markers are supported only with whole-token boundaries.

## Decision

Use an exact, unique marker as an issue identity signal. Restrict author-supplied logical IDs to the safe character set to prevent marker injection or ambiguous substring matches. If two issues share a marker or a marker contradicts explicit `number`, `id` or `nodeId`, produce a blocker rather than selecting one.

## Rationale and consequences

Issue titles are not unique and frequently change. Body markers make reruns and adoption decisions more stable, but require validating marker uniqueness in the observed snapshot. Explicit identity hints remain stronger than a marker; title fallback remains opt-in. See [identity resolution](/concepts/identity-resolution.md) and [title adoption](/decisions/title-adoption-opt-in.md).
