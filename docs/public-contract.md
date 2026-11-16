# Public API contract

The public entry point is `@attention-spa/gh-plan` (`src/index.ts`).
This package **plans**, but does not execute, changes to GitHub. Its return
value contains proposed HTTP requests, identity resolutions and diagnostics.
The caller must not execute a plan whose `readiness` is `blocked`.

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

All public types and functions are documented in their TypeScript declarations,
including the distributed `dist/*.d.ts` output. This contract describes the
current v0.1 planner rather than promising an execution engine.
