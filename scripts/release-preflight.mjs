import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREVIEW_VERSION = "0.1.0-beta.1";
export const PREVIEW_TAG = "v0.1.0-beta.1";
const REPOSITORY = "attention-spa/gh-plan";
const PACKAGE = "@attention-spa/gh-plan";
const SOURCE = "git+https://github.com/attention-spa/gh-plan.git";

/**
 * Read-only prerelease contract. Never materializes a publishable version,
 * changes package metadata, requests OIDC, or contacts a registry.
 */
export function validateReleasePreflight({ version, tag, manifest, lock, github }) {
  assert.equal(version, PREVIEW_VERSION, "RELEASE_PREFLIGHT_UNAPPROVED_VERSION");
  assert.equal(tag, PREVIEW_TAG, "RELEASE_PREFLIGHT_UNAPPROVED_TAG");
  assert.equal(tag, "v" + version, "RELEASE_PREFLIGHT_TAG_VERSION_MISMATCH");

  assert.equal(github?.GITHUB_ACTIONS, "true", "RELEASE_PREFLIGHT_NOT_ACTIONS");
  assert.equal(github.GITHUB_EVENT_NAME, "workflow_dispatch",
    "RELEASE_PREFLIGHT_UNTRUSTED_EVENT");
  assert.equal(github.GITHUB_REPOSITORY, REPOSITORY,
    "RELEASE_PREFLIGHT_UNTRUSTED_REPOSITORY");
  assert.equal(github.GITHUB_REF, "refs/heads/main",
    "RELEASE_PREFLIGHT_UNTRUSTED_REF");
  assert.match(github.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/,
    "RELEASE_PREFLIGHT_INVALID_SHA");

  // Stay intentionally incompatible with any npm publication. The future
  // version and Git tag are approved design inputs, NOT current artifacts.
  assert.equal(manifest?.name, PACKAGE, "RELEASE_PREFLIGHT_PACKAGE_NAME");
  assert.equal(manifest?.private, true, "RELEASE_PREFLIGHT_PUBLICATION_BLOCKED");
  assert.equal(manifest?.version, "0.0.0", "RELEASE_PREFLIGHT_CURRENT_VERSION_CHANGED");
  assert.equal(manifest?.publishConfig, undefined,
    "RELEASE_PREFLIGHT_UNAPPROVED_PUBLISH_CONFIG");
  assert.deepEqual(manifest?.repository,
    { type: "git", url: SOURCE }, "RELEASE_PREFLIGHT_SOURCE_MISMATCH");
  assert.equal(manifest?.homepage, "https://github.com/attention-spa/gh-plan#readme",
    "RELEASE_PREFLIGHT_HOMEPAGE_MISMATCH");
  assert.deepEqual(manifest?.bugs,
    { url: "https://github.com/attention-spa/gh-plan/issues" },
    "RELEASE_PREFLIGHT_ISSUE_TRACKER_MISMATCH");
  assert.equal(manifest?.exports?.["."]?.import, "./dist/index.js",
    "RELEASE_PREFLIGHT_ENTRYPOINT_CHANGED");
  assert.deepEqual(manifest?.files, ["dist"],
    "RELEASE_PREFLIGHT_PACKAGING_CHANGED");

  assert.equal(lock?.name, PACKAGE, "RELEASE_PREFLIGHT_LOCK_NAME");
  assert.equal(lock?.version, manifest.version, "RELEASE_PREFLIGHT_LOCK_VERSION");
  assert.equal(lock?.packages?.[""]?.name, PACKAGE,
    "RELEASE_PREFLIGHT_LOCK_PACKAGE");
  assert.equal(lock?.packages?.[""]?.version, manifest.version,
    "RELEASE_PREFLIGHT_LOCK_ROOT_VERSION");

  return Object.freeze({
    repository: REPOSITORY,
    sourceSha: github.GITHUB_SHA,
    proposedVersion: version,
    proposedTag: tag,
    currentVersion: manifest.version,
    private: true,
    stagingAuthorized: false,
    publishingAuthorized: false,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const result = validateReleasePreflight({
    version: process.env.RELEASE_TARGET_VERSION,
    tag: process.env.RELEASE_TARGET_TAG,
    manifest, lock, github: process.env,
  });
  console.log(JSON.stringify({ result: "release-preflight-only", ...result }));
}
