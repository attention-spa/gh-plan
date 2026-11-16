import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { normalizeSchema } from "../src/normalize.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const schemaNames = ["repository", "issue", "milestone", "label", "relationship", "set-remove-operations","pull-request","projects-v2"];
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(
  readFileSync(join(repo, "schema/gh-plan.schema.json"), "utf8")
));
const examples = [];
for (const slug of schemaNames) {
  const body = readFileSync(join(repo, "knowledge/schema", slug + ".md"), "utf8");
  assert(/^# Schema$/m.test(body), "Schema heading missing: " + slug);
  assert(/^# Examples$/m.test(body), "Examples heading missing: " + slug);
  const matches = [...body.matchAll(/\x60{3}json\s*\r?\n([\s\S]*?)\r?\n\x60{3}/g)];
  assert.equal(matches.length, 1, "Each schema page must have one valid full JSON example: " + slug);
  const example = JSON.parse(matches[0][1]);
  assert(validate(example), slug + " violates generated JSON Schema: " +
    JSON.stringify(validate.errors));
  const normalized = normalizeSchema(example);
  assert(normalized.ok && normalized.graph, slug + " must normalize: " +
    JSON.stringify(normalized.diagnostics));
  assert.equal(normalized.graph.repository.fullName, "attention-spa/example");
  examples.push({ slug, example });
}

// Compile the *exact* JSON examples from markdown into a virtual TS module.
// No duplicated fixtures or changes to the working tree are required.
const configPath = join(repo, "tsconfig.json");
const parsedFile = ts.readConfigFile(configPath, ts.sys.readFile);
assert(!parsedFile.error, "Could not read TypeScript config.");
const parsed = ts.parseJsonConfigFileContent(parsedFile.config, ts.sys, repo);
assert.equal(parsed.errors.length, 0, "Invalid repository TypeScript config.");
const virtualPath = resolve(join(repo, "tests/__okf_schema_examples.typecheck.ts"));
const virtualSource = 'import type { GithubPlanSchema } from "../src/authoring-schema.ts";\n' +
  examples.map(({ slug, example }, index) =>
    "// " + slug + "\nconst example" + index + " = " +
    JSON.stringify(example, null, 2) + " satisfies GithubPlanSchema;\nvoid example" + index + ";"
  ).join("\n");
const host = ts.createCompilerHost(parsed.options);
const oldFileExists = host.fileExists.bind(host);
const oldReadFile = host.readFile.bind(host);
const oldGetSourceFile = host.getSourceFile.bind(host);
const isVirtual = (filename) => resolve(filename) === virtualPath;
host.fileExists = (filename) => isVirtual(filename) || oldFileExists(filename);
host.readFile = (filename) => isVirtual(filename) ? virtualSource : oldReadFile(filename);
host.getSourceFile = (filename, languageVersion, onError, fresh) =>
  isVirtual(filename) ?
    ts.createSourceFile(filename, virtualSource, languageVersion, true, ts.ScriptKind.TS) :
    oldGetSourceFile(filename, languageVersion, onError, fresh);
const program = ts.createProgram({ rootNames: [virtualPath], options: parsed.options, host });
const errors = ts.getPreEmitDiagnostics(program);
assert.equal(errors.length, 0, "Documented JSON examples fail TypeScript authoring type:\n" +
  errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));

// Each exported runtime function has its own source-linked API reference.
const functions = [
  "planGithub", "normalizeSchema", "resolveResourceIdentities", "discoverAndResolve",
  "createRestDiscoveryTransport", "diffGithubState", "compileMilestoneSteps",
  "compileIssueSteps", "compileIssueFieldSteps", "compileIssueLabelSteps",
  "compileIssueAssigneeSteps", "compileRepositoryLabelSteps",
  "compileRelationshipSteps", "compilePullRequestSteps", "compileProjectItemSteps", "requestReferences", "validatePlanStepReferences",
  "bindPlanRequest",
];
const entrypoint = readFileSync(join(repo, "src/index.ts"), "utf8");
for (const symbol of functions) {
  assert(new RegExp("\\b" + symbol + "\\b").test(entrypoint),
    "Public function missing from package exports: " + symbol);
  const body = readFileSync(join(repo, "knowledge/api", symbol + ".md"), "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  assert(fm, "API file needs frontmatter: " + symbol);
  const meta = YAML.parse(fm[1]);
  assert.equal(meta.type, "API");
  const srcPath = meta.resource?.match(/\/blob\/main\/(src\/[a-z-]+\.ts)$/)?.[1];
  assert(srcPath, "API resource must point to a specific TypeScript source: " + symbol);
  const source = readFileSync(join(repo, srcPath), "utf8");
  assert(new RegExp("\\bexport\\s+(?:async\\s+)?function\\s+" + symbol + "\\b").test(source),
    "Canonical API source does not export " + symbol);
  assert(body.includes("## I/O and failure behavior"),
    "Each callable API needs an I/O/error contract: " + symbol);
}
const typeGroups = ["types-authoring", "types-state", "types-plan", "types-errors", "types-transport"];
for (const group of typeGroups) {
  const doc = readFileSync(join(repo, "knowledge/api", group + ".md"), "utf8");
  assert(doc.includes("type: API") && doc.includes("/blob/main/src/"),
    "Type-group API page must link source: " + group);
}

// Every declared PlanOperationKind needs a REST mapping or explicit explanation
// that it is a semantic-only/reserved kind without an endpoint.
const kindsSource = readFileSync(join(repo, "src/types.ts"), "utf8");
const operationUnion = kindsSource.split("export type PlanOperationKind =")[1]
  ?.split("export type HttpMethod")[0];
assert(operationUnion, "PlanOperationKind declaration not found.");
const kinds = [...operationUnion.matchAll(/\|\s*"([^"]+)"/g)].map((x) => x[1]);
const rest = readFileSync(join(repo, "knowledge/github/rest-step-operations.md"), "utf8");
for (const kind of kinds) {
  assert(rest.includes(kind), "REST plan operations reference omits " + kind);
}
assert(rest.includes("Issues: write") && rest.includes("issue.parent.set"),
  "REST permissions and parent mappings must be explicit.");
const permissions = readFileSync(join(repo, "knowledge/github/token-permissions.md"), "utf8");
for (const required of ["Metadata: read", "Issues: read", "Issues: write",
  "Organization Issue Fields: read"]) {
  assert(permissions.includes(required), "Missing documented token permission: " + required);
}
console.log("Eight OKF examples passed JSON Schema, normalization and TypeScript checks; public exports/REST maps verified.");
