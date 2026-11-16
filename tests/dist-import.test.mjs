import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

assert.equal(packageJson.private, true, "Package must remain private pending release approval.");
assert.equal(packageJson.license, "MIT");
assert.equal(packageJson.engines.node, ">=22");
assert.equal(packageJson.types, "./dist/index.d.ts");
assert.equal(packageJson.exports["."].types, "./dist/index.d.ts");
assert.equal(packageJson.exports["."].import, "./dist/index.js");
assert.equal(packageJson.exports["."].default, "./dist/index.js");
assert.deepEqual(packageJson.files, ["dist"]);

const dist = new URL("../dist/", import.meta.url);
assert(existsSync(new URL("index.js", dist)), "Build must emit dist/index.js.");
assert(existsSync(new URL("index.d.ts", dist)), "Build must emit declaration entrypoint.");
assert(!existsSync(new URL("tests/", dist)), "Test sources must not be included in the distribution.");

const files = readdirSync(dist);
assert(files.includes("types.d.ts"), "Type declarations must be emitted for internal modules.");
assert(files.includes("plan.js"), "Runtime modules must be compiled.");
assert(!files.some((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts")),
  "Distribution must not include TypeScript sources.");
for (const filename of files.filter((entry) => entry.endsWith(".d.ts"))) {
  const declarations = readFileSync(new URL(filename, dist), "utf8");
  assert(!/from\s+["'][^"']+\.ts["']/.test(declarations),
    "Declaration imports must point to compilable .js paths: " + filename);
}

const direct = await import("../dist/index.js");
const self = await import("@attention-spa/gh-plan");
for (const name of [
  "planGithub",
  "normalizeSchema",
  "diffGithubState",
  "compileIssueSteps",
  "compileIssueLabelSteps",
  "compileIssueAssigneeSteps",
  "compileRepositoryLabelSteps",
  "createRestDiscoveryTransport",
  "bindPlanRequest",
]) {
  assert.equal(typeof direct[name], "function", "Missing built export: " + name);
  assert.strictEqual(self[name], direct[name], "Package self-export mismatch: " + name);
}
assert.equal(typeof direct.GITHUB_PLAN_VERSION, "string", "Version must remain exported.");
assert.strictEqual(self.GITHUB_PLAN_VERSION, direct.GITHUB_PLAN_VERSION);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
  cwd: root, encoding: "utf8",
});
assert.equal(packed.status, 0, "npm pack --dry-run failed: " + packed.stderr);
const [manifest] = JSON.parse(packed.stdout);
assert(manifest, "Missing package dry-run manifest.");
const included = new Set(manifest.files.map(({ path }) => path));
for (const required of ["LICENSE", "dist/index.js", "dist/index.d.ts", "package.json"]) {
  assert(included.has(required), "Published tarball would omit " + required);
}
assert(![...included].some((path) =>
  path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("node_modules/")),
  "Published tarball must exclude source, tests, and local dependencies.");
console.log("Built ESM import, package self-reference, declarations, and pack manifest passed.");
