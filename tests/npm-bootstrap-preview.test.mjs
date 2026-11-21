import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_TAG, BOOTSTRAP_VERSION,
  makeBootstrapFixture, previewBootstrapPackage, validateBootstrapContext,
} from "../scripts/npm-bootstrap-preview.mjs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
const github = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "attention-spa/gh-plan",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
};
const baseline = { version: BOOTSTRAP_VERSION, tag: BOOTSTRAP_TAG, manifest, lock, github };
assert.equal(BOOTSTRAP_VERSION, "0.0.0-bootstrap.0");
assert.equal(BOOTSTRAP_TAG, "bootstrap");
assert.equal(manifest.version, "0.0.0");
assert.equal(manifest.private, true);
assert.equal(manifest.publishConfig, undefined);

const fixture = makeBootstrapFixture();
const bootstrap = JSON.parse(fixture["package.json"]);
assert.equal(bootstrap.name, manifest.name);
assert.equal(bootstrap.version, BOOTSTRAP_VERSION);
assert.equal(bootstrap.private, false, "Only the isolated temporary fixture is non-private.");
assert.equal(bootstrap.publishConfig, undefined);
assert.equal(bootstrap.scripts, undefined, "Bootstrap must execute no scripts.");
assert.equal(bootstrap.dependencies, undefined, "Bootstrap must require no dependencies.");
assert.equal(bootstrap.repository.url, manifest.repository.url);
assert.equal(bootstrap.main, "./index.js");
assert.match(fixture["index.js"], /throw new Error/);
assert.match(fixture["README.md"], /NEVER be approved/);

const contract = validateBootstrapContext(baseline);
assert(Object.isFrozen(contract));
assert.equal(contract.registryWritesAuthorized, false);
assert.equal(contract.publishingAuthorized, false);
assert.equal(contract.requiresSeparateOwnerAuthorization, true);

const preview = previewBootstrapPackage(baseline);
assert.equal(preview.packageName, "@attention-spa/gh-plan");
assert.equal(preview.bootstrapVersion, BOOTSTRAP_VERSION);
assert.deepEqual(preview.packFilePaths, ["README.md", "index.js", "package.json"]);
assert.equal(preview.temporaryFolderRemoved, true);
assert(preview.packIntegrity?.startsWith("sha512-"));

for (const [change, expected] of [
  [{ version: "0.1.0-beta.1" }, /BOOTSTRAP_PREVIEW_VERSION/],
  [{ tag: "latest" }, /BOOTSTRAP_PREVIEW_TAG/],
  [{ github: { ...github, GITHUB_ACTIONS: "false" } }, /BOOTSTRAP_PREVIEW_NOT_ACTIONS/],
  [{ github: { ...github, GITHUB_EVENT_NAME: "pull_request" } }, /BOOTSTRAP_PREVIEW_EVENT/],
  [{ github: { ...github, GITHUB_REPOSITORY: "other/repo" } }, /BOOTSTRAP_PREVIEW_REPOSITORY/],
  [{ github: { ...github, GITHUB_REF: "refs/tags/v0.1.0-beta.1" } },
    /BOOTSTRAP_PREVIEW_REF/],
  [{ github: { ...github, GITHUB_SHA: "broken" } }, /BOOTSTRAP_PREVIEW_SHA/],
  [{ manifest: { ...manifest, name: "other" } }, /BOOTSTRAP_PREVIEW_NAME/],
  [{ manifest: { ...manifest, version: "0.1.0-beta.1" } },
    /BOOTSTRAP_PREVIEW_CURRENT_VERSION/],
  [{ manifest: { ...manifest, private: false } }, /BOOTSTRAP_PREVIEW_SOURCE_PRIVATE/],
  [{ manifest: { ...manifest, publishConfig: { access: "public" } } },
    /BOOTSTRAP_PREVIEW_SOURCE_PUBLISH_CONFIG/],
  [{ manifest: { ...manifest, repository: { type: "git", url: "https://wrong.example" } } },
    /BOOTSTRAP_PREVIEW_SOURCE_URL/],
  [{ lock: { ...lock, version: "1.0.0" } }, /BOOTSTRAP_PREVIEW_LOCK_VERSION/],
  [{ lock: { ...lock, packages: {
    ...lock.packages, "": { ...lock.packages[""], version: "1.0.0" },
  } } }, /BOOTSTRAP_PREVIEW_LOCK_ROOT_VERSION/],
]) {
  assert.throws(() => validateBootstrapContext({ ...baseline, ...change }),
    expected, "Untrusted bootstrap context must fail closed.");
}

const executable = fileURLToPath(new URL("../scripts/npm-bootstrap-preview.mjs", import.meta.url));
const env = {
  ...process.env,
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "attention-spa/gh-plan",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "b".repeat(40),
  BOOTSTRAP_PREVIEW_VERSION: BOOTSTRAP_VERSION,
  BOOTSTRAP_PREVIEW_TAG: BOOTSTRAP_TAG,
};
const run = spawnSync(process.execPath, [executable], {
  env, encoding: "utf8", timeout: 30000,
});
assert.equal(run.status, 0, "Preview CLI must run without npm token: " +
  (run.stderr || run.error?.message || ""));
const actual = JSON.parse(run.stdout.trim());
assert.equal(actual.type, "offline-bootstrap-preview");
assert.equal(actual.publishingAuthorized, false);
assert.equal(actual.registryWritesAuthorized, false);
assert.equal(actual.bootstrapVersion, BOOTSTRAP_VERSION);

const bad = spawnSync(process.execPath, [executable], {
  env: { ...env, GITHUB_EVENT_NAME: "pull_request" },
  encoding: "utf8", timeout: 30000,
});
assert.notEqual(bad.status, 0);
assert.match(bad.stderr, /BOOTSTRAP_PREVIEW_EVENT/);

console.log("Offline first-package bootstrap preview and negative-path tests passed.");
