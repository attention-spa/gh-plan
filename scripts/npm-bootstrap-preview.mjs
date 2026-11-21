import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
export const BOOTSTRAP_TAG = "bootstrap";
const PACKAGE = "@attention-spa/gh-plan";
const REPOSITORY = "attention-spa/gh-plan";
const SOURCE_URL = "git+https://github.com/" + REPOSITORY + ".git";
const ALLOWED_FILES = ["README.md", "index.js", "package.json"];

/**
 * An authorization-free preview for the temporary npm namespace bootstrap.
 *
 * This code MUST NOT stage, publish, authenticate to npm, or contact a registry.
 * The approved future live stage is a separate, owner-gated implementation.
 */
export function validateBootstrapContext({ version, tag, github, manifest, lock }) {
  assert.equal(version, BOOTSTRAP_VERSION, "BOOTSTRAP_PREVIEW_VERSION");
  assert.equal(tag, BOOTSTRAP_TAG, "BOOTSTRAP_PREVIEW_TAG");
  assert.equal(github?.GITHUB_ACTIONS, "true", "BOOTSTRAP_PREVIEW_NOT_ACTIONS");
  assert.equal(github?.GITHUB_EVENT_NAME, "workflow_dispatch",
    "BOOTSTRAP_PREVIEW_EVENT");
  assert.equal(github?.GITHUB_REPOSITORY, REPOSITORY,
    "BOOTSTRAP_PREVIEW_REPOSITORY");
  assert.equal(github?.GITHUB_REF, "refs/heads/main", "BOOTSTRAP_PREVIEW_REF");
  assert.match(github?.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/,
    "BOOTSTRAP_PREVIEW_SHA");

  // Current source state is intentionally incompatible with npm publishing.
  assert.equal(manifest?.name, PACKAGE, "BOOTSTRAP_PREVIEW_NAME");
  assert.equal(manifest?.version, "0.0.0", "BOOTSTRAP_PREVIEW_CURRENT_VERSION");
  assert.equal(manifest?.private, true, "BOOTSTRAP_PREVIEW_SOURCE_PRIVATE");
  assert.equal(manifest?.publishConfig, undefined,
    "BOOTSTRAP_PREVIEW_SOURCE_PUBLISH_CONFIG");
  assert.deepEqual(manifest?.repository,
    { type: "git", url: SOURCE_URL }, "BOOTSTRAP_PREVIEW_SOURCE_URL");
  assert.equal(lock?.name, PACKAGE, "BOOTSTRAP_PREVIEW_LOCK_NAME");
  assert.equal(lock?.version, manifest.version, "BOOTSTRAP_PREVIEW_LOCK_VERSION");
  assert.equal(lock?.packages?.[""]?.name, PACKAGE, "BOOTSTRAP_PREVIEW_LOCK_ROOT_NAME");
  assert.equal(lock?.packages?.[""]?.version, manifest.version,
    "BOOTSTRAP_PREVIEW_LOCK_ROOT_VERSION");

  return Object.freeze({
    packageName: PACKAGE,
    bootstrapVersion: BOOTSTRAP_VERSION,
    bootstrapTag: BOOTSTRAP_TAG,
    sourceSha: github.GITHUB_SHA,
    registryWritesAuthorized: false,
    publishingAuthorized: false,
    requiresSeparateOwnerAuthorization: true,
  });
}

export function makeBootstrapFixture() {
  const metadata = {
    name: PACKAGE,
    version: BOOTSTRAP_VERSION,
    description: "Temporary staged namespace bootstrap; NOT an installable gh-plan release.",
    license: "MIT",
    repository: { type: "git", url: SOURCE_URL },
    private: false,
    main: "./index.js",
    files: ["README.md", "index.js"],
  };
  assert.equal(metadata.scripts, undefined);
  assert.equal(metadata.dependencies, undefined);
  assert.equal(metadata.publishConfig, undefined);
  const files = Object.freeze({
    "package.json": JSON.stringify(metadata, null, 2) + "\n",
    "README.md": "# gh-plan namespace bootstrap — not a release\n\n" +
      "This pending version exists only to establish the package name for OIDC. " +
      "It must NEVER be approved for public installation.\n",
    "index.js": "throw new Error('This is a temporary staged bootstrap, not gh-plan.');\n",
  });
  assert.deepEqual(Object.keys(files).sort(), ALLOWED_FILES);
  return files;
}

export function previewBootstrapPackage({ version, tag, github, manifest, lock }) {
  const contract = validateBootstrapContext({ version, tag, github, manifest, lock });
  const dir = mkdtempSync(join(tmpdir(), "gh-plan-bootstrap-preview-"));
  try {
    for (const [name, contents] of Object.entries(makeBootstrapFixture())) {
      writeFileSync(join(dir, name), contents, { flag: "wx", mode: 0o600 });
    }
    // These are the only npm arguments this module is permitted to execute.
    // No npmjs session or authorization token is needed for a local dry run.
    const args = ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"];
    const p = spawnSync("npm", args, {
      cwd: dir, encoding: "utf8", timeout: 20000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        npm_config_update_notifier: "false",
      },
    });
    assert.equal(p.status, 0, "BOOTSTRAP_PREVIEW_PACK_FAILED: " +
      (p.stderr || p.error?.message || ""));
    const packed = JSON.parse(p.stdout);
    assert(Array.isArray(packed) && packed.length === 1,
      "BOOTSTRAP_PREVIEW_PACK_COUNT");
    const names = packed[0].files.map((f) => f.path).sort();
    assert.deepEqual(names, ALLOWED_FILES, "BOOTSTRAP_PREVIEW_PACK_FILES");
    assert.equal(packed[0].name, PACKAGE, "BOOTSTRAP_PREVIEW_PACK_NAME");
    assert.equal(packed[0].version, BOOTSTRAP_VERSION,
      "BOOTSTRAP_PREVIEW_PACK_VERSION");
    return Object.freeze({
      ...contract,
      packFilePaths: names,
      packIntegrity: packed[0].integrity,
      temporaryFolderRemoved: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
  const result = previewBootstrapPackage({
    version: process.env.BOOTSTRAP_PREVIEW_VERSION,
    tag: process.env.BOOTSTRAP_PREVIEW_TAG,
    github: process.env, manifest, lock,
  });
  console.log(JSON.stringify({ type: "offline-bootstrap-preview", ...result }));
}
