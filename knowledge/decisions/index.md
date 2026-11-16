# Architecture and Safety Decisions

- [Canonical issue body markers](/decisions/markers-in-body.md) — Use unique issue-body markers as durable discovery identity, with exact matching and injection-resistant logical IDs.
- [Deterministic plan output](/decisions/deterministic-output.md) — Emit sorted semantic diffs and topologically ordered steps so identical inputs produce equivalent plans.
- [No secrets in plans](/decisions/no-secrets-in-plans.md) — Keep bearer credentials runtime-only, with sanitized diagnostics and serializable request proposals.
- [Relationship reconciliation policy](/decisions/relationship-reconciliation.md) — Reconcile managed native edges by default while allowing additive-only updates and respecting reference boundaries.
- [Issue deletion policy](/decisions/issue-deletion-policy.md) — Never plan issue deletion in v0.1; deletion needs a separately authorized, explicit policy.
- [Title adoption requires explicit opt-in](/decisions/title-adoption-opt-in.md) — Prevent accidental management of similarly titled issues by requiring adoptByTitle for issue-title fallback.
