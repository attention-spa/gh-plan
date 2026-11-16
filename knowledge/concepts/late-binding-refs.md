---
type: Concept
title: "Late-Binding References"
description: "Identity placeholders for requests that depend on resources not yet created."
tags: ["planning", "identity"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T08:15:46+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/plan-bindings.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
---

## Summary

A request may need a GitHub `number`, `id` or `nodeId` that does not exist while planning. `PlanValueRef` represents this with an object such as `{"$ref":"A.number"}`; references may appear in nested JSON bodies and REST path fragments.

## Contract

The request consumer must list the producing step's **full ID**, for example `issue.create:A`, in its `dependsOn` array. `validatePlanStepReferences()` returns blocking diagnostics when a referenced producer is absent, ambiguous or not an explicit prerequisite.

An executor, after completing the create request, provides the identity using `PlanBindings` and substitutes via `bindPlanRequest()`. Missing or invalid values throw `PlanBindingError`; no network calls occur in the binder. The internal M8 staging `executePlanSteps()` primitive collects validated numeric IDs and optional node IDs from successful create responses. M8.1.2 also permits *skipping* a create when a mandatory fresh postcondition read finds it already satisfied; the read must then return a validated existing identity to bind dependent requests. A satisfied create without usable identity fails closed, rather than guessing IDs. This is not yet an idempotent public apply API.

## PR closing references

When a PR body contains managed `Closes #` references to issues that the same plan would create, `PlanStringTemplate` uses `{$template: [string, {$ref: "ISSUE.number"}, ...]}` to emit a body that becomes a plain string only after binding. A PR create/update request must depend on the corresponding full `issue.create:ISSUE` step. The template never embeds guessed numbers or changes human-authored copy outside the managed block.

## Projects v2 item references

`project.item.add` produces an item REST `id`. When the same plan specifies field values for that new membership, the `project.item.fields.set` PATCH path contains a `PlanValueRef` to `project-item:PROJECT:RESOURCE.id` and its dependencies include the corresponding `project.item.add` step. Adding newly planned issue or PR content also references its `number` produced by `issue.create` or `pull_request.create`.

## Safety

Late binding preserves a complete [request DAG](/concepts/plan-and-steps.md) without inventing issue numbers, and separates read-only planning from writes. See [deterministic output](/decisions/deterministic-output.md).
