# Security baseline and scanner posture

**Scope:** `attention-spa/gh-plan` (public GitHub repository). **Checked:** 2026-11-17. This is a security visibility and CI policy, **not npm publication approval**. Live settings can change; reread the endpoints before subsequent release decisions.

## Current enforced baseline

- An npm v3 lockfile pins direct and transitive dev dependencies with integrity values. Both PR and trusted-main worker use `npm ci --ignore-scripts --no-audit --no-fund` (not `npm install`), and verify the manifest/lockfile did not drift.
- The **read-only GitHub-hosted Node 24 `consumer-node24` job**, triggered for both `pull_request` and `main` pushes, runs **`npm audit --package-lock-only --audit-level=moderate`** on the complete committed lock (including dev dependencies). This requests current registry advisories, fails CI on moderate-or-higher findings, and cannot update dependencies. Registry/transport failures are not silently treated as a clean audit. `--no-audit` in `npm ci` avoids the installer running a duplicate implicit audit; it does **not** suppress the explicit gate.
- Full PR contracts execute on GitHub-hosted Node 22 with `contents:read`. The hosted Node 24 audit has the same read-only permission. The trusted main-controller retains its existing narrowly scoped Actions-dispatch permission; the worker prefers `[self-hosted, Linux, trusted]` only for immutable, verified `main` commits. **No untrusted PR code or live registry scan is moved to the OCI worker.**
- The audit is a **known-advisory gate**, not proof that the code, dependencies, or registry are vulnerability-free. This live check complements, not replaces, the 2026-11-17 exact-version review and prior 0-vulnerability npm audit recorded under [#202](https://github.com/attention-spa/gh-plan/issues/202).

## Live GitHub security observations (read-only, 2026-11-17)

| Feature/API | Observed | Interpretation |
| --- | --- | --- |
| `GET /repos/attention-spa/gh-plan` `security_and_analysis` | `secret_scanning: disabled`, `secret_scanning_push_protection: disabled`, `dependabot_security_updates: disabled` | **User-facing secret scanning and push protection are not enabled**; automatic Dependabot security-update PRs disabled. GitHub may still perform separate partner/provider scanning of public content; the absent repo setting is not proof no scanning anywhere. |
| Dependabot open/dismissed alerts | Both queries returned `[]` | No listed alerts at review time; not a comprehensive dependency audit. |
| `GET /code-scanning/default-setup` | `state: not-configured`, runner type `standard`, candidate languages include TypeScript/JavaScript and Actions | GitHub CodeQL default setup is available to configure but **not enabled**. |
| `GET /code-scanning/alerts` | HTTP 404, `no analysis found` | No code-scanning analysis evidence; not “0 vulnerabilities.” |
| `GET /secret-scanning/alerts` | HTTP 404, `Secret scanning is disabled` | No GitHub user-facing secret alert evidence; not “0 leaked secrets.” |
| `GET /automated-security-fixes` | `enabled: false` | Auto-generated Dependabot security-update PRs disabled. |
| `GET /dependency-graph/sbom` | HTTP 404 | No authoritative GitHub SBOM export was obtained. A local npm lockfile is not automatically a canonical SBOM. |
| CI issue [#186](https://github.com/attention-spa/gh-plan/issues/186) | Closed, 4/4 accepted, merged [PR #208](https://github.com/attention-spa/gh-plan/pull/208) with PR/main/OCI green | Fresh-run 404 race has bounded same-ID GET retries. Other GitHub API/runner failures remain possible. |

## Recommended next controls — **not approved by this baseline**

1. **CodeQL default setup for JavaScript/TypeScript and Actions**, on the supported GitHub-hosted `standard` runner. Review resource use, query suite, default workflow/security-events behavior and PR annotations before enabling through an independently authorized repo-setting unit. GitHub documents CodeQL availability for public repositories. Prefer default setup to custom untrusted-PR token privileges; do **not** run untrusted PR code on OCI.
2. **Enable GitHub secret-scanning alerts for users** and consider **push protection** only after an owner review of feature entitlement, charges/plan limits if applicable, notification routing, bypass handling and possible organization-level policy inheritance. Public repository partner-pattern scanning may already happen independently; do not confuse that with user alerts or push prevention.
3. **Enable Dependabot security updates** only after an owner decision on bot PR volume, repository/organization settings, workflow-trigger boundaries, pinned dependency overrides and review policy. Empty Dependabot alerts **do not** prove that updates are configured. Optional `.github/dependabot.yml` scheduling for version updates is a separate decision.
4. **SBOM:** consider an explicitly generated/tested CycloneDX/SPDX artifact if required for release provenance. The 404 GitHub endpoint does not justify fabricating an SBOM. Supply-chain provenance/OIDC release configuration belongs to #202 R4 and requires publication architecture approval.
5. **Source governance:** protect `main`, require checks/reviews, constrain allowed actions/SHA pins, tag/release environments and default Action tokens only in the separately authorized **R2** unit. A security audit's presence is not a substitute for enforced branch protection.

## Release disposition

This implemented unit is **R6.1 dependency auditing + security-policy documentation**, not full code/secret-scanning activation. [Release gate #202](https://github.com/attention-spa/gh-plan/issues/202) must stay **OPEN and BLOCKED**. Leave its “Security visibility” acceptance unchecked until remaining scanning posture and explicit owner risk-acceptance/enablement are reconciled. Do not claim a publishable package because `npm audit` exits zero.

### Primary guidance

- [npm audit command reference](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
- [CodeQL for public GitHub repositories](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning)
- [GitHub secret-scanning configuration](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning)
- [Dependabot security-update configuration](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates)
