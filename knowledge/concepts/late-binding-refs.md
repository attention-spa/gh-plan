---
type: Concept
title: "Late-Binding References"
description: "Identity placeholders for requests that depend on resources not yet created."
tags: ["planning", "identity"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:12:55.558+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
---

## Summary

A request may need a GitHub `number`, `id` or `nodeId` that does not exist while planning. `PlanValueRef` represents this with an object such as `{"$ref":"A.number"}`; references may appear in nested JSON bodies and REST path fragments.

## Contract

The request consumer must list the producing step's **full ID**, for example `issue.create:A`, in its `dependsOn` array. `validatePlanStepReferences()` returns blocking diagnostics when a referenced producer is absent, ambiguous or not an explicit prerequisite.

An **external executor**, after completing the create request, can provide the identity using `PlanBindings` and substitute via `bindPlanRequest()`. Missing or invalid values throw `PlanBindingError`; no network calls occur in the binder.

## Safety

Late binding preserves a complete [request DAG](/concepts/plan-and-steps.md) without inventing issue numbers, and separates read-only planning from writes. See [deterministic output](/decisions/deterministic-output.md).
