import { createGenerator } from "ts-json-schema-generator";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const source = fileURLToPath(new URL("../src/authoring-schema.ts", import.meta.url));
const tsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const output = fileURLToPath(new URL("../schema/gh-plan.schema.json", import.meta.url));

function to202012(value) {
  if (Array.isArray(value)) return value.map(to202012);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "definitions") result.$defs = to202012(entry);
      else if (key === "$ref" && typeof entry === "string")
        result.$ref = entry.replace(/^#\/definitions\//, "#/$defs/");
      else result[key] = to202012(entry);
    }
    return result;
  }
  return value;
}

const generated = createGenerator({
  path: source,
  tsconfig,
  type: "GithubPlanSchema",
  skipTypeCheck: false,
  expose: "export",
  jsDoc: "extended",
}).createSchema("GithubPlanSchema");
const { $schema: _generatorDialect, ...body } = generated;
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://raw.githubusercontent.com/attention-spa/gh-plan/main/schema/gh-plan.schema.json",
  ...to202012(body),
};
const expected = JSON.stringify(schema, null, 2) + "\n";
const mode = process.argv[2] ?? "--check";
if (mode === "--write") {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, expected, "utf8");
  console.log("Generated schema/gh-plan.schema.json.");
} else if (mode === "--print") {
  process.stdout.write(expected);
} else if (mode === "--check") {
  let actual;
  try { actual = readFileSync(output, "utf8"); } catch { actual = ""; }
  if (actual !== expected) {
    console.error("Generated schema differs from committed schema; run npm run schema:generate.");
    if (process.env.GH_PLAN_SCHEMA_BOOTSTRAP === "1") {
      for (const chunk of expected.match(/[\s\S]{1,400}/g) ?? [])
        console.log("GH_PLAN_SCHEMA_CHUNK=" + encodeURIComponent(chunk));
    }
    process.exitCode = 1;
  } else {
    console.log("Generated JSON Schema matches the checked-in artifact.");
  }
} else {
  throw new Error("Expected --check, --write, or --print.");
}
