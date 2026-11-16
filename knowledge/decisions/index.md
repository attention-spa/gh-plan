# Architecture and Safety Decisions

- [Caller-injected public apply contract](/decisions/caller-injected-apply-contract.md) — Select callback-based applyPlan with an explicit caller trust boundary and separately verified GitHub adapters.

- [Progressive apply coverage and authoritative postconditions](/decisions/progressive-apply-postconditions.md) — Start optional apply with four narrowly verified issue and milestone operations; reject unsupported plans before any write.

- [GitHub-native cooperative apply ownership](/decisions/github-native-apply-ownership.md) — Serialize participating apply workers per target repository using a compare-and-swap Git ref; require manual abandoned-lock recovery.
- [Canonical issue body markers](/decisions/markers-in-body.md) — Use unique issue-body markers as durable discovery identity, with exact matching and injection-resistant logical IDs.
- [Deterministic plan output](/decisions/deterministic-output.md) — Emit sorted semantic diffs and topologically ordered steps so identical inputs produce equivalent plans.
- [No secrets in plans](/decisions/no-secrets-in-plans.md) — Keep bearer credentials runtime-only, with sanitized diagnostics and serializable request proposals.
- [Relationship reconciliation policy](/decisions/relationship-reconciliation.md) — Reconcile managed native edges by default while allowing additive-only updates and respecting reference boundaries.
- [Issue deletion policy](/decisions/issue-deletion-policy.md) — Default to no issue deletion; permanent duplicate deletion requires an explicit GraphQL-only opt-in and verified identities.
- [Title adoption requires explicit opt-in](/decisions/title-adoption-opt-in.md) — Prevent accidental management of similarly titled issues by requiring adoptByTitle for issue-title fallback.
