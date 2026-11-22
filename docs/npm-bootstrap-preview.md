# Automated first-package bootstrap — authorized, credential-gated

**Status: The one-time first-package bootstrap stage is owner-authorized but has NOT been executed. The real prerelease and final publication remain separately gated.**
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
**not proof that npm accepted or created the package**. The later owner
approval for one bootstrap stage is recorded below; this preview alone
is never evidence of a registry write.

## #243 hosted read-only preflight — no registry write

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

The code includes a pure description of the *separately authorized* single stage command,
`npm stage publish --tag bootstrap --access public --ignore-scripts`;
that command is **never executed** by this workflow or its script.
The owner approved that one registry write on November 22, 2026,
but the read-only preflight remains incapable of performing it.
The separate write workflow still requires an **npm-issued token that can
stage** `@attention-spa/gh-plan`, which has not been configured. The owner
approved **reusing any existing npm token with that permission**, even if
it has broader scope, organization privileges, or direct-publish rights.
The workflow still executes only `npm stage publish` and never invokes
`npm publish`. Additional token privileges increase exposure if the
credential is compromised; they are **not required** for this operation.

The real first version remains a separate stage-only OIDC workflow
(`.github/workflows/npm-stage.yml` / environment `npm-stage`),
as decided by [#242](https://github.com/attention-spa/gh-plan/issues/242).
It will run from the immutable release tag, **not** this `main` preflight.

## Owner-authorized first registry stage — prepared, NOT yet executed

On November 22, 2026, the owner separately authorized the **first**
package namespace registry write, accepting that npm will immediately
publish the publicly installable `0.0.0-stage` placeholder. This is
**not** authorization to promote the nonfunctional bootstrap fixture,
publish the real `0.1.0-beta.1`, register OIDC trust, or create a Git
release tag. The isolated real-version process stays #244.

The [dedicated first-stage workflow](../.github/workflows/npm-bootstrap-first-stage.yml)
is manually dispatched, hosted on `ubuntu-latest`, Node 24, with
only `contents:read`. Its GitHub `npm-bootstrap` environment permits
deployments from **main only**, not branches/tags generally, and is
completely separate from the future `npm-stage` OIDC environment.
GitHub readback confirmed **zero environment secrets** but found the
existing **`NPMJS_TOKEN_NIKI` organization Actions secret**, added
November 22, 2026 with visibility `all`, which includes this repository.
The owner identified its source as Doppler project `attention-spa`,
config `dev` or `prd`. GitHub does not expose the token value;
the one-time workflow reads it directly in its final stage step.
**Do not create a duplicate GitHub environment secret, print the token,
or revoke the shared organization secret.** The environment's `main`-only
branch gate still applies to the job.

**Existing organization npm credential — ready for one authorized stage:**

1. **Reuse an existing npm access token** if one is available and has
   permission to stage a new package under `@attention-spa`. Do **not**
   require a narrowly scoped, newly created, stage-only token. npm tokens
   with wider scope or direct-publish permission are acceptable to this
   owner-approved first-stage operation. The command invoked is still
   **only `npm stage publish`**, never `npm publish`, but a broad token
   can grant other authority outside this workflow. Do not mistake a
   GitHub PAT or an unidentified secret for npm authentication; do not
   forward unrelated service tokens to the npm registry. If no npm
   token exists, create one on npmjs.com after authenticating to npm;
   stage-only and narrower scope remain optional rather than mandatory.
   If a token must be created, the **current npm 11 CLI** supports
   creating a granular token interactively. The command below is an
   **optional minimally privileged example**, not a requirement to
   replace an already usable npm token. Run it only in an npm-authenticated
   local terminal; it requires account password and 2FA/OTP and prints
   a secret token that must be transferred securely to step 2:

   ```sh
   npm token create --name=gh-plan-bootstrap-once --expires=1 --scopes=attention-spa --packages-and-scopes-permission=read-write-stage-only --orgs-permission=no-access --bypass-2fa=false
   ```

   The CLI route is **token provisioning, not a manual package publish**;
   it does not bypass npm authentication or 2FA. No npm session is
   available to the GitHub Raw API integration. Do not run it in a
   publicly logged CI job or paste the token into a shell command line,
   chat message, commit, or issue. For the current options, see
   [npm token create](https://docs.npmjs.com/cli/v11/commands/npm-token/).
2. The existing GitHub Actions **organization secret**
   `NPMJS_TOKEN_NIKI` is already visible to `gh-plan`. The first-stage
   workflow passes it only to the last step as
   `BOOTSTRAP_NPM_STAGE_TOKEN: ${{ secrets.NPMJS_TOKEN_NIKI }}`.
   It is **not** copied into an environment/repository secret.
   Organization-wide visibility is broader than environment-scoped
   access; that risk is inherent in the existing shared secret and is
   not extended by this change. The `npm-bootstrap` environment gates
   execution on protected `main` only.
3. Before dispatch, ensure protected `main` is the reviewed,
   green commit, the npm package is still absent, and the existing
   `NPMJS_TOKEN_NIKI` org secret remains available. GitHub secret
   metadata proves presence, **not** npm authentication or package rights. The workflow accepts only `0.0.0-bootstrap.0`,
   requires an exact **40-hex `expected_sha`** equal to that Actions
   run's checked-out SHA, and requires
   `confirm_public_placeholder=true`. It runs only when
   **`agent-hachi` is both actor and triggering actor**.
4. Dispatch **npm first-package bootstrap stage
   (OWNER-AUTHORIZED WRITE)** once on `main`. The final step repeats
   the GitHub API protected-main SHA and unauthenticated npm registry
   404 checks **immediately before** staging a vetted, isolated,
   scriptless `0.0.0-bootstrap.0` fixture through one
   `npm stage publish --tag bootstrap --access public --ignore-scripts`
   invocation. The temporary auth config has mode 0600 and is removed.
   The preliminary `git rev-parse HEAD` process gets only whitelisted
   `PATH`/`HOME` variables, **not** the npm credential or GitHub read
   token, even if either is present in the parent workflow environment.
   **Never retry an uncertain or failed write automatically.**
5. Independently verify the public `@attention-spa/gh-plan` namespace
   and `0.0.0-stage` placeholder on npmjs.com, then in the
   authenticated account's **Staged Packages** view confirm a pending
   *`0.0.0-bootstrap.0`* under tag `bootstrap`, **without approving
   it**. If the workflow fails or times out after attempting stage,
   inspect these states before any other command. No success may be
   inferred solely from an exit code or public placeholder.
6. After verified bootstrap, leave the **shared organization secret
   `NPMJS_TOKEN_NIKI` untouched**. There is **no temporary environment
   secret** to delete. Disable the one-use first-stage workflow before
   deleting the `npm-bootstrap` environment, to avoid GitHub silently
   recreating an unprotected environment if the workflow is dispatched.
   Independently verify that both are removed/disabled. Retain the
   pending bootstrap stage unapproved until separately authorized #244.
   The bootstrap stage must eventually be **rejected using authenticated
   maintainer 2FA**, not approved. A public placeholder may remain visible.

**The existing organization secret is now configured; dispatch the
owner-approved first stage exactly once only after current protected-main,
CI and registry-absence checks succeed.**
The earlier [read-only stage preflight](../.github/workflows/npm-bootstrap-stage.yml)
remains available for nonpublishing checks without any secret.
Any package already present or uncertain registry response makes
the one-write workflow fail closed. The root manifest remains
`private:true`, `0.0.0`; the only non-private object constructed is
the throw-on-import temporary fixture.

## First authorized attempt failed — read-only diagnosis

The one authorized first-stage [GitHub Actions run #44990728908](https://github.com/attention-spa/gh-plan/actions/runs/44990728908)
reached `npm stage publish`, then returned exit status **1** on
November 22, 2026. As designed, the runner **did not print npm's
untrusted stdout/stderr**, so the registry cause is unknown. Its result
was not an approval or a successful stage.

The independent [post-failure read-only preflight #44990787521](https://github.com/attention-spa/gh-plan/actions/runs/44990787521)
passed, including the public registry's HTTP 404 for
`@attention-spa/gh-plan` on the unchanged protected main commit.
That establishes the **public namespace is still absent**. Do not infer
that the shared organization npm token is valid from its presence in
GitHub Actions alone.

Use the separate [npm bootstrap authentication diagnosis](../.github/workflows/npm-bootstrap-diagnose.yml)
workflow to **only** run `npm whoami` and `npm stage list` for the
package under the existing `NPMJS_TOKEN_NIKI` organization secret.
This workflow requires `agent-hachi`, protected main with exact SHA,
the main-only `npm-bootstrap` environment, and `contents:read`.
It never stages, publishes, approves, rejects, tags, or changes npm
packages. Its script prints only safe booleans and known CLI error codes,
**never npm's raw responses or credentials**, and removes its mode-0600
temporary auth configuration. An authenticated stage listing can
independently detect a pending candidate if one exists.

**Do not dispatch the first-stage writer again automatically, even if
the public package remains absent.** First determine whether npm
authentication, permissions, CLI command or another condition caused
the one attempted write to fail; record the finding and obtain separate
authorization for any new registry-write attempt.

## Automated first-package architecture and follow-on OIDC path

The owner **already approved** the first public-placeholder staging side
effect. These are the operational and follow-on steps; authorization
is not evidence that the first stage actually ran:

1. **npm authentication:** Prefer an **existing valid npm token** that
   can stage a new `@attention-spa/gh-plan` package. No new token,
   narrow scope, stage-only restriction, Bypass-2FA setting, or shortened
   expiry is mandatory under the owner's revised authorization. If
   no compatible token exists, the npm account owner must create one
   through npm-authenticated account UI or CLI; a GitHub token cannot
   substitute. Do not send any token in issues, code, PR output or chat.
2. Consume the already-synced `NPMJS_TOKEN_NIKI` GitHub organization
   Actions secret **only in the final step** of the protected-`main`
   `npm-bootstrap` job, without duplicating its value. The workflow
   runs on an ephemeral GitHub-hosted runner, verifies exact bootstrap
   fixture/SHAs, and performs **only** `npm stage publish --tag bootstrap
   --access public`. It must not call `npm publish`, `npm dist-tag`
   or `npm trust`, or read other npm credentials. Broad npm tokens
   can directly publish and manage other packages: the workflow
   cannot limit privileges inherent in the shared token, but calls
   only the approved command.
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
   2FA; verify which staged versions remain. Check that the one-time
   bootstrap workflow was disabled and its `npm-bootstrap` environment
   deleted after #243, while the **shared `NPMJS_TOKEN_NIKI` organization
   secret remains untouched**. Inspect the real published version,
   provenance, dist-tag and any residual placeholder.
   Do not assert that the temporary placeholder is automatically removed.

**Separate approval gates** still apply to creating a Git release tag,
changing the real package's `private:true`/`0.0.0` release blockers,
adding production OIDC stage workflow privileges, npm trusted-publisher
registration, staging
`0.1.0-beta.1`, and final maintainer 2FA approval. The first temporary
bootstrap stage/public placeholder is **already approved** and the
organization-level secret is available. The actual stage has not yet been
executed; availability is not proof the token can authenticate or stage.
Do not mistake this for approval to stage the real version.

## References

- [Release gate #202](https://github.com/attention-spa/gh-plan/issues/202)
- [Publishing owner decisions #232](https://github.com/attention-spa/gh-plan/issues/232)
- [Automated-bootstrap architecture #239](https://github.com/attention-spa/gh-plan/issues/239)
- [Read-only bootstrap preview implementation #240](https://github.com/attention-spa/gh-plan/issues/240)
- [GitHub October 2, 2026: automated new-package staged creation](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)
- [npm stage command](https://docs.npmjs.com/cli/v11/commands/npm-stage/)
- [npm token capabilities](https://docs.npmjs.com/about-access-tokens/)
- [npm token CLI scoped granular creation](https://docs.npmjs.com/cli/v11/commands/npm-token/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
