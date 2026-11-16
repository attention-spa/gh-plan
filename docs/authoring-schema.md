# Typed authoring schema

`GithubPlanSchema`, exported from `@attention-spa/gh-plan`, is the public
TypeScript input contract. `src/authoring-schema.ts` is its sole source.
Use `satisfies` to check ergonomic authoring shorthands without changing
inferred literal types.

```ts
import type { GithubPlanSchema } from "@attention-spa/gh-plan";

const desired = {
  repository: "attention-spa/example",
  labels: [{ name: "triage", color: "99ccff" }],
  issues: [{
    logicalId: "M5",
    title: "Set up triage",
    labels: { add: ["triage"] },
    assignees: ["agent-hachi"],
    children: [{ logicalId: "M5-1", title: "Document the flow" }],
  }],
} satisfies GithubPlanSchema;
```

For JSON documents, use the checked-in
[`schema/gh-plan.schema.json`](../schema/gh-plan.schema.json) to enable editor
validation and completion. For example:

```json
{
  "$schema": "https://raw.githubusercontent.com/attention-spa/gh-plan/main/schema/gh-plan.schema.json",
  "repository": "attention-spa/example",
  "issues": [{ "logicalId": "A", "title": "First issue" }]
}
```

The generated schema declares JSON Schema **draft 2020-12**. The planner
accepts `$schema` as an optional string editor hint and ignores its value.
Malformed `$schema` types are rejected by normalization.

The generated schema validates *authoring shapes* (including nested issues,
relationship variants, labels, assignees, and supported shorthand forms).
Cross-resource consistency, identity resolution, live GitHub validation, and
eligibility still belong to `normalizeSchema()` and `planGithub()`. The
generated schema rejects unexpected keys; the planner intentionally retains
its nonblocking warnings for legacy unknown properties.

To change the contract, edit **only** `src/authoring-schema.ts` and regenerate:

```sh
npm run schema:generate
npm run schema:check
npm test
```

Commit the generated `schema/gh-plan.schema.json` with source changes. CI
runs `schema:check` against the checked-in artifact before tests. The package
remains `private: true` until a separate publication decision.

## Existing Projects v2 references

Root `projects` only **references** existing boards by `logicalId`, `owner`, `number` and optional `ownerType` (default `org`). An issue or PR can declare `projects: {boardId: {Status: "Doing"}}`, with an empty field map requesting membership alone. Referenced issues may declare project memberships without managing issue properties. The runtime resolves board/field metadata, maps existing select/iteration names to option IDs and emits read-only plans for membership and text/number/date/single-select/iteration values. Project/field creation and membership removal are not supported. See the [Projects v2 schema element](../knowledge/schema/projects-v2.md).

## Milestone due dates

Managed milestones accept `due_on: "YYYY-MM-DD"`, `due_on: {op: "set", value: "YYYY-MM-DD"}`, or `due_on: {op: "remove"}`. The value must be a valid UTC calendar day; timestamps, invalid dates and `null` are rejected. GitHub REST stores a full ISO timestamp, which the planner compares by UTC calendar date, ignoring differences in time within that date. A set proposes `YYYY-MM-DDT00:00:00Z`; remove proposes `due_on: null` on PATCH. Omission leaves the date unchanged. See [milestone OKF schema](../knowledge/schema/milestone.md).

## Orphan and duplicate policies

Root `prune` defaults to `"report"`, emitting only informational `ORPHAN_ISSUE` and duplicate marker/title diagnostics from the existing issue listing. Set `prune: "close"` only when intentionally planning reversible issue closure. A uniquely marked orphan receives a proposed `state_reason: "not_planned"` close; exact shared-marker duplicates additionally need an explicitly numbered/identified managed canonical issue, a reason comment and a canonical URL. Title similarity alone never authorizes a close. `deleteDuplicates: true` requires `prune: "close"` and only describes irreversible GraphQL `deleteIssue` in the pure compiler. REST mode blocks it, and full GraphQL planning remains unavailable. See [OKF pruning schema](../knowledge/schema/prune-duplicates.md) and [issue-deletion policy](../knowledge/decisions/issue-deletion-policy.md).
