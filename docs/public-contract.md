# Public API contract

The public entry point is `@attention-spa/gh-plan` (`src/index.ts`).
The [M8.1.6a ownership ADR](../knowledge/decisions/github-native-apply-ownership.md) selects a future, unimplemented repository-wide CAS Git-ref lock and manual stale-lock recovery. The [M8.1.6b progressive coverage ADR](../knowledge/decisions/progressive-apply-postconditions.md) approves only four candidate future issue/milestone operation kinds with typed verification and full-plan fail-closed preflight; this decision implements **no** postcondition reader or public writer. It does not add an executor or export, and cannot prevent writes from external non-cooperating GitHub clients. The [approved C2 caller-injected API decision](../knowledge/decisions/caller-injected-apply-contract.md) chooses a **future public callback-based** `applyPlan()` in this private package, not a built-in authenticated GitHub writer. The caller will provide `dispatch`, `readPostcondition`, create catalogs and ownership callbacks; a library cannot prove those callbacks actually verify GitHub or hold a CAS lock. A separately selectable reference GitHub adapter remains required for independently tested live safety.
This package **plans**, but does not execute, changes to GitHub. Its return
value contains proposed HTTP requests, identity resolutions and diagnostics.
The caller must not execute a plan whose `readiness` is `blocked`.

## Internal B1 capability preflight — #178 staging

The internal `src/apply-preflight.ts` builds a versioned normalized-intent manifest and exposes `preflightApplyPlan(plan)` **only to repository implementation and test code**. It statically rejects whole plans with unsupported operations, unmanaged side effects, missing intent evidence, wrong repository/method/path/field shape, bad identity/references, an invalid DAG or unresolved noops. Four issue/milestone create/update kinds are conditional; all 29 other kinds are rejected. It compiles versioned typed `ApplyPostconditionSpec` descriptors for future independently authoritative readers, not executable proof of verified GitHub state. A plan's human-readable `expectedPostconditions` does not authorize a write. This is a pure check: it does not acquire an A1 lock, call GitHub, dispatch requests, or export a public writer. Runtime live verification and the C2 public API remain blocked by their independently tested implementation leaves.

## Internal milestone postcondition verification — #179 staging

An internal, GET-only reader in src/apply-milestone-reader.ts now evaluates #178's version-1 milestone.create/update postconditions. It freshly reads the complete open/closed catalog and by-number resource for creates, or an existing milestone by number before/after update, checking identity stability, managed fields and omitted-field preservation. It rejects ambiguous exact titles, incomplete/unsafe pagination, missing REST id/node_id, unmatched response identities, invalid/missing GitHub fields, and unknown write outcomes without attempting a mutation retry. It normalizes due_on by UTC calendar day, honors explicit null clearing, and treats cleared description as an empty value.

This stage does **not** automatically wire the reader into executePlanSteps(), a C2 facade, lock acquisition or a production writer. Issue verification is independently staged in #180. A safe public execution path requires the remaining separately authorized #175, #181 and #187–#190 tasks, including a tested GitHub reference adapter.

## Internal issue postcondition verification — #180 staging

The internal GET-only issue reader consumes #178's versioned issue.create/update descriptors. It verifies unique exact marker ownership across every open/closed catalog page (excluding pull requests) and independent GET-by-number before and after a possible write. It checks REST number/id/node ID, title/body/state, milestone number or explicit null, late-bound producer numbers, and preservation of omitted update fields. A marker owner with different properties is a conflict, not permission to issue another POST. Unknown write outcomes never authorize blind retries.

This stage does not wire the reader into the public executor, acquire A1 ownership, or dispatch mutations. Both issue and milestone readers are staged internally, but #181 disposable private-repository evidence and the C2 reference adapter remain separate requirements.

## Internal A1 GitHub-native CAS ownership — #175 staging

The internal `src/github-cas-lock.ts` now implements a per-repository, cooperative Git-ref CAS primitive. An off-ref unique owner commit preserves the default-branch tree; GraphQL `updateRefs` conditionally acquires the exact `refs/heads/gh-plan/locks/repository` from a zero OID and releases only with the matching owner OID, with `force:false` and independent ref/commit readbacks. Guarded callbacks run serially under fresh ownership checks; unknown writes prohibit release and require manual recovery. GitHub's zero-OID protocol and competing owner refusals were exercised against a **disposable private test repository**. A protected ref and a least-privilege GitHub App token were not live-tested (private-plan ruleset/protection endpoints returned 403).

