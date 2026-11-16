---
type: Concept
title: "Management Modes"
description: "Managed resources may be reconciled; reference-only resources must already exist and remain unmodified."
tags: ["safety", "resources"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T07:00:14.448+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/normalize.ts
---

## Summary

A declared resource defaults to `management: managed`. Managed issues, milestones and root labels may receive explicit create or update proposals. A resource marked `management: reference` is an existing identity used to link other resources; it must resolve and is not a write target.

## Behavior

A managed issue may supply a title, body, state, milestone, issue type, labels, assignees and named organization fields. Only the supplied properties are reconciled. Reference-only issues and milestones cannot carry desired state, while reference-only root labels cannot manage metadata such as color or description.

The [prune/duplicate policy](/schema/prune-duplicates.md) is separate from resource management. An absent exact canonical gh-plan marker is reported, not automatically managed. Only an explicit close policy may affect a uniquely owned orphan or a safely canonicalized duplicate. Independently declared and reference-only identities remain protected.

A missing managed resource can produce a `*.create` step. A missing reference blocks safe planning with an unresolved-reference diagnostic. Relationship compilation does not take ownership of unrelated reference-only endpoints.

## Related

[Desired state](/concepts/desired-state-graph.md) records management decisions. [Identity resolution](/concepts/identity-resolution.md) distinguishes new managed resources from missing references. See [issue deletion policy](/decisions/issue-deletion-policy.md) for the default prohibition on deletion.
