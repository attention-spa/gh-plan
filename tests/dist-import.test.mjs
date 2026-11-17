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
  assert(!/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])(?:\.\.?\/[^"'\r\n]+)\.ts\1/.test(declarations),
    "Declaration imports must point to compilable .js paths: " + filename);
}

// Public API documentation is part of emitted TypeScript declarations.
const documented = {
  "types.d.ts": [
    "Runtime-only GitHub bearer token", "full step IDs", "partial",
    "A blocked plan must not be executed", "Late-bound identity placeholder",
  ],
  "authoring-schema.d.ts": [
    "Managed issue", "reference", "blocked_by", "labels", "assignees",
  ],
  "identity.d.ts": ["Precedence:", "adoptByTitle"],
  "normalize.d.ts": ["Absent property means untouched"],
  "discovery.d.ts": ["per-issue", "Transport failures"],
  "diff.d.ts": ["Pure", "No"],
  "rest.d.ts": ["four GETs", "bearer"],
  "plan.d.ts": ["read-only planner", "Request count"],
  "plan-bindings.d.ts": ["post-create", "no network"],
};
for (const [filename, keywords] of Object.entries(documented)) {
  const declaration = readFileSync(new URL(filename, dist), "utf8");
  for (const keyword of keywords) {
    assert(declaration.toLowerCase().includes(keyword.toLowerCase()),
      "Public documentation missing from " + filename + ": " + keyword);
  }
}
for (const filename of [
  "authoring-schema", "types", "identity", "normalize", "discovery", "diff",
  "rest", "plan", "plan-bindings", "issue-compiler", "issue-field-compiler",
  "issue-label-compiler", "issue-assignee-compiler", "repository-label-compiler",
  "milestone-compiler", "relationship-compiler",
]) {
  const source = readFileSync(new URL("../src/" + filename + ".ts", import.meta.url), "utf8");
  const blocks = source.match(/\/\*\*[\s\S]*?\*\//g) ?? [];
  assert(!blocks.some((block) => /(?:^|\n)\s*\*\s*@[A-Za-z]+/m.test(block)),
    "JSDoc tags are disallowed in public contract comments: " + filename);
}
console.log("Public contract comments survive declaration generation without JSDoc tags.");

// Import must never discover GitHub or run a write just because this private
// package is loaded. Explicitly fail any import-time global network attempt.
const originalFetch = globalThis.fetch;
let importNetworkCalls = 0;
globalThis.fetch = async () => {
  importNetworkCalls++;
  throw new Error("IMPORT_NETWORK_FORBIDDEN");
};
let direct, self;
try {
  direct = await import("../dist/index.js");
  self = await import("@attention-spa/gh-plan");
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(importNetworkCalls, 0, "Public imports must perform zero network calls.");
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

// #190: named C2 callback applyPlan and existing types/declarations are public.
const c2Types = readFileSync(new URL("index.d.ts", dist), "utf8");
for (const name of [
  "ApplyPlanOptions", "ApplyPlanResult", "ApplyOwnershipAdapter",
  "ApplyDispatcher", "ApplyPostconditionContext", "ApplyPostconditionRead",
  "ApplyPostconditionReader", "ApplyIssueCatalogReader",
  "ApplyMilestoneCatalogReader", "ApplyLogSink", "SafeApplyLogEntry",
  "ApplyPlanErrorCode", "ApplyPlanPhase", "ApplyOwnerState",
]) {
  assert(c2Types.includes(name), "Public type-only C2 entry missing: " + name);
}
assert.equal(typeof direct.ApplyPlanError, "function",
  "Typed sanitized C2 error class must be importable at runtime.");
assert.strictEqual(self.ApplyPlanError, direct.ApplyPlanError,
  "Package self export must agree on sanitized C2 error class.");
assert.equal(typeof direct.applyPlan, "function",
  "Dist JS must export the explicitly named caller-injected applyPlan.");
assert.strictEqual(self.applyPlan, direct.applyPlan,
  "Package self-reference must point to the same guarded callback function.");
assert.match(c2Types, /executeCallbackApplyPlan\s+as\s+applyPlan/,
  "Built declaration must bind the named public applyPlan to the tested lifecycle.");
for (const hidden of [
  "executeCallbackApplyPlan", "prepareApplyPlan",
  "createGithubReferenceApplyOptions", "createGithubReferenceHttp",
  "acquireGithubCasLock", "preflightApplyPlan",
]) {
  assert.equal(typeof direct[hidden], "undefined",
    "Internal GitHub transport/dispatcher/preflight must not be exported: " + hidden);
}
assert.deepEqual(Object.keys(packageJson.exports), ["."],
  "Deep package exports must remain blocked by a single reviewed entrypoint.");
let caught;
let invoked = 0;
try {
  await direct.applyPlan({
    plan: { readiness: "blocked", steps: [] },
    acknowledgeCallbackTrust: true,
    dispatch: async () => { invoked++; },
    readPostcondition: async () => { invoked++; },
    ownership: {
      acquire: async () => { invoked++; return { ownerId: "FAKE" }; },
      assertOwned: async () => { invoked++; return true; },
      release: async () => { invoked++; },
    },
  });
} catch (error) { caught = error; }
assert(caught instanceof direct.ApplyPlanError,
  "Built callback facade must return a sanitized typed preflight error.");
assert.equal(caught.code, "INVALID_PLAN",
  "Bad complete B1 plan must fail before consulting any callbacks.");
assert.equal(caught.phase, "preflight");
assert.equal(invoked, 0, "Invalid public plan must never acquire or mutate GitHub.");
assert.equal(typeof direct.prepareApplyPlan, "undefined",
  "Internal preflight gate must not be public.");
const c2Failure = new direct.ApplyPlanError({
  code: "INVALID_PLAN", phase: "preflight",
});
assert.equal(c2Failure.toJSON().code, "INVALID_PLAN");
assert(!JSON.stringify(c2Failure).includes("cause"),
  "Public failure JSON may not contain arbitrary error cause.");

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
  path.startsWith("src/") || path.startsWith("tests/") ||
  path.startsWith("node_modules/") || path.startsWith("scripts/")),
  "Tarball must exclude source, tests, scripts and local dependencies.");
console.log("Built ESM import, package self-reference, declarations, and pack manifest passed.");
