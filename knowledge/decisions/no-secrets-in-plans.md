---
type: Decision
title: "No secrets in plans"
description: "Keep bearer credentials runtime-only, with sanitized diagnostics and serializable request proposals."
tags: ["security", "planning"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T09:00:00+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/rest.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/execute-steps.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/6
  - resource: https://github.com/attention-spa/gh-plan/issues/23
---

## Summary

`planGithub({ auth })` uses the supplied GitHub bearer credential only to perform read-only REST requests. A `GithubPlan` is a portable description of proposed work and may be displayed, compared or saved, so it must never embed credentials.

## Decision

Transport headers may include `Authorization: Bearer`, but neither the desired schema nor the returned plan retains the token. REST failures are mapped to diagnostic codes and safe metadata without copying raw response bodies. Request specs describe method, path, and body without authentication data.

## Apply logs and execution failures (M8.1.4)

The internal executor records each **verified applied**, **already satisfied/skipped** or **failed** step using only its 0-based topological `stepIndex`, allowlisted `outcome` and `phase`. Optional append-only `onLog` callbacks receive these same minimal records after each resolved step or terminal failure. No raw step IDs, logical resource labels, HTTP paths, headers, request bodies, response bodies, transported error messages or runtime tokens are included. The separate `skippedStepIds` result remains available to authorized in-memory callers for precise reconciliation.

`PlanExecutionError` provides a stable error code, failed step ordinal, phase and partial secret-free log; it deliberately discards arbitrary transport exception text and never preserves that error as a cause. A failed logger stops execution rather than continuing without audit data. The caller controls durable storage of received records; the package does not ship a log database or a public executor.

## Rationale and consequences

A plan remains suitable for code review and automation handoff without accidentally becoming a credential container. External executors must manage their own credentials and permissions. See [diagnostics](/concepts/diagnostics.md) and [plans and steps](/concepts/plan-and-steps.md).