This is not an exported public API or a GitHub Issues writer. A1 has **cooperative-only** semantics: an ownership check and subsequent Issues REST mutation cannot be atomically fenced, and unrelated writers need not respect the ref. There is no TTL, automatic stale-lock takeover or global exactly-once guarantee. Operator recovery remains the separate [#176](https://github.com/attention-spa/gh-plan/issues/176).

## Future apply boundary — C2 approved, NOT IMPLEMENTED

The future `applyPlan()` is opt-in via explicit `acknowledgeCallbackTrust: true`, requires callback dispatch, readback and ownership inputs, and must reject the entire plan before any resource writes if a B1 kind/shape/intent is unsupported. Its result/errors will carry only typed phases, stable codes and safe audit records; cancellation is cooperative, unknown GitHub writes must not be blindly retried, and callback honesty cannot be mechanically established by the package. The public `auth` and `fetch` options previously proposed under C1 are **not** approved for C2. This is a design only; `src/index.ts` has no such export, and `planGithub()` remains read-only.

## Authoring semantics

`GithubPlanSchema` describes the input accepted by `planGithub({ schema,
auth, ... })`; see [authoring schema](authoring-schema.md) for the checked-in
draft-2020-12 JSON Schema. Resources with `management: "reference"` must
already exist and cannot carry desired changes. Managed resources can be
created or reconciled. An **omitted** managed property is not an instruction
to clear it; direct values and `{op: "set", value}` reconcile to a value,
whereas `{op: "remove"}` explicitly clears supported nullable properties.

Issue `type` and organization `fields` are authored **by display name**.
Discovery validates those names and option names before compiling requests;
unknown values block or produce unsupported diagnostics rather than guessing
REST identifiers. Issue labels and assignees accept an exact array /
`{op:"set",value:[...]}` or targeted `{add:[...],remove:[...]}`.
Targeted changes leave unmentioned entries intact. Root repository labels are
identified by case-insensitive name; creation and metadata PATCH are supported,
but repository-label renaming and deletion are not.

Identity resolution prioritizes **explicit id, nodeId and number** (all
supplied hints must identify the same resource), then a unique issue body
marker, then title fallback. Milestones can match an exact title. Managed milestone `due_on` accepts a real UTC date (`YYYY-MM-DD`), explicit set or remove. GitHub REST timestamps are compared at UTC calendar-day precision; sets emit midnight-UTC timestamps, explicit removes propose `due_on: null`, and omissions preserve the existing deadline. An issue
whose title matches but whose marker does not is **not adopted** unless
`adoptByTitle: true` is explicitly supplied. Conflicts and ambiguous matches
block planning; reference-only resources never silently become new resources.

Existing Projects v2 boards may be declared via root `projects: [{logicalId, owner, number}]`, defaulting to organization-owned boards; individual issues and PRs may assign `projects: {boardId: {FieldName: value}}`. Project item membership can be planned for reference-only issues. Existing board/field catalogs and repository-scoped items are discovered by REST. Only text, number, date, single-select and iteration fields are reconciled; root project creation or field creation is explicitly unsupported, as is removing membership. New item and newly created content identities use dependency-ordered late binding.

Issue lifecycle is report-only by default: `prune: "report"` detects canonical gh-plan markers absent from the schema and reports duplicate marker/title collisions as informational warnings without mutating issues. `prune: "close"` can propose a reversible `state_reason: not_planned` close for uniquely marked orphans and reversible duplicate closure only after explicit canonical identity and a reason/comment with canonical link. Unmarked title matches and reference-only identities remain protected. `deleteDuplicates:true` additionally requires `prune: "close"` and a GraphQL-only pure compiler; REST blocks deletion. GraphQL mode is available **only** with both explicit opt-ins, for inert deletion requests planned from REST GET snapshots; it performs no GraphQL mutations and includes no executor. No issue is actually closed or deleted by the planner.

Managed PRs use a unique open head/base pair or an explicit number; the head is immutable and changing the base requires an explicit number. New PRs require existing head/base branch refs with commits ahead of base. GitHub issue-label/assignee endpoints are reused for PRs, while reviewer requests use `requested_reviewers`. Logical `closes` references write only an isolated managed body block and use late-bound issue numbers if needed. Initial draft creation is supported, but changing draft status on an existing PR is **not** supported by REST; merging is not planned.

Relationships are normalized into native edges. `parent` points from parent
to child; `blocked_by` points from blocked issue to its blocker; `blocks`
means the reverse; and `relates_to` is symmetric. The default relationship
mode is `reconcile`; `additive` avoids removing undeclared relationships.

## Public functions and side effects

| Export | Behavior | I/O, errors, request volume |
| --- | --- | --- |
| `normalizeSchema` | Validates and canonicalizes shorthands, nested issues and edges. | **Pure.** Returns diagnostics for invalid JSON-shaped input; no requests. |
| `resolveResourceIdentities` | Matches logical resources to observed issue/milestone identities. | **Pure.** Returns ambiguity and adoption blockers; no requests. |
| `diffGithubState` | Computes deterministic desired-vs-observed deltas. | **Pure.** Returns blockers/unsupported diagnostics; no requests. |
| `compileMilestoneSteps`, `compileIssueSteps`, `compileIssueFieldSteps` | Convert explicit semantic deltas to proposed REST steps. | **Pure.** Block unsupported or unsafe identities/fields; no requests. |
| `compileIssueLabelSteps`, `compileIssueAssigneeSteps`, `compileRepositoryLabelSteps` | Compile exact or targeted label/assignee and repository-label changes. | **Pure.** Unknown catalog entries/eligibility block; no requests. |
| `compileProjectItemSteps` | Plans membership and selective field values in existing Projects v2 boards only. | **Pure.** Unknown boards/fields, unsupported kinds/options and ambiguous items block; no I/O or project/field creation. |
| `compilePruneSteps` | Reports orphaned gh-plan marker issues and duplicate clashes; under explicit policy can propose reversible REST closure or an inert GraphQL-only duplicate deletion. | **Pure.** Default report-only; invalid identities, unsupported REST deletion or missing node IDs block unsafe operations. |
| `compilePullRequestSteps` | Plans managed PR creation/partial updates, reviewer add/remove and M4 label/assignee operations. | **Pure.** Missing branch checks, ambiguous PR identity, merged PRs and existing draft toggles block. No I/O or merging. |
| `compileRelationshipSteps` | Emits native parent, dependency and related-to requests. | **Pure.** Invalid edges become blockers; no requests. |
| `requestReferences`, `validatePlanStepReferences`, `bindPlanRequest` | Inspect/create-step binding dependencies and substitute post-create identities. | **Pure.** Binding functions can throw `PlanBindingError`; validation returns diagnostics; no requests. |
| `createRestDiscoveryTransport` | Constructs a read-only GET transport; `discover` and `enrich` perform reads. | Factory performs no I/O. Its methods may throw `GithubRestTransportError`; invalid worker concurrency throws `RangeError`. |
| `discoverAndResolve` | Performs broad discovery, resolves identities, and enriches selected issues. | **Read-only I/O.** Propagates transport exceptions; its request volume depends on pagination and selected resources. |
| `planGithub` | Orchestrates normalization, discovery, resolution, diff, compilers and a sorted DAG. | **Read-only I/O.** Converts expected transport failures to blocking diagnostics; no GitHub writes or SDK needed. |

Existing Projects v2 references add conditional GETs for project metadata, field catalog and repo-filtered item list, including numeric field selectors. No projects are queried when they are omitted. Organization Projects read is needed; user project REST token compatibility differs. Project field writes are *only proposed*, never executed.

PR discovery is conditional: `/issues` provides PR candidate numbers, a filtered open head/base query selects matches, and only those candidates receive detailed `/pulls/{number}` and review-request GETs. New head/base pairs receive branch-ref and compare reads. PRs are never merged.

REST discovery normally begins with four broad GETs: repository metadata,
issues, milestones and issue types. Repositories owned by organizations add
one organization issue-field catalog GET; managed labels add a label-catalog
GET. These collections may require additional pages. Each **selected existing**
issue adds parent, blocked-by and relates-to detail GETs, plus issue-field
values when organization field definitions are available. Each distinct login
being **assigned** adds an eligibility GET (HTTP 204/404); removal-only
operations do not require eligibility. The default enrichment worker pool is
four; `enrichConcurrency` changes parallelism, not the requested data.
Network failures, invalid responses and unsafe pagination are represented
by sanitized transport errors or planner blockers, never response bodies.

`auth` is a **runtime-only bearer token** used in GET headers; it must not
be embedded in the desired schema or logged, and it is not retained in a
`GithubPlan`. `mode` defaults to `rest`. Requesting `graphql` yields the
blocking `NO_GRAPHQL_TRANSPORT` result without opening a connection.

## Plan execution boundary

A `GithubPlan` contains `resolutions`, topologically sorted `steps`,
`noops`, diagnostics, summary counts and `readiness`:

- `ready` has no blockers; `ready_with_warnings` has nonblocking warnings;
  `blocked` **must not be executed**, even if it includes proposed steps.
- `PlanStep.id` is a full operation ID such as `issue.create:A`.
  `dependsOn` lists **step IDs**, not bare resource logical IDs.
- `PlanValueRef` objects (for example `{ "$ref": "A.number" }`) represent
  issue/milestone IDs not available until a create step finishes. An external
  executor must bind those using `bindPlanRequest` and post-create IDs.
  The producer create step must be a declared prerequisite.
- `reversible: "partial"` signals that rollback cannot guarantee the
  original state, notably after resource creation. The plan itself does not
  implement rollback, transactionality or write execution.

An internal M8 staging function, `executePlanSteps(plan, dispatch, readPostcondition)`, validates the complete DAG before writes, executes in dependency order and late-binds validated identities. The **required** injected reader must make an authoritative, fresh GitHub read immediately before **each** step and compare all postconditions; the original planner snapshot is insufficient. If already satisfied, the write is skipped and recorded in `skippedStepIds`. Skipped create steps must supply observed, validated identities for future bindings. Missing readers, uncertain reads and unusable identities stop execution without proceeding to that write. Neither a GitHub-specific postcondition reader nor machine-evaluable postcondition declarations are provided yet.

M8.1.3 additionally requires a full, fresh, **all-pages** issue catalog read for every planned `issue.create`. The internal `createRestIssueCatalogReader({auth, fetch?})` implements this with read-only GitHub REST; it includes closed issues, filters out pull requests and rejects partial/malformed listings. `executePlanSteps(plan, dispatch, readPostcondition, readIssueCatalog?)` refuses to run plans containing issue creates without that reader or an equivalent full-catalog callback. It compares the compiled exact canonical/custom body marker against the complete catalog. A unique match with a satisfied postcondition and matching identity is skipped and bound; duplicate markers, missing/conflicting markers, drift or read errors stop without sending another POST. This detects a create that succeeded remotely just before a lost response when retried, but is **not** a cross-process atomic lock and cannot guarantee exactly-once writes under concurrent executors.

M8.1.4 adds mandatory **post-write verification**: after each successful dispatcher return, the executor calls the authoritative postcondition reader again. The reported state must be `satisfied` and any created identity must match the create response before a dependent step can run. Issue creates also repeat the full marker-catalog read to verify their persisted, unique identity. An inconclusive read, failed dispatch, conflicting identity or failed logger aborts subsequent steps immediately.

The internal signature is now `executePlanSteps(plan, dispatch, readPostcondition, readIssueCatalog?, onLog?)`. Its result includes `completedStepIds`, `skippedStepIds`, verified `bindings` and a minimal `log` with entries `{stepIndex, outcome, phase}` (no potentially sensitive resource names, HTTP data or arbitrary error text). The optional `onLog` sink can durably append those sanitized records as they occur. On failure, `PlanExecutionError` gives an allowlisted phase, ordinal, stable code and a partial safe log without the original exception or response body. In-memory `skippedStepIds` remain available for caller-side reconciliation.

M8.1.5 supplies a stateful synthetic integration test of the full internal execution flow. It verifies successful repeat runs perform zero writes, and that a mid-run issue creation which committed remotely but lost its reply (or whose post-write verification failed) can resume using its unique marker without creating a duplicate. Each resumed run completes only remaining unsatisfied steps, then replays with zero writes. The fixture checks fresh reads, late binding, verification, sanitizer logs and preservation of the original plan.

This staging function is deliberately **not a public package export or safe general-purpose apply API**. The GitHub-specific full-postcondition evaluator is still caller supplied, marker checks are not a cross-process uniqueness lock, and the concurrency architecture (A1) and narrowed capability policy (B1) have been approved **as designs only**; the public `applyPlan()` API choice (C), concrete readers, lock implementation and mutation dispatcher have not been implemented. Passing synthetic fixtures **does not imply safe general-purpose execution**. The read-only public planner contract is unchanged.

All public types and functions are documented in their TypeScript declarations,
including the distributed `dist/*.d.ts` output. This contract describes the
current v0.1 planner rather than promising a completed execution engine.
