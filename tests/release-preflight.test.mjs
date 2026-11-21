import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PREVIEW_TAG, PREVIEW_VERSION, validateReleasePreflight } from
  "../scripts/release-preflight.mjs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
const github = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "attention-spa/gh-plan",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
};
const baseline = { version: PREVIEW_VERSION, tag: PREVIEW_TAG, manifest, lock, github };

const result = validateReleasePreflight(baseline);
assert.equal(result.proposedVersion, "0.1.0-beta.1");
assert.equal(result.proposedTag, "v0.1.0-beta.1");
assert.equal(result.currentVersion, "0.0.0");
assert.equal(result.private, true);
assert.equal(result.stagingAuthorized, false);
assert.equal(result.publishingAuthorized, false);
assert(Object.isFrozen(result));

for (const [override, error] of [
  [{ version: "0.1.0" }, /RELEASE_PREFLIGHT_UNAPPROVED_VERSION/],
  [{ tag: "v0.1.0" }, /RELEASE_PREFLIGHT_UNAPPROVED_TAG/],
  [{ github: { ...github, GITHUB_REF: "refs/tags/v0.1.0-beta.1" } },
    /RELEASE_PREFLIGHT_UNTRUSTED_REF/],
  [{ github: { ...github, GITHUB_EVENT_NAME: "pull_request" } },
    /RELEASE_PREFLIGHT_UNTRUSTED_EVENT/],
  [{ github: { ...github, GITHUB_REPOSITORY: "other/gh-plan" } },
    /RELEASE_PREFLIGHT_UNTRUSTED_REPOSITORY/],
  [{ github: { ...github, GITHUB_SHA: "not-a-sha" } },
    /RELEASE_PREFLIGHT_INVALID_SHA/],
  [{ github: { ...github, GITHUB_ACTIONS: "false" } },
    /RELEASE_PREFLIGHT_NOT_ACTIONS/],
  [{ manifest: { ...manifest, private: false } },
    /RELEASE_PREFLIGHT_PUBLICATION_BLOCKED/],
  [{ manifest: { ...manifest, version: "0.1.0-beta.1" } },
    /RELEASE_PREFLIGHT_CURRENT_VERSION_CHANGED/],
  [{ manifest: { ...manifest, publishConfig: { access: "public" } } },
    /RELEASE_PREFLIGHT_UNAPPROVED_PUBLISH_CONFIG/],
  [{ manifest: { ...manifest, repository: { type: "git", url: "https://evil.example/repo" } } },
    /RELEASE_PREFLIGHT_SOURCE_MISMATCH/],
  [{ lock: { ...lock, version: "0.1.0-beta.1" } },
    /RELEASE_PREFLIGHT_LOCK_VERSION/],
  [{ lock: { ...lock, packages: { ...lock.packages, "": { ...lock.packages[""], version: "0.1.0-beta.1" } } } },
    /RELEASE_PREFLIGHT_LOCK_ROOT_VERSION/],
]) {
  assert.throws(() => validateReleasePreflight({ ...baseline, ...override }),
    error, "Malformed or release-enabled context must fail closed.");
}

const executable = fileURLToPath(new URL("../scripts/release-preflight.mjs", import.meta.url));
const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "attention-spa/gh-plan", GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "b".repeat(40),
  RELEASE_TARGET_VERSION: PREVIEW_VERSION, RELEASE_TARGET_TAG: PREVIEW_TAG };
const executed = spawnSync(process.execPath, [executable], {
  env, encoding: "utf8", timeout: 10000,
});
assert.equal(executed.status, 0,
  "CLI preflight must validate with no registry or credential context: " +
  (executed.stderr || executed.error?.message || ""));
const output = JSON.parse(executed.stdout.trim());
assert.equal(output.result, "release-preflight-only");
assert.equal(output.publishingAuthorized, false);
assert.equal(output.stagingAuthorized, false);

const rejected = spawnSync(process.execPath, [executable], {
  env: { ...env, GITHUB_REF: "refs/heads/feature" },
  encoding: "utf8", timeout: 10000,
});
assert.notEqual(rejected.status, 0, "Non-main CLI dispatch must be refused.");
assert.match(rejected.stderr, /RELEASE_PREFLIGHT_UNTRUSTED_REF/);

console.log("Release preflight identity, no-publish and negative-path tests passed.");
