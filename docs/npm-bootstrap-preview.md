# Automated first-package bootstrap — dry-run only

**Status: No npm registry staging or publication authorized.**
The owner selected **automated initial package creation** for
`@attention-spa/gh-plan` on November 22, 2026. A local/manual first
publication has been rejected. The intended **first real prerelease** is
`0.1.0-beta.1`, Git tag `v0.1.0-beta.1`, hosted OIDC **stage-only**, and
npm maintainer **2FA approval**. Existing source `package.json` remains
`private:true`, version `0.0.0`.

## Safe preview now available

From **GitHub Actions → npm bootstrap preview (no stage or publish)**,
dispatch on protected `main` with the only available version input
`0.0.0-bootstrap.0`. The job runs on GitHub-hosted `ubuntu-latest`, Node
24, with `contents:read` only, pinned official checkout/setup-node Action
SHAs, and no npm auth secret or OIDC permission.

The job validates the exact GitHub repository, manual dispatch, main ref,
commit SHA, current `private:true` manifest and version/lock parity. It
constructs an **isolated temporary package**:

| Field | Temporary fixture (NOT the real library) |
| --- | --- |
| npm name | `@attention-spa/gh-plan` |
| staged-only candidate | `0.0.0-bootstrap.0` |
| planned temporary dist-tag | `bootstrap` |
| package source | Minimal README + an entrypoint that throws |
| registry operation | **None**; `npm pack --dry-run --offline` only |

The preview verifies the exact pack contents and integrity; it automatically
removes its temporary directory. It has no registry-write operation.
Neither the root package nor the lockfile is altered. A preview success is
**not proof that npm accepted or created the package**, and does not
authorize staging.

## New #243 hosted preparation — still NO registry write

The separately reviewable [npm bootstrap stage preparation workflow](../.github/workflows/npm-bootstrap-stage.yml)
is now a **manual, read-only preflight**. This is distinct from the older offline
fixture preview and is **not a live first-package staging workflow**.

It accepts only `0.0.0-bootstrap.0` and only runs when both the dispatch
actor and triggering actor are `agent-hachi` on `refs/heads/main`.
Its [validator](../scripts/npm-bootstrap-stage.mjs) checks:

- exact repository, Actions event, workflow filename/ref, manifest/lock
  still at private `0.0.0`, and local Git HEAD matching the run's immutable SHA;
- GitHub API's current `main` SHA matches that SHA and the branch is protected;
- an unauthenticated GET of the canonical npm registry package endpoint
  returns exactly **HTTP 404**, failing closed on existing packages,
  redirects, auth failures, 429, registry errors, or network uncertainty;
- the reviewed temporary nonfunctional fixture still packs offline with only
  its expected three files, and has a SHA-512 integrity result.

GitHub authentication, when used, is only the workflow's default
`contents:read` token, supplied to the GitHub API GET; it is never sent
to the npm registry or the isolated npm pack subprocess. The job has
**no npm token, environment, `id-token:write`, tag creation, package
upload, or `npm stage publish` invocation**. A `404` now is only a
snapshot: real first staging must check package absence **again directly
before a separately authorized write**, and must fail closed if it changed.

The code includes a pure description of the *future* single allowed command,
`npm stage publish --tag bootstrap --access public --ignore-scripts`;
that command is **never executed** by this workflow or its script.
Credentials and activation of a real registry-write step remain gated by
explicit owner approval of the visible `0.0.0-stage` placeholder. No
bootstrap token or repository secret is requested until that approval.
The intended future bootstrap token requires npm **stage-only**
permission under `@attention-spa`, Bypass 2FA OFF, no org-governance
rights, shortest feasible expiry; revoke promptly after the stage.

