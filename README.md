# gh-plan

A GitHub desired-state planner with a separate, explicitly opted-in callback application facade. `planGithub()` discovers repository state through read-only REST, resolves identity, computes semantic diffs and returns deterministic, dependency-ordered mutation requests. **Planning never executes those requests.** Optional `applyPlan()` can execute only four B1 issue/milestone operation shapes through caller-supplied callbacks; the package does not authenticate, inject GitHub credentials or validate arbitrary callback honesty.

The package currently has `"private": true` and is not published to npm.

The proposed first public npm prerelease is **`0.1.0-beta.1`**, but it is
**not yet available**. See the [draft distribution, compatibility and rollback
guidance](docs/npm-distribution.md), [unreleased changelog](CHANGELOG.md), and
[manual read-only release preflight](docs/release-preflight.md). No registry
publication, tag or trusted publisher has been authorized.

## Install and build

Requires Node.js 22 or newer. From a checkout, install the exact dependency versions and integrity hashes recorded in the committed `package-lock.json` (instead of resolving a new graph):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

## Quickstart

With `GITHUB_TOKEN` set in your environment and after building the package:

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
// Nothing is written to GitHub. Never execute steps when readiness is "blocked".
```

The separate [`applyPlan()` callback contract](knowledge/api/applyPlan.md) requires `acknowledgeCallbackTrust: true`, explicit dispatch/readback/catalog/ownership callbacks, and whole-plan B1 preflight before any write. **A type-correct callback is not proof of authenticated GitHub reads or locking.** Importing the package or calling `planGithub()` never runs `applyPlan()`; production mutations require independent authorization.

See the [authoring schema](docs/authoring-schema.md), [public contract](docs/public-contract.md), and [OKF knowledge bundle](knowledge/index.md). The JSON Schema is available at [schema/gh-plan.schema.json](schema/gh-plan.schema.json).

## Documentation maintenance

Manual installation and quickstart text above is maintained by people. The section between the markers below is generated from the ordered [OKF concepts](knowledge/concepts/index.md); **edit the knowledge source**, not that generated section.

```sh
npm run docs:readme
npm run docs:check
```

M7 and later changes must also update affected OKF pages and the [knowledge update log](knowledge/log.md) as part of their definition of done. See [documentation maintenance policy](docs/knowledge-maintenance.md).

<!-- okf:begin -->
<!-- Generated from knowledge/concepts/index.md; run npm run docs:readme. -->

## Core concepts

### [Desired State Graph](knowledge/concepts/desired-state-graph.md)

The normalized, flattened representation of desired repository resources and relationships.

The desired-state graph is the deterministic result of [normalization](knowledge/concepts/logical-id.md) of a `GithubPlanSchema` input. It is the contract passed to discovery, identity resolution and the semantic diff engine. The graph describes intent, not the state of GitHub after any mutation.

### [Logical IDs](knowledge/concepts/logical-id.md)

Stable names that identify desired resources independently of GitHub numbers or REST IDs.

A `logicalId` is the caller-defined, durable identity for a declared issue or milestone. It remains stable when GitHub assigns a different issue number, REST ID or node ID. A logical ID is used as the key for resources, relationship endpoints and [late-binding references](knowledge/concepts/late-binding-refs.md).

### [Management Modes](knowledge/concepts/management-modes.md)

Managed resources may be reconciled; reference-only resources must already exist and remain unmodified.

A declared resource defaults to `management: managed`. Managed issues, milestones and root labels may receive explicit create or update proposals. A resource marked `management: reference` is an existing identity used to link other resources; it must resolve and is not a write target.

### [Identity Resolution](knowledge/concepts/identity-resolution.md)

Safe matching from logical resources to existing GitHub identities or proposed creates.

Identity resolution maps each desired logical issue or milestone to `existing`, `new`, `unresolved` or `ambiguous`. It is pure and uses the discovered repository snapshot, not a mutation.

### [Relationships](knowledge/concepts/relationships.md)

Directed parent and dependency edges plus symmetric native related-to associations.

The graph supports four authoring forms for GitHub issue relationships:

- `parent(parent, child)` states the child belongs beneath the parent.
- `blocked_by(issue, blocker)` states that the blocker prevents the issue.
- `blocks(issue, blocked)` is the reverse spelling of `blocked_by`, normalized to the same edge.
- `relates_to(from, to)` is symmetric; endpoint order does not matter.

Inline `children`, `blockedBy`, `blocks` and `relatesTo` are canonicalized with explicit `relationships`. Duplicate symmetric edges are deduplicated; missing endpoints, cycles and invalid parent structures are rejected.

### [Plans and Steps](knowledge/concepts/plan-and-steps.md)

Deterministic read-only reconciliation proposals with dependency-ordered REST requests.

`planGithub()` performs normalization, read-only discovery and enrichment, identity resolution, semantic diffing and compilation. It returns a serializable `GithubPlan`; it **never executes** its proposed GitHub mutations.

### [Late-Binding References](knowledge/concepts/late-binding-refs.md)

Identity placeholders for requests that depend on resources not yet created.

A request may need a GitHub `number`, `id` or `nodeId` that does not exist while planning. `PlanValueRef` represents this with an object such as `{"$ref":"A.number"}`; references may appear in nested JSON bodies and REST path fragments.

### [Diagnostics](knowledge/concepts/diagnostics.md)

Typed warnings and blockers that prevent unsafe reconciliation before execution.

A `GithubDiagnostic` contains a machine-readable `code`, a severity, a `blocking` flag and an explanatory message. Optional resource logical ID, schema path and JSON details identify the relevant input.
<!-- okf:end -->
