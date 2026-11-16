# Architecture and Safety Decisions

- [GitHub-native cooperative apply ownership](/decisions/github-native-apply-ownership.md) — Serialize participating direct/Actions apply calls with a single CAS Git ref; manual crash recovery, no lease stealing.
- [Canonical issue body markers](/decisions/markers-in-body.md) — Use unique issue-body markers as durable discovery identity, with exact matching and injection-resistant logical IDs.
- [Deterministic plan output](/decisions/deterministic-output.md) — Emit sorted semantic diffs and topologically ordered steps so identical inputs produce equivalent plans.
- [No secrets in plans](/decisions/no-secrets-in-plans.md) — Keep bearer credentials runtime-only, with sanitized diagnostics and serializable request proposals.
- [Relationship reconciliation policy](/decisions/relationship-reconciliation.md) — Reconcile managed native edges by default while allowing additive-only updates and respecting reference boundaries.
- [Issue deletion policy](/decisions/issue-deletion-policy.md) — Default to no issue deletion; permanent duplicate deletion requires an explicit GraphQL-only opt-in and verified identities.
- [Title adoption requires explicit opt-in](/decisions/title-adoption-opt-in.md) — Prevent accidental management of similarly titled issues by requiring adoptByTitle for issue-title fallback.
