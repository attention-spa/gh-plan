import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PREVIEW_TAG, PREVIEW_VERSION } from "../scripts/release-preflight.mjs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const manifest = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const readme = read("README.md");
const guide = read("docs/npm-distribution.md");
const change = read("CHANGELOG.md");
const preflightGuide = read("docs/release-preflight.md");
const bootstrapGuide = read("docs/npm-bootstrap-preview.md");

assert.equal(PREVIEW_VERSION, "0.1.0-beta.1");
assert.equal(PREVIEW_TAG, "v0.1.0-beta.1");
assert.equal(manifest.name, "@attention-spa/gh-plan");
assert.equal(manifest.private, true, "Documentation must not trigger a public release.");
assert.equal(manifest.version, "0.0.0", "Current version is still not publishable.");
assert.equal(manifest.publishConfig, undefined);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);

for (const [file, text] of [
  ["README.md", readme], ["docs/npm-distribution.md", guide],
  ["CHANGELOG.md", change], ["docs/release-preflight.md", preflightGuide],
]) {
  assert(text.includes(PREVIEW_VERSION), file + " must use the approved candidate.");
  assert(/not (?:yet )?(?:published|available|released)|not yet released|unreleased|PREPARATION ONLY|DRAFT/i.test(text),
    file + " must state the package's unreleased status.");
}
assert(readme.includes("docs/npm-distribution.md"));
assert(readme.includes("CHANGELOG.md"));
assert(readme.includes("docs/release-preflight.md"));
assert(readme.includes('The package currently has `"private": true` and is not published to npm.'));

assert(guide.includes("npm install @attention-spa/gh-plan@" + PREVIEW_VERSION),
  "Future-only npm install example must pin the approved version.");
assert(guide.includes("future use only"), "Install command must be explicitly conditional.");
assert(guide.includes("Node.js **22 or newer**"));
assert(guide.includes("planGithub()"));
assert(guide.includes("applyPlan()"));
assert(guide.includes("read-only"));
for (const term of [
  "2FA", "OIDC", "stage-only", "provenance", "0.0.0-stage",
  "deprecation", "unpublish", "immutable", "not published",
]) {
  assert(guide.toLowerCase().includes(term.toLowerCase()),
    "Guide must document the release and recovery constraint: " + term);
}
assert(guide.includes("not a") || guide.includes("does not prove"),
  "Provenance and test limitations must remain explicit.");
assert(change.includes("Unreleased — proposed " + PREVIEW_VERSION));
assert(change.includes(PREVIEW_TAG));
assert(change.includes("DRAFT; not published"));
assert(change.includes("private:true"));
assert(change.includes("No publishable prerelease artifact"),
  "Changelog must not claim a publishable tarball exists.");
assert(change.includes("trusted-publisher"),
  "Draft must not claim an npm trust relationship already exists.");
assert(!/## \[[0-9]+\.[0-9]+\.[0-9]+/.test(change),
  "Do not add a dated released-version changelog heading before publication.");

// #243: Authorization and credential setup are separate facts. Do not
// regress to the obsolete website-only token-creation instructions.
assert(bootstrapGuide.includes("owner-authorized but has NOT been executed"));
assert(bootstrapGuide.includes("The real prerelease and final publication remain separately gated"));
assert(!bootstrapGuide.includes("No npm registry staging or publication authorized."),
  "Owner already authorized the single temporary bootstrap stage, NOT the real release.");
assert(bootstrapGuide.includes("npm token create --name=gh-plan-bootstrap-once"),
  "npm CLI now supports scoped granular token creation as an optional local path.");
assert(bootstrapGuide.includes("Reuse an existing npm access token"),
  "Do not require a newly created or minimally scoped npm token.");
assert(bootstrapGuide.includes("wider scope or direct-publish permission are acceptable"),
  "Any valid npm stage-capable credential must work, even if it has unrelated privileges.");
assert(bootstrapGuide.includes("only `npm stage publish`"),
  "Reusing a broad token must not widen the workflow's command.");
assert(bootstrapGuide.includes("leave the **shared organization secret"),
  "Keep the existing organization npm secret untouched after bootstrap.");
assert(bootstrapGuide.includes("GitHub PAT or an unidentified secret"),
  "Unidentified GitHub/org tokens cannot be assumed to be npm credentials.");
assert(bootstrapGuide.includes("existing **`NPMJS_TOKEN_NIKI` organization Actions secret"),
  "Use the owner-identified, Doppler-synced GitHub org secret.");
assert(bootstrapGuide.includes("does not expose the token value"),
  "Documentation must not suggest retrieving GitHub secret values.");
assert(bootstrapGuide.includes("There is **no temporary environment"),
  "No duplicate environment credential should be created.");
assert(bootstrapGuide.includes("Disable the one-use first-stage workflow before"),
  "Disable the workflow before removing its deployment environment.");


for (const required of [
  "--expires=1",
  "--scopes=attention-spa",
  "--packages-and-scopes-permission=read-write-stage-only",
  "--orgs-permission=no-access",
  "--bypass-2fa=false",
  "password and 2FA/OTP",
  "NPMJS_TOKEN_NIKI",
  "npm-bootstrap",
  "GitHub does not expose the token value",
  "deleting the `npm-bootstrap` environment",
  "0.0.0-stage",
  "private:true",
]) {
  assert(bootstrapGuide.includes(required),
    "Optional npm token creation must remain documented and live-stage gate preserved: " + required);
}

console.log("Draft npm release docs, future install, rollback, and private gate verified.");
