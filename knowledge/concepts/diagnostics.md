---
type: Concept
title: "Diagnostics"
description: "Typed warnings and blockers that prevent unsafe reconciliation before execution."
tags: ["safety", "diagnostics"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:12:55.558+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
---

## Summary

A `GithubDiagnostic` contains a machine-readable `code`, a severity, a `blocking` flag and an explanatory message. Optional resource logical ID, schema path and JSON details identify the relevant input.

## Classes

- Invalid schemas, unresolved or ambiguous identities, dangling relationship references, unknown labels/assignees, and unknown issue field/type choices yield blocking diagnostics.
- Unknown **additional** authoring properties warn without blocking, preserving forward compatibility while ignoring unsupported constructs.
- REST authorization, permission, rate-limit, missing repository and malformed transport results are mapped into sanitized error diagnostics.
- Unsupported modes and operations are explicit; requesting the GraphQL planner mode currently blocks with `NO_GRAPHQL_TRANSPORT`.

Consumers should use the top-level plan `readiness`, not only individual severity strings, as the execution gate. [Plans and steps](/concepts/plan-and-steps.md) list diagnostics separately from executable candidates.

## Privacy

Runtime bearer tokens and raw error bodies must not appear in diagnostics or any serialized plan. See [no secrets in plans](/decisions/no-secrets-in-plans.md).
