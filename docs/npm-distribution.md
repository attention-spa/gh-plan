# Public npm distribution — draft, not yet released

**Status: PREPARATION ONLY.** `@attention-spa/gh-plan` is **not published
by this project**. The current repository manifest remains `private:true`,
version `0.0.0`. The planned first public npm prerelease is
**`0.1.0-beta.1`**, with intended Git tag **`v0.1.0-beta.1`**; neither a
release tag nor a publishable prerelease artifact exists yet. The npm
organization owner has confirmed control of the intended `attention-spa`
scope, but authenticated publisher-account access and 2FA remain unverified.

## Installation and requirements — after an approved release

The following command is **an example for future use only**, not a current
installation instruction. It will work only **after** `0.1.0-beta.1` is
published and verified on npm:

```sh
npm install @attention-spa/gh-plan@0.1.0-beta.1
```

Requirements: Node.js **22 or newer**; ESM entrypoint; TypeScript declarations
for NodeNext-compatible consumers. Until an approved npm release exists,
clone the [public repository](https://github.com/attention-spa/gh-plan),
install its locked dependencies with `npm ci --ignore-scripts --no-audit
--no-fund`, then run `npm test` and `npm run build`. This repository
supports `npm run test:consumer` for an actual isolated, **locally packed**
tarball; that does not publish anything.

## API: read-only planning by default

After installation, the public package exposes `planGithub()`:

```js
import { planGithub } from "@attention-spa/gh-plan";

const plan = await planGithub({
  auth: process.env.GITHUB_TOKEN ?? "",
  schema: {
    repository: "owner/repository",
    issues: [{ logicalId: "sample", title: "Example task" }],
  },
});

console.log(plan.readiness, plan.summary, plan.steps);
```

`planGithub()` discovers existing GitHub state using read-only requests and
produces a deterministic proposal. It **does not execute proposed mutations**.
Never execute a plan whose `readiness` is `blocked`.

Optional `applyPlan()` is a **separate, explicit, caller-trusted** callback
execution facade, presently limited to validated B1 issue/milestone operation
shapes. The caller must acknowledge callback trust and provide authoritative
reads/dispatch/ownership controls. The library does not authenticate those
callbacks or guarantee globally exactly-once writes. See the
[public contract](public-contract.md),
[applyPlan contract](../knowledge/api/applyPlan.md), and
[security baseline](security-baseline.md) before enabling any writes.

## Prerelease versioning and compatibility

The planned `0.1.0-beta.1` is a **pre-1.0 experimental release**.
Consumers should pin the exact prerelease version until compatibility
guarantees are explicitly documented. Public API and data shapes may change
before 1.0; there is currently **no published compatibility SLA, support
window, or stable-API guarantee**. A GitHub issue is the preferred place
for reproducible bug reports. Security-sensitive disclosures should **not**
include credentials or exploit details in a public issue; use GitHub's
private vulnerability-reporting mechanism where available, or first contact
repository maintainers privately.

The [draft changelog](../CHANGELOG.md) is a proposed release summary.
It is not a claim that the package/version is already on the registry.

## Release authorization, provenance, and approvals

The release owner chose a future **GitHub-hosted OIDC trusted publisher** with
**stage-only** npm rights (`npm stage publish`), **no direct publish rights**,
and **npm maintainer 2FA approval**.
Publishing directly or with long-lived npm tokens is not approved.

The current [read-only release preflight](release-preflight.md) already
succeeded using `ubuntu-latest`, `contents:read` only and **no** OIDC,
registry access or stage/publish command. A passing preflight is not a
releasable version: its packed tarball still contains version `0.0.0`.

A later release, **after separate authorization**, must verify exact
`package.json`/lockfile version, source SHA, immutable tag, exact npm
scope/publisher identity, archived tarball bytes and downstream consumer
tests before invoking `npm stage publish` on a hosted runner. Only the
specific approved staging workflow may eventually request
`id-token:write`; it must not be enabled in PR or OCI jobs.

**Initial-stage side effect:** staging a package that does not yet exist on
npm creates a **public `0.0.0-stage` placeholder**, even while the candidate
tarball stays hidden until approval. Newly configured npm trusted-publisher
connections must be used successfully within **two days**. Configure those
grants only during an explicitly approved first-release window.

A maintainer must independently inspect the staged package and approve it
using interactive npm **2FA** before it is published. Following approval,
verify the live npm metadata, tarball digest, source commit, and npm's
**provenance attestations** from the published package page. GitHub-hosted
trusted publishing of public npm packages from public source can generate
provenance automatically. Provenance establishes build/source origin; it
**does not prove code is secure**.

Official references: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/),
[staged publishing](https://docs.npmjs.com/staged-publishing/), and
[provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Rollback, deprecation, and security incidents

An npm release is **immutable**: an already-used package/version cannot
be overwritten, including after unpublishing. There is **no guaranteed
atomic rollback** of registry publication. If a released prerelease is
found defective:

1. Stop further staging and promotions; investigate whether credentials
   or published artifacts are compromised. Revoke/rotate genuine exposed
   credentials before closing security alerts.
2. Use npm's **deprecation notice** for the affected version with a
   concrete advisory and replacement guidance where appropriate.
3. Prepare, test, approve, stage, and release a **new** fixed version
   under the same owner approval and provenance gates; never reuse the
   affected name/version pair.
4. Treat `npm unpublish` as an exceptional, separately approved
   action subject to npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish/).
   It is not guaranteed to be available, cannot be undone, and does
   not permit reusing the same published version.
5. Preserve the incident timeline, GitHub issue, maintainer decision,
   affected versions, audit/provenance evidence, and user communication.

See [npm deprecation guidance](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/)
and the [repository's current security posture](security-baseline.md).
Do **not** assume deleting a GitHub tag or release removes a published npm
version. Any release-tag protection change is a distinct governance action.

## Current authorization boundaries

- [Release readiness gate #202](https://github.com/attention-spa/gh-plan/issues/202)
  remains blocked; R1/R2/R4 and final owner approval are outstanding.
- [Distribution and staged-publisher decisions #232](https://github.com/attention-spa/gh-plan/issues/232)
  have approved the *design*, not the actual stage or publish action.
- No owner authorization has been given to remove `private:true`, change
  the current manifest to `0.1.0-beta.1`, create a Git release tag,
  register an npm trusted publisher, stage a placeholder, or publish.
