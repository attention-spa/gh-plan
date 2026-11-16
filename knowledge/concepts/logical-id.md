---
type: Concept
title: "Logical IDs"
description: "Stable names that identify desired resources independently of GitHub numbers or REST IDs."
tags: ["identity", "normalization"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:12:55.558+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/identity.ts
---

## Summary

A `logicalId` is the caller-defined, durable identity for a declared issue or milestone. It remains stable when GitHub assigns a different issue number, REST ID or node ID. A logical ID is used as the key for resources, relationship endpoints and [late-binding references](/concepts/late-binding-refs.md).

## Contract

Author-supplied IDs must match `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`. Nonempty IDs must be unique across normalized resources; duplicates block normalization. Case-sensitive resource IDs are distinct.

Repository labels use a separate case-insensitive **name** identity. When a label declaration omits `logicalId`, normalization derives one from the case-folded URL-encoded label name; that synthesized identifier is not a manual input and may contain percent escapes.

## Why it matters

The [identity resolver](/concepts/identity-resolution.md) maps logical IDs to real GitHub objects after discovery. [Plan step IDs](/concepts/plan-and-steps.md) include operation kinds and logical IDs, such as `issue.create:A`, so dependency ordering does not rely on ephemeral issue numbers.
