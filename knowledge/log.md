# Knowledge Update Log

## 2026-11-16

- **M6.2 reference expansion ([#31](https://github.com/attention-spa/gh-plan/issues/31))**: Added six [schema-element pages](/schema/index.md) with tested authoring examples, 21 [public API pages](/api/index.md) with source paths, and three [REST reference pages](/github/index.md) mapping verified GitHub API documentation to planned operations and token permissions. Extended conformance tests without changing planner behavior.
- **Creation (M6.1, [#30](https://github.com/attention-spa/gh-plan/issues/30))**: Established the OKF v0.2 [bundle](/index.md), [overview](/overview.md), [concepts](/concepts/index.md) and [decisions](/decisions/index.md). All new concept documents begin in draft status with agent provenance.
- **M5 packaging and contract ([#27](https://github.com/attention-spa/gh-plan/issues/27), [#28](https://github.com/attention-spa/gh-plan/issues/28), [#29](https://github.com/attention-spa/gh-plan/issues/29))**: Added a private MIT-licensed ESM build with declarations, typed authoring input and generated JSON Schema, and documented public API semantics.
- **M4 optional label/assignee handling ([#24](https://github.com/attention-spa/gh-plan/issues/24), [#25](https://github.com/attention-spa/gh-plan/issues/25), [#26](https://github.com/attention-spa/gh-plan/issues/26))**: Implemented issue-label and assignee reconciliation and managed repository labels without implicit label deletion.
- **M3 plan compiler ([#18](https://github.com/attention-spa/gh-plan/issues/18)–[#23](https://github.com/attention-spa/gh-plan/issues/23))**: Added late-bound references, milestone/issue/field/relationship request compilers and read-only `planGithub()` orchestration.
- **M2 discovery ([#17](https://github.com/attention-spa/gh-plan/issues/17))**: Added two-phase targeted REST enrichment with bounded concurrency.
- **M1 safety ([#12](https://github.com/attention-spa/gh-plan/issues/12)–[#16](https://github.com/attention-spa/gh-plan/issues/16))**: Normalized native `relates_to`, strengthened marker/logical-ID matching, made unknown properties warnings, required explicit title adoption, and tolerated optional issue-type discovery.

## 2026-11-13

- **Planning ([#11](https://github.com/attention-spa/gh-plan/issues/11))**: Recorded the v0.1→v0.2 implementation roadmap and dependencies for M1–M8.

## 2026-10-20

- **Contracts ([#2](https://github.com/attention-spa/gh-plan/issues/2), [#3](https://github.com/attention-spa/gh-plan/issues/3))**: Defined the first public planner and normalized TypeScript contracts.
- **Normalization ([#4](https://github.com/attention-spa/gh-plan/issues/4), [#5](https://github.com/attention-spa/gh-plan/issues/5))**: Added pure schema validation, nested issue flattening and canonical desired-state representation.
- **REST discovery ([#6](https://github.com/attention-spa/gh-plan/issues/6), [#7](https://github.com/attention-spa/gh-plan/issues/7))**: Implemented authenticated, paginated and read-only GitHub discovery.
- **Identity ([#8](https://github.com/attention-spa/gh-plan/issues/8), [#9](https://github.com/attention-spa/gh-plan/issues/9))**: Added pure matching of desired logical resources against observed GitHub identities.
