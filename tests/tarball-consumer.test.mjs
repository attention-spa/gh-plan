import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(metadata.private, true, "No npm publication is authorized.");
assert.equal(metadata.name, "@attention-spa/gh-plan");
assert.equal(metadata.version, "0.0.0", "Initial prerelease version is not approved.");
assert.equal(metadata.publishConfig, undefined, "No npm access/publishing config approved.");
const expectedRepository = {
  type: "git",
  url: "git+https://github.com/attention-spa/gh-plan.git",
};
const expectedHomepage = "https://github.com/attention-spa/gh-plan#readme";
const expectedBugs = { url: "https://github.com/attention-spa/gh-plan/issues" };
assert.deepEqual(metadata.repository, expectedRepository,
  "Source repository identity must match the future npm trusted publisher.");
assert.equal(metadata.homepage, expectedHomepage);
assert.deepEqual(metadata.bugs, expectedBugs);
assert.deepEqual(Object.keys(metadata.exports), ["."]);

const temp = mkdtempSync(join(tmpdir(), "gh-plan-packed-consumer-"));
const consumer = join(temp, "consumer");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, npm_config_userconfig: join(temp, "empty.npmrc"),
  npm_config_cache: join(temp, "cache"), npm_config_update_notifier: "false" };
// Never forward workflow tokens or registry secrets to an isolated consumer.
for (const key of Object.keys(env)) {
  if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|AUTH|KEY)(?:$|_)/i.test(key))
    delete env[key];
}
function run(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
  });
  assert.equal(result.status, 0,
    [binary, ...args].join(" ") + " failed (" + result.status + "): " +
    (result.stderr || result.stdout || result.error?.message || "").slice(-4000));
  return result.stdout;
}

try {
  mkdirSync(consumer);
  writeFileSync(env.npm_config_userconfig, "");
  const [packed] = JSON.parse(run(npm, [
    "pack", "--json", "--ignore-scripts", "--pack-destination", temp,
  ], root));
  assert(packed && typeof packed.filename === "string");
  assert.equal(basename(packed.filename), packed.filename,
    "The pack filename must not escape the isolated directory.");
  const tarball = resolve(temp, packed.filename);
  assert.equal(tarball, join(temp, packed.filename));
  assert(existsSync(tarball), "npm pack did not create an installable archive.");
  const bytes = readFileSync(tarball);
  assert(bytes.length > 0 && bytes.length < 10 * 1024 * 1024,
    "Package archive size is missing or unexpectedly large.");
  assert.equal(packed.size, bytes.length, "Tarball manifest size differs from bytes.");
  assert.equal(packed.integrity, "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    "Reported package digest must match the actual packed bytes.");
  const included = new Set(packed.files.map((file) => file.path));
  for (const path of ["LICENSE", "package.json", "dist/index.js", "dist/index.d.ts"])
    assert(included.has(path), "Packed consumer lacks " + path);
  assert(![...included].some((path) =>
    /^(?:src|tests|scripts|node_modules|\.github)\//.test(path)),
  "Published archive would include private source, tests, scripts or local dependencies.");

  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "gh-plan-isolated-consumer", version: "0.0.0", private: true, type: "module",
  }, null, 2) + "\n");
  // Offline install of the actual local tarball: no registry read, git checkout
  // import, npm lifecycle execution, or root workspace self-reference.
  run(npm, ["install", "--offline", "--no-save", "--no-package-lock",
    "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  const installed = join(consumer, "node_modules", "@attention-spa", "gh-plan");
  assert(existsSync(join(installed, "dist/index.js")));
  const installedMetadata = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedMetadata.name, metadata.name);
  assert.equal(installedMetadata.version, metadata.version);
  assert.equal(installedMetadata.private, true, "Packed artifact must remain release-blocked.");
  assert.equal(installedMetadata.publishConfig, undefined);
  assert.deepEqual(installedMetadata.repository, expectedRepository,
    "Offline-installed tarball must preserve GitHub trusted-publisher source.");
  assert.equal(installedMetadata.homepage, expectedHomepage);
  assert.deepEqual(installedMetadata.bugs, expectedBugs);
  assert.deepEqual(Object.keys(installedMetadata.exports), ["."]);
  assert(!existsSync(join(installed, "src")));
  assert(!existsSync(join(installed, "tests")));

  writeFileSync(join(consumer, "consumer.mjs"), `
import assert from "node:assert/strict";
const fetchBefore = globalThis.fetch;
let network = 0;
globalThis.fetch = async () => { network++; throw Error("UNEXPECTED_NETWORK"); };
let pkg;
try { pkg = await import("@attention-spa/gh-plan"); }
finally { globalThis.fetch = fetchBefore; }
assert.equal(network, 0, "Import must not call GitHub or the registry.");
assert.equal(typeof pkg.planGithub, "function");
assert.equal(typeof pkg.applyPlan, "function");
assert.equal(typeof pkg.ApplyPlanError, "function");
assert.equal(typeof pkg.GITHUB_PLAN_VERSION, "string");
for (const hidden of ["createGithubReferenceApplyOptions",
  "preflightApplyPlan", "executeCallbackApplyPlan", "acquireGithubCasLock"])
  assert(!Object.hasOwn(pkg, hidden), "Internal callback or transport leaked: " + hidden);
let callbacks = 0, error;
try {
  await pkg.applyPlan({
    plan: { readiness: "blocked", steps: [] },
    acknowledgeCallbackTrust: true,
    dispatch: async () => { callbacks++; },
    readPostcondition: async () => { callbacks++; },
    ownership: {
      acquire: async () => { callbacks++; return { ownerId: "untrusted" }; },
      assertOwned: async () => { callbacks++; return true; },
      release: async () => { callbacks++; },
    },
  });
} catch (caught) { error = caught; }
assert(error instanceof pkg.ApplyPlanError, "Bad plan must be refused by typed API.");
assert.equal(error.code, "INVALID_PLAN");
assert.equal(error.phase, "preflight");
assert.equal(callbacks, 0, "Rejected plan must not call any ownership/write callbacks.");
console.log("Isolated packed ESM consumer passed.");
`);
  run(process.execPath, ["consumer.mjs"], consumer);

  writeFileSync(join(consumer, "consumer.ts"), `
import { planGithub, applyPlan, ApplyPlanError } from "@attention-spa/gh-plan";
import type { ApplyPlanOptions, ApplyPlanResult, GithubPlanSchema } from "@attention-spa/gh-plan";
const schema: GithubPlanSchema = { repository: "example/consumer" };
const planner: typeof planGithub = planGithub;
const executor: (options: ApplyPlanOptions) => Promise<ApplyPlanResult> = applyPlan;
const publicError: typeof ApplyPlanError = ApplyPlanError;
void schema; void planner; void executor; void publicError;
`);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022",
      strict: true, noEmit: true, skipLibCheck: false, types: [],
    }, files: ["consumer.ts"],
  }, null, 2) + "\n");
  // Invoke the already-lockfile-pinned compiler, but typecheck an independent
  // consumer project against the *installed* package declarations.
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
    "--project", join(consumer, "tsconfig.json")], consumer);
  console.log("Isolated packed Node ESM and TypeScript NodeNext consumer passed on " +
    process.version + " (" + bytes.length + " tarball bytes, " + included.size + " files).");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
