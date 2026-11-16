import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const jsonSchema = JSON.parse(readFileSync(
  new URL("../schema/gh-plan.schema.json", import.meta.url), "utf8"));
assert.equal(jsonSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(typeof jsonSchema.$id, "string");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(jsonSchema);

function accepted(value, message) {
  assert.equal(validate(value), true, message + ": " + ajv.errorsText(validate.errors));
}
function rejected(value, message) {
  assert.equal(validate(value), false, message + " unexpectedly passed");
}

accepted({
  $schema: jsonSchema.$id,
  repository: "sample/widgets",
  labels: [{ name: "triage", color: "bbccdd" }],
  milestones: [{ logicalId: "m1", title: "Phase" }],
  issues: [{
    logicalId: "P", title: "Parent", milestone: "m1",
    labels: { add: ["triage"] },
    assignees: { add: ["agent-hachi"], remove: [] },
    fields: { Priority: { op: "set", value: ["High"] }, Estimate: { op: "remove" } },
    children: [{ logicalId: "C", title: "Child", blockedBy: ["P"] }],
  }],
  relationships: [
    { kind: "blocked_by", issue: "C", blocker: "P" },
    { kind: "relates_to", from: "C", to: "P" },
  ],
}, "nested shorthand schema");
accepted({ repository: { fullName: "sample/widgets" }, issues: [
  { logicalId: "A", labels: [], assignees: { op: "set", value: [] } },
  { logicalId: "B", management: "reference", identity: { number: 7 } },
] }, "empty set and reference schema");
accepted({ repository: "sample/widgets", relationships: [
  { kind: "parent", parent: "A", child: "B" },
  { kind: "blocks", issue: "A", blocked: "B" },
] }, "native relationship variants");

rejected({ issues: [] }, "missing repository");
rejected({ repository: "sample/widgets", issues: [{ logicalId: "A", title: { op: "remove" } }] },
  "title removal");
rejected({ repository: "sample/widgets", issues: [{ logicalId: "A",
  management: "reference", title: "Not permitted" }] }, "reference-only issue mutation");
rejected({ repository: "sample/widgets", issues: [{ logicalId: "A", labels: {} }] },
  "empty incremental label operator");
rejected({ repository: "sample/widgets", issues: [{ logicalId: "A",
  assignees: { op: "delete", value: ["alice"] } }] }, "invalid assignment operator");
rejected({ repository: "sample/widgets", relationships: [
  { kind: "related", from: "A", to: "B" }] }, "legacy relationship kind");
rejected({ repository: "sample/widgets", unexpected: true }, "unknown authoring property");

console.log("Generated draft 2020-12 schema validates authoring samples and rejects malformed shapes.");
