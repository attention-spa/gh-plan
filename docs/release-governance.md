# R2.4 — Release-tag and hosted npm staging governance

**Status (2026-11-22): Enforced GitHub configuration; no release authorized.** This is a configuration and decision record for [#242](https://github.com/attention-spa/gh-plan/issues/242), not an authorization to create a tag, stage npm packages, register a trusted publisher, publish, or change the private `0.0.0` manifest.

## Decision

The owner instructed execution of the recommended policy on 2026-11-22:

- **Release tag creator:** `agent-hachi` (GitHub user ID `320293568`). Only this principal may create new matching release tags under the active creation ruleset. A future release operation must check the owner's explicit release authorization, exact package/lock version, named immutable main commit, and green required checks *before* requesting tag creation. The ruleset enforces the **actor**, not the version-to-SHA or authorization checks; these must fail closed in the future release workflow/automation.
- **Tag namespace:** Git refs matching `refs/tags/v*` (GitHub glob, not a strict SemVer validator). Future automation must require `^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$` and the specifically owner-approved candidate `v0.1.0-beta.1` for the first release. No tag is created by this policy.
- **Tag immutability:** No user or app can update or delete matching tags through ordinary Git pushes or API operations. No standing bypass is granted for the update/delete ruleset.
- **Staging environment:** `npm-stage`, custom deployment rules permitting **only tag refs with name `v*`**. It has no reviewers, wait timer, secrets, OIDC grant, or publishing workflow. GitHub environment checks are not a substitute for the future job's strict version/ref/commit assertions.
- **Approval boundary:** Ordinary PRs continue to require zero human approvals, as separately approved in #230, but must still pass the hosted required `contracts` and `consumer-node24` checks. Real npm staged versions remain subject to maintainer inspection and interactive **npm 2FA approval**. No extra GitHub reviewer is required on the `npm-stage` environment.
- **Runner and identity:** The future real version stage-only workflow is exactly `.github/workflows/npm-stage.yml` on **GitHub-hosted `ubuntu-latest`**, with Node 24 and npm >=11.15. The dedicated stage job may eventually use `contents:read` and `id-token:write`, after explicit authorization and after the first-package namespace bootstrap. Its npm trusted publisher must match GitHub owner `attention-spa`, repository `gh-plan`, workflow filename `npm-stage.yml` and environment `npm-stage` with **stage-only** npm permissions. No direct `npm publish`, npm token in the OIDC workflow, or OCI-based publisher is permitted.

## Enforced settings — independent API readback

| GitHub configuration | ID / setting | Operational effect |
| --- | --- | --- |
| [Creator ruleset](https://github.com/attention-spa/gh-plan/rules/27824821) | `27824821`, `target:tag`, `creation` rule, active; single `User:320293568` bypass | A new matching `v*` tag requires `agent-hachi`; its bypass applies **only to creation**, not modification or deletion. |
| [Immutable tag ruleset](https://github.com/attention-spa/gh-plan/rules/27824809) | `27824809`, `target:tag`, `update` + `deletion`, active, `bypass_actors:[]` | A created matching release tag cannot be rewritten or deleted by normal actors (including the creator). |
| [Hosted stage environment](https://github.com/attention-spa/gh-plan/settings/environments) | `npm-stage`; `custom_branch_policies:true` | Only the configured tag pattern `v*` is eligible to deploy. There is **no branch** deployment policy. |
| Environment ref policy | `67736547`, `type:tag`, `name:v*` | Denies staging environment deployment from `main`, PR branches, and nonmatching tag names. |
| Existing [main protection](https://github.com/attention-spa/gh-plan/rules/27459624) | `27459624`, PR + two app-pinned hosted checks, no bypass | **Unchanged.** OCI-first trusted-main CI, GitHub-hosted PR jobs, CodeQL, read-only default `GITHUB_TOKEN`, and existing workflow permissions remain untouched. |

GitHub Free public repositories support tag rulesets and deployment environments. GitHub administrators can still modify or disable the rulesets as a separate auditable settings action; this is **not** a normal bypass of the active rules. GitHub environment administrator-bypass capability is distinct and should not be misrepresented as a proof of immutable publishing access.

## Creation and recovery procedure — future release only

1. Require separate owner authorization for the actual release, including manifest/version change, tag creation, bootstrap npm public placeholder, stage and 2FA. Check the proposed tagged SHA equals the exact reviewed immutable `main` head, that required hosted checks succeeded on it, and that the tag does not exist. Do not create a tag from an arbitrary branch or unreviewed commit.
2. Use only `agent-hachi` to create the approved tag once; separately retrieve and compare the tag's target object/SHA. If creation returns a conflict, re-read and **fail closed** rather than deleting, moving or overwriting a tag.
3. Dispatch the separately approved hosted `npm-stage.yml` workflow **on the validated tag ref**, not on `main`, so it is eligible for the environment allowlist. Repeat exact repo, ref, tag, SHA, manifest/lock, pack digest and consumer assertions in the job; the `v*` glob alone is insufficient.
4. If the tag points to the wrong commit, **do not rewrite or delete it** or switch off the immutable rules. Stop staging and obtain an explicit owner-governed incident/recovery decision (typically prepare a new version/tag after correcting source). Never reuse a published npm version.
5. After npm's separately authorized stage-only OIDC publication is fully proven, validate registry version/integrity/provenance and clear the temporary bootstrap stage and token through the separately authorized cleanup. Do not claim provenance before it exists.

## Evidence and limits

The two rulesets and the environment/ref policy were each created through authenticated GitHub REST and independently **GET-read back**. Their conditions, active status, actor-specific creation bypass, and no-bypass modification/deletion semantics match the intended configuration.

**Real GitHub behavior proven in a disposable public organization repository** (`attention-spa/gh-plan-r2-4-acceptance-20261122`, since deleted) with the same two rulesets applied to `refs/tags/v*`:

1. Creation of `v0.0.0-r2-test` at `45f773004510ae63498031590a210d58dfc6eb7a` by the other organization owner (`dddominikk`) returned **HTTP 422** and did not create the ref.
2. The matching creation by authorized `agent-hachi` returned **HTTP 201** and the expected exact target SHA.
3. After a different commit `fe804cb29264f7a522401dcbad2f2af30896b1f7` existed, **forced tag update attempts by both accounts returned HTTP 422** with GitHub's `Cannot update this protected ref` ruleset rejection.
4. The `agent-hachi` deletion attempt returned **HTTP 422** (`Cannot delete this tag`); independent tag GET remained at the original SHA.
5. The disposable repository itself was deleted (**HTTP 204**), and independent GET returned **404**. The production `gh-plan` repository was **not used** for these ref mutations.

This verifies creation, nonrewrite and nondeletion behavior with live GitHub enforcement without compromising real release-tag immutability. The production repository still has **zero Git tags and zero GitHub releases**, and no npm staging/publishing occurred. The future workflow and npm OIDC binding are not yet implemented.

See [#239](https://github.com/attention-spa/gh-plan/issues/239), [#243](https://github.com/attention-spa/gh-plan/issues/243), [#244](https://github.com/attention-spa/gh-plan/issues/244), and the [blocked release gate #202](https://github.com/attention-spa/gh-plan/issues/202).
