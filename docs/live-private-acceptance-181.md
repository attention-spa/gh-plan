# M8.1.6b.4 — Private-repository B1 live acceptance (#181)

**Status:** Real four-kind GitHub API apply and zero-resource-write replay **passed** in an explicitly approved, disposable **private** repository on 2026-11-17. Historical retained-lock failure traces and current synthetic negative tests are distinguished below. This is not a public `applyPlan()` export or permission to apply a plan to production.

**Permanent evidence:** [#181 live success](https://github.com/attention-spa/gh-plan/issues/181#issuecomment-6936578455); [initial due-day/permission/allowlist failure](https://github.com/attention-spa/gh-plan/issues/181#issuecomment-6936228483); [first immediate issue readback failure](https://github.com/attention-spa/gh-plan/issues/181#issuecomment-6936315665); [sanitized catalog-indexing trace](https://github.com/attention-spa/gh-plan/issues/181#issuecomment-6936454949). Source [draft PR #200](https://github.com/attention-spa/gh-plan/pull/200), targeted test `tests/github-reference.test.ts`, and **explicitly opt-in** `scripts/github-reference-live-181.ts`.

## Live run: real A1 + B1 + C2

The workflow executed the actual internal `createGithubReferenceApplyOptions()` and `executeCallbackApplyPlan()` TypeScript implementation, **not a mock transport or manually submitted GitHub mutation sequence**, against `agent-hachi/gh-plan-acceptance-181-full-20261117`. GitHub confirmed repository `private:true`, REST ID `1460833193` and node `R_kgDOVxKLqQ`; a hardcoded exact-target guard rejected nonmatching repositories. Auth used a short-lived GitHub Actions installation `GITHUB_TOKEN` with `contents:write` and `issues:write`, pinned REST header `2026-03-10`; it did **not** use an independently validated least-privilege organizational GitHub App token. No secret values were committed or logged.

Live success workflow was [run #44005695837](https://github.com/agent-hachi/gh-plan-acceptance-181-full-20261117/actions/runs/44005695837) (**passed**). Before the run, one preexisting issue with marker `<!-- gh-plan:I2 -->` and one open milestone were seeded. The B1 plan ordered five mutations in a mixed dependency DAG:

| Ordered mutation | Observed REST result | Fresh typed postcondition |
| --- | --- | --- |
| `milestone.create` | POST 201, milestone #2 | Unique title, description empty, `due_on` UTC day 2027-01-07, stable number/ID/node |
| `issue.create` | POST 201, issue #2 | Unique `<!-- gh-plan:I -->` marker and title, initial open state, milestone `M.number=2`, stable number/ID/node |
| Dependent `issue.update` | PATCH issue #2, 200 | Closed newly created issue, original marker and milestone retained |
| Existing `issue.update` | PATCH issue #1, 200 | Closed seed issue, cleared `milestone:null`, original marker retained |
| Existing `milestone.update` | PATCH milestone #1, 200 | Description cleared, `due_on:null`, state/identity preserved |

Each mutation followed A1 CAS acquisition, mandatory fsynced audit intent, reasserted exact lock ownership, single dispatch, authoritative B1 readback, full applicable open/closed catalogs and subsequent audit acknowledgement. A1 matching-owner conditional release succeeded; independent GitHub ref GET confirmed `refs/heads/gh-plan/locks/repository` absent.

A **separate second real adapter invocation** acquired a new CAS owner and checked all five postconditions from GitHub. All steps were independently **skipped** with `already_satisfied`, **zero additional issue/milestone POST/PATCH**, and a successful second matching-owner CAS release. The first run durably acknowledged **12 audit entries**; the replay **7**. Across both runs the transport observed **168 HTTP requests**, including exact off-ref CAS owner commits/ref updates, catalog/detail GETs and precisely **five B1 resource writes**. The disposable private repository was **deleted via REST 204 and independently verified 404** after permanent issue evidence was posted; its workflow and local evidence files are no longer available.

## Resolved live API surprises

**Milestone day-of-month normalization:** GitHub's pinned API stored Jan 2 for `POST due_on=2027-01-03T00:00:00Z`. A pinned GitHub Actions test confirmed that posting **Jan 5 at 12:00 UTC** stored Jan 5 at midnight UTC; a direct private API probe confirmed the same-day behavior. For B1's canonical UTC midnight desired date, the internal reference dispatcher now emits **noon UTC on the wire only** for recognized `milestone` due-on values; the original immutable B1 predicate still requires an independent exact UTC calendar-day match. Any different stored day stops and retains owner. The transport allowlist accepts only midnight/normalized noon wire shapes; arbitrary timestamps remain outside B1. This is a compatibility adaptation based on observed GitHub behavior, not a general assurance for all GitHub API versions/timezones.

**GitHub installation-token push role hint:** With `contents:write`, `issues:write`, authenticated repository metadata reported `permissions.push:false` while a pinned-API `POST /issues` with `milestone:2` **succeeded** and the association was independently verified. The adapter therefore no longer mistakes the user-role hint for an installation token's effective endpoint permission. Missing repository permission metadata, wrong repository ID/node, denied REST calls, hidden private 404 and nonmatching writes still fail closed. Ordinary GitHub App installations may differ; least-privilege and protected ruleset behavior are **not** live-validated here.

**Immediate issue-list indexing lag:** The first live issue POST returned successfully but the B1 reader's immediate unique-marker catalog did not yet contain the issue, yielding `IssueReadError.INDETERMINATE_WRITE`. A later GET-only independent read found matching marker, fields and identities. A third disposable repo with fsynced **allowlisted diagnostic stages** confirmed the failing substage was B1 `issue.create` postwrite read, before C2 catalog/coherence. The internal adapter now retries **only** that one read failure code for `issue.create`: up to four fresh complete authenticated catalog/by-number readbacks after bounded 1, 2, 4 and 8-second waits, rechecking A1 ownership before and after every wait. Identity mismatch, duplicate marker, changed fields, 403/404, malformed page, lost owner or exhausted retries **never** authorize another POST/PATCH or a CAS release. All earlier retained-lock private test repositories were deleted intact after recording permanent evidence, **not** manually force-unlocked or reused.

## Negative-case matrix and limitations

The live run proves the complete initial DAG, A1 owner acquisition/release, B1 terminal predicates and zero-resource-write replay. Targeted deterministic fixtures are necessary for destructive/unreliable conditions that should not be deliberately induced on a shared GitHub repository:

- **Each of four B1 operation kinds:** simulate post-write drift, lost/ambiguous write reply, denied independent 403 readback, and abort while a remote write may complete; prove one mutating call max, subsequent write suppression, and owner retained if uncertain or safely released only after known terminal evidence.
- **Owner recovery/authorization:** CAS contention prevents another runner from stealing an owned lock. No TTL/lease/reaper. Abandoned owner ref cleanup requires separately attested operator stop/quiescence proof and #176 exact-OID manual recovery, not an automatic retry.
- **Static safety:** unsupported last kind, malformed nested body field, stale/noop plan, wrong repository and unresolved reference are rejected before A1 acquisition or any GitHub network call.
- **Index visibility:** temporary missing create marker permits *read-only* delayed retry, and persistent absence exhausts all reads and retains A1. No write retry, false idempotency, general create adoption or global exactly-once guarantee.

The package entrypoint `src/index.ts` remains **read-only**; `applyPlan()` is still **not exported**, and publication remains disabled. [#190](https://github.com/attention-spa/gh-plan/issues/190) is the separately authorized public callback-export gate. Nothing in #181 grants production issue/milestone write access or converts caller-provided C2 callbacks into verified GitHub authority.