The real first version remains a separate stage-only OIDC workflow
(`.github/workflows/npm-stage.yml` / environment `npm-stage`),
as decided by [#242](https://github.com/attention-spa/gh-plan/issues/242).
It will run from the immutable release tag, **not** this `main` preflight.

## Future fully automated first-package creation — not active

After a separate explicit authorization of the **public staging
side effect**, the proposed production sequence is:

1. **One-time npm account setup:** From the npm account owner, generate a
   short-lived **granular access token** with **Packages and scopes →
   Read and write (stage only)**, restricted to `@attention-spa`.
   **Bypass 2FA OFF**. Grant **no organization-management permission**;
   that setting does not grant scoped package publishing. Avoid broad
   package rights or IP restrictions incompatible with GitHub-hosted
   runners. Set the shortest suitable expiry. Never put the token in
   issues, code, PR output or chat.
2. Store it only as a narrowly named GitHub Actions secret (e.g.
   `NPM_BOOTSTRAP_STAGE_TOKEN`) with authorized visibility. The **separate
   not-yet-implemented** first-write workflow must run only from reviewed
   protected `main`, on an ephemeral GitHub-hosted runner, verify the
   exact bootstrap fixture/SHAs, and perform **only** `npm stage publish
   --tag bootstrap --access public`. It must not call `npm publish`,
   `npm dist-tag`, `npm trust`, or read any other npm credentials.
   Stage-only tokens also permit **dist-tag changes/deprecations**; treat
   the secret as sensitive write access despite the direct-publish
   restriction.
3. npm then creates the package and a **publicly available
   `0.0.0-stage` placeholder**, even though the temporary
   `0.0.0-bootstrap.0` tarball remains pending **and must never be
   approved as a real release**. The placeholder is a real externally
   visible side effect; do not assume it disappears automatically.
4. When `@attention-spa/gh-plan` exists, configure a separate,
   package-specific **GitHub-hosted OIDC trusted publisher** matching the
   exact reviewed **future** real-release workflow filename, GitHub repo,
   and optional environment. Allow **stage only**, not direct publish or
   dist-tag mutation. Configure it **near the first real OIDC release**:
   unvalidated bindings expire after 48 hours.
5. A different hosted job, with **no bootstrap token**, stages the real
   `0.1.0-beta.1` tarball via OIDC, exact tag/SHA, lockfile, tests,
   pack-integrity and isolated consumer validation, using explicit
   prerelease `--tag next`. npm allows multiple pending stages for one
   package, so the temporary pending bootstrap stage need not be
   rejected/reused to stage the real version.
6. **Human 2FA remains required to make the staged real version
   installable**, consistent with the previously approved stage-only
   publishing policy. A maintainer reviews the real stage's contents,
   publisher and provenance, and explicitly approves it; this is not
   a manual *first-package publish* command, and cannot be silently
   bypassed by the automation.
7. Reject the **temporary bootstrap stage** using authenticated maintainer
   2FA; verify which staged versions remain. Revoke the granular token
   in npm account settings, remove the GitHub secret, and check the
   published version, provenance, dist-tag and any residual placeholder.
   Do not assert that the temporary placeholder is automatically removed.

**Separate approval gates** still apply to creating a Git release tag,
changing the real package's `private:true`/`0.0.0` release blockers,
adding production stage workflow privileges, npm trusted-publisher
registration, staging the bootstrap (public placeholder), staging
`0.1.0-beta.1`, and final maintainer 2FA approval.

## References

- [Release gate #202](https://github.com/attention-spa/gh-plan/issues/202)
- [Publishing owner decisions #232](https://github.com/attention-spa/gh-plan/issues/232)
- [Automated-bootstrap architecture #239](https://github.com/attention-spa/gh-plan/issues/239)
- [Read-only bootstrap preview implementation #240](https://github.com/attention-spa/gh-plan/issues/240)
- [GitHub October 2, 2026: automated new-package staged creation](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)
- [npm stage command](https://docs.npmjs.com/cli/v11/commands/npm-stage/)
- [npm token capabilities](https://docs.npmjs.com/about-access-tokens/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
