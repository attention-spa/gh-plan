# Changelog

This repository has **not published an npm release**. Entries below are
preparation notes, **not evidence of an available npm version**.

## Unreleased — proposed 0.1.0-beta.1 (DRAFT)

**Status: DRAFT; not published, staged, or tagged.** The approved future
version is `0.1.0-beta.1` and the intended Git tag is
`v0.1.0-beta.1`. The current `package.json` remains `private:true`,
version `0.0.0`. Date, tag, package bytes and provenance will be recorded
only after an authorized release.

### Implemented capabilities proposed for the initial prerelease

- **Read-only GitHub desired-state planner:** `planGithub()` performs
  normalization, state discovery, identity resolution, semantic diffing,
  and deterministic ordered proposal compilation. It does not execute writes.
- **Structured GitHub planning:** issue and milestone state, identities,
  labels, assignees, repository labels, issue relationships, and supported
  pull request/project planning constructs have typed schemas and
  deterministic compilation/diagnostics.
- **Explicit optional callback application:** `applyPlan()` can execute
  a strictly limited set of issue/milestone B1 operation shapes only when
  the caller acknowledges callback trust and supplies independent
  dispatch, postcondition, and ownership behavior. The library itself
  does not authenticate arbitrary callbacks or guarantee global
  exactly-once behavior.
- **Distribution preparation:** the package has an ESM `exports` entry
  and TypeScript declarations, and the actual local tarball has been
  installed offline into an isolated Node 22/24 consumer in CI. Hosted
  CodeQL and dependency scans, protected-main PR/CI checks, and a
  **read-only** release preflight are operational.

### Limitations and release requirements

- This is a proposed **pre-1.0 experimental** release. No stable API,
  support SLA or backward-compatibility guarantee has been declared.
- Only the approved public surface is exported. The internal GitHub
  reference adapter is not a general public authenticated writer.
- The npm `@attention-spa` organization's ownership has been attested
  by the owner, but actual publishing-account rights and 2FA have
  **not** been independently verified here.
- No publishable prerelease artifact, npm stage, trusted-publisher
  binding, Git tag, npm provenance or registry entry has been created
  by this release preparation.
- Release-tag actor/protection, exact trusted workflow identity and
  first-stage authorization remain governed by
  [#202](https://github.com/attention-spa/gh-plan/issues/202) and
  [#232](https://github.com/attention-spa/gh-plan/issues/232).

See the [draft npm distribution guide](docs/npm-distribution.md),
[read-only prerelease preflight](docs/release-preflight.md),
[security baseline](docs/security-baseline.md), and
[public API contract](docs/public-contract.md).
