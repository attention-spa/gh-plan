---
type: Decision
title: "No secrets in plans"
description: "Keep bearer credentials runtime-only, with sanitized diagnostics and serializable request proposals."
tags: ["security", "planning"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:13:51.663+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/rest.ts
  - resource: https://github.com/attention-spa/gh-plan/issues/6
  - resource: https://github.com/attention-spa/gh-plan/issues/23
---

## Summary

`planGithub({ auth })` uses the supplied GitHub bearer credential only to perform read-only REST requests. A `GithubPlan` is a portable description of proposed work and may be displayed, compared or saved, so it must never embed credentials.

## Decision

Transport headers may include `Authorization: Bearer`, but neither the desired schema nor the returned plan retains the token. REST failures are mapped to diagnostic codes and safe metadata without copying raw response bodies. Request specs describe method, path, and body without authentication data.

## Rationale and consequences

A plan remains suitable for code review and automation handoff without accidentally becoming a credential container. External executors must manage their own credentials and permissions. See [diagnostics](/concepts/diagnostics.md) and [plans and steps](/concepts/plan-and-steps.md).
