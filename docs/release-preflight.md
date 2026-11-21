# npm prerelease preflight (no publication)

**Release preparation only.** The owner has approved public npm as the target
distribution, proposed version `0.1.0-beta.1`, intended Git tag
`v0.1.0-beta.1`, and a future **GitHub-hosted OIDC stage-only** process with
maintainer 2FA. **No npm staging or publishing has been authorized.**

## Execute the read-only preview

In the GitHub Actions tab for `attention-spa/gh-plan`, open
**npm release preflight (no publish)**, choose **Run workflow** on `main`,
and select `0.1.0-beta.1`. The only accepted input is that owner-approved
candidate. The workflow is deliberately manual rather than connected to
pushes, pull requests, tags, or releases.

The workflow validates:

1. Exact `attention-spa/gh-plan` repository, `workflow_dispatch` event,
   `refs/heads/main`, and a valid immutable commit SHA.
2. The **future proposal** `0.1.0-beta.1` / `v0.1.0-beta.1`, while the
   **actual current** manifest and lock remain at `0.0.0`.
3. The **current package remains `private:true`**, has no `publishConfig`,
   and retains the canonical GitHub source URL and intended export surface.
4. Existing schema, docs, full tests, TypeScript build, dist import,
   **real packed-tarball isolated consumer tests**, and hosted npm advisory
   audit, followed by a **local dry-run npm pack preview**.

This is not a test of the eventual `0.1.0-beta.1` tarball or of npmjs.com
account privileges. It checks the existing `0.0.0` private package and the
approved proposed release identity without creating a release artifact.

The job runs on `ubuntu-latest`, Node 24, with only
`GITHUB_TOKEN: contents:read`. It has **no `id-token:write` permission**,
npm token, publishing environment, registry credentials, or secret access.
It cannot stage a package, approve staged versions, create a Git tag, or
publish. The existing trusted OCI runner remains reserved for protected-main
CI; it never handles npm OIDC publishing.

## What is still blocked

- The owner has confirmed npm `attention-spa` **Owner**, account **2FA
  enabled**, and the **package does not yet exist**. These are owner-reported
  checks; no authenticated npm API is connected. The first package will
  require the separately gated automated stage-only token bootstrap, as
  described in the [bootstrap preview guide](npm-bootstrap-preview.md).
- Confirm the trusted release tag creator, immutable tag protection, the
  **future separate stage-only workflow filename** and optional GitHub
  environment. Do not grant an exception that makes release tags mutable.
- In a later **explicitly authorized release window**, update the package
  version and lock in one controlled PR, remove the `private` publication
  block, and use a separately approved **automated hosted first-package
  bootstrap** with a temporary stage-only npm token; then configure npm's
  exact OIDC trusted publisher and stage the **real** prerelease through
  GitHub-hosted OIDC. A maintainer still approves the real stage with 2FA.
  No bootstrap or OIDC staging is performed by this read-only preflight.

An initial `npm stage publish` can create the publicly visible
`0.0.0-stage` placeholder. It is not an invisible smoke test. Newly
created npm trusted-publisher bindings must be used successfully within
two days; **do not create a binding during exploratory checks**.
No long-lived publishing token is recommended.

A successful preflight does **not** satisfy the remaining R1/R2/R4 release
acceptance criteria, establish authenticated ownership or authorize release.

The [standalone bootstrap preview](npm-bootstrap-preview.md) is a distinct
manual dry-run with no credentials. Do **not** treat either preflight as a
registry release or an authorization for live staging.

## References

- [Release gate #202](https://github.com/attention-spa/gh-plan/issues/202)
- [Owner decisions #232](https://github.com/attention-spa/gh-plan/issues/232)
- [Read-only preflight implementation #235](https://github.com/attention-spa/gh-plan/issues/235)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
