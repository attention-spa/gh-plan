# Core Concepts

- [Desired State Graph](/concepts/desired-state-graph.md) — The normalized, flattened representation of desired repository resources and relationships.
- [Logical IDs](/concepts/logical-id.md) — Stable names that identify desired resources independently of GitHub numbers or REST IDs.
- [Management Modes](/concepts/management-modes.md) — Managed resources may be reconciled; reference-only resources must already exist and remain unmodified.
- [Identity Resolution](/concepts/identity-resolution.md) — Safe matching from logical resources to existing GitHub identities or proposed creates.
- [Relationships](/concepts/relationships.md) — Directed parent and dependency edges plus symmetric native related-to associations.
- [Plans and Steps](/concepts/plan-and-steps.md) — Deterministic read-only reconciliation proposals with dependency-ordered REST requests.
- [Late-Binding References](/concepts/late-binding-refs.md) — Identity placeholders for requests that depend on resources not yet created.
- [Diagnostics](/concepts/diagnostics.md) — Typed warnings and blockers that prevent unsafe reconciliation before execution.
