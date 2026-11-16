import { normalizeSchema } from "../src/index.ts";
import type { GithubPlanSchema, GithubPlannerConfig } from "../src/index.ts";

// Existing normalization shorthands are accepted by the public authoring type.
export const nestedPlan = {
  $schema: "https://raw.githubusercontent.com/attention-spa/gh-plan/main/schema/gh-plan.schema.json",
  repository: { fullName: "sample/widgets", id: 12 },
  relationshipMode: "additive",
  labels: [
    { name: "triage", color: "c0ffee" },
    { name: "reference-only", management: "reference" },
  ],
  milestones: [
    { logicalId: "m1", title: "Phase 1", description: { op: "remove" } },
    { logicalId: "m2", management: "reference", identity: { number: 2 } },
  ],
  issues: [
    {
      logicalId: "P", title: { op: "set", value: "Parent" },
      body: { op: "remove" }, milestone: { op: "set", value: { logicalId: "m1" } },
      state: "open", type: "Task",
      labels: { add: ["triage"], remove: ["wontfix"] },
      assignees: { op: "set", value: ["agent-hachi"] },
      fields: { Priority: "High", Cost: 42, Flag: true, Other: null,
        Tags: ["A", "B"], Estimate: { op: "remove" } },
      children: [
        { logicalId: "C", title: "Child", blockedBy: ["P"], relatesTo: ["P"] },
        { logicalId: "E", management: "reference", identity: { number: 10 } },
      ],
      blocks: ["C"],
    },
  ],
  relationships: [
    { kind: "parent", parent: "P", child: "C" },
    { kind: "blocked_by", issue: "C", blocker: "P" },
    { kind: "blocks", issue: "P", blocked: "C" },
    { kind: "relates_to", from: "C", to: "P" },
  ],
} satisfies GithubPlanSchema;
const config = { schema: nestedPlan, auth: "fake-token" } satisfies GithubPlannerConfig;
const result = normalizeSchema(config.schema);
if (!result.ok) throw Error(JSON.stringify(result.diagnostics));

export const minimal = { repository: "sample/widgets", issues: [{ logicalId: "A", title: "A" }] } satisfies GithubPlanSchema;
export const removeOnly = { repository: "sample/widgets", issues: [
  { logicalId: "A", assignees: { remove: ["alice"] },
    labels: { op: "set", value: [] }, milestone: { op: "remove" } },
] } satisfies GithubPlanSchema;

// Compile-time negative tests: malformed shapes cannot reach typed planGithub().
 // @ts-expect-error repository is required
const missingRepository: GithubPlanSchema = { issues: [] };
const invalidIssue: GithubPlanSchema = { repository: "sample/widgets", issues: [
  { logicalId: "A",
    // @ts-expect-error title cannot be removed
    title: { op: "remove" } },
] };
const invalidReference: GithubPlanSchema = { repository: "sample/widgets", issues: [
  // @ts-expect-error a reference-only issue cannot manage its title
  { logicalId: "A", management: "reference", title: "No" },
] };
const invalidRelationship: GithubPlanSchema = { repository: "sample/widgets", relationships: [
  // @ts-expect-error legacy related relationship is not supported
  { kind: "related", from: "A", to: "B" },
] };
const invalidLabels: GithubPlanSchema = { repository: "sample/widgets", issues: [
  { logicalId: "A",
    // @ts-expect-error an incremental label operation must include add or remove
    labels: {} },
] };
void [missingRepository, invalidIssue, invalidReference, invalidRelationship, invalidLabels];
