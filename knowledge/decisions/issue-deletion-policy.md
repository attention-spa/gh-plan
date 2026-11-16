---
type: Decision
title: "Issue deletion policy"
description: "Never plan issue deletion in v0.1; deletion needs a separately authorized, explicit policy."
tags: ["deletion", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:13:51.663+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/11
  - resource: https://github.com/attention-spa/gh-plan/issues/23
---

## Summary

A desired-state document is not an implicit list of issues that should exist to the exclusion of all others. Unmentioned GitHub issues must not be deleted simply because they are absent from the schema.

## Decision

The v0.1 planner does **not** emit any `issue.delete` operation. It supports explicit managed issue state reconciliation, including closing an issue when the user supplies `state: closed`, but does not treat omitted issue declarations as a close or delete request. Reference-only issues are not mutation targets.

## Rationale and consequences

Issue deletion is irreversible in practice and can destroy discussions, audit trails and links. The future [M7.4 proposal](https://github.com/attention-spa/gh-plan/issues/36) may add explicit orphan reporting and bounded duplicate handling, but those policies are not implemented or pre-authorized by this decision. See [management modes](/concepts/management-modes.md) and [plan readiness](/concepts/plan-and-steps.md).
