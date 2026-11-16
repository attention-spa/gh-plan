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
