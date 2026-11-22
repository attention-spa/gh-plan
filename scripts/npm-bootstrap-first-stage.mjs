import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_STAGE_ARGS, inspectBootstrapRemotes,
} from "./npm-bootstrap-stage.mjs";
import {
  BOOTSTRAP_TAG, BOOTSTRAP_VERSION, makeBootstrapFixture,
  previewBootstrapPackage, validateBootstrapContext,
} from "./npm-bootstrap-preview.mjs";

const PACKAGE = "@attention-spa/gh-plan";
const REGISTRY = "https://registry.npmjs.org/";
const APPROVED_STAGE_SCRIPT = "npm-bootstrap-first-stage.mjs";

// One authorized initial stage may create the PUBLIC 0.0.0-stage placeholder.
// This script must never approve, promote, reject, publish directly, tag,
// trust, or mutate the root private package. Do not retry unknown writes.
export function validateFirstStageAuthorization({
  github, manifest, lock, version, tag, approvedSha, consent,
  npmTokenPresent, githubReadTokenPresent, localSha,
}) {
  validateBootstrapContext({ version, tag, github, manifest, lock });
  assert.equal(github.GITHUB_ACTOR, "agent-hachi", "FIRST_STAGE_ACTOR");
  assert.equal(github.GITHUB_TRIGGERING_ACTOR, "agent-hachi",
    "FIRST_STAGE_TRIGGERING_ACTOR");
  assert.equal(github.GITHUB_WORKFLOW_REF,
    "attention-spa/gh-plan/.github/workflows/npm-bootstrap-first-stage.yml@refs/heads/main",
    "FIRST_STAGE_WORKFLOW");
  assert.equal(consent, "true", "FIRST_STAGE_PLACEHOLDER_APPROVAL");
  assert.match(approvedSha ?? "", /^[a-f0-9]{40}$/, "FIRST_STAGE_APPROVED_SHA_FORMAT");
  assert.equal(approvedSha, github.GITHUB_SHA, "FIRST_STAGE_APPROVED_SHA");
  assert.equal(localSha, approvedSha, "FIRST_STAGE_LOCAL_SHA");
  assert.equal(npmTokenPresent, true, "FIRST_STAGE_TOKEN_NOT_CONFIGURED");
  assert.equal(githubReadTokenPresent, true, "FIRST_STAGE_GITHUB_READ_MISSING");
  return Object.freeze({ packageName: PACKAGE, version: BOOTSTRAP_VERSION,
    tag: BOOTSTRAP_TAG, approvedSha, publicPlaceholderAuthorized: true });
}

export function assertStageCliVersion(version, nodeVersion = process.versions.node) {
  const parts = /^(?<maj>\d+)\.(?<min>\d+)\.\d+$/.exec(version ?? "");
  assert(parts, "FIRST_STAGE_NPM_VERSION_UNKNOWN");
  assert(Number(parts.groups.maj) > 11 ||
    (Number(parts.groups.maj) === 11 && Number(parts.groups.min) >= 15),
    "FIRST_STAGE_NPM_MINIMUM_11_15");
  assert(Number(nodeVersion.split(".")[0]) >= 24, "FIRST_STAGE_NODE24_REQUIRED");
}

export async function runAuthorizedFirstStage({
  github, manifest, lock, version, tag, approvedSha, consent,
  localSha, githubReadToken, npmStageToken, fetchImpl = fetch,
  spawnImpl = spawnSync,
}) {
  const authorized = validateFirstStageAuthorization({
    github, manifest, lock, version, tag, approvedSha, consent, localSha,
    npmTokenPresent: typeof npmStageToken === "string" && npmStageToken.length > 0,
    githubReadTokenPresent: typeof githubReadToken === "string" && githubReadToken.length > 0,
  });
  // Explicitly inspect these remote facts immediately before the one write;
  // a previous successful read-only preview is not valid authorization.
  await inspectBootstrapRemotes({
    token: githubReadToken, fetchImpl, github, manifest, lock,
    version, tag, localSha, mode: "first-stage",
  });

  const cli = spawnImpl("npm", ["--version"], {
    encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  assert.equal(cli.status, 0, "FIRST_STAGE_NPM_NOT_AVAILABLE");
  assertStageCliVersion((cli.stdout ?? "").trim());

  // Reuse the previously verified, no-network fixture and immutable contents.
  const packed = previewBootstrapPackage({ version, tag, github, manifest, lock });
  assert.deepEqual(packed.packFilePaths, ["README.md", "index.js", "package.json"]);
  assert.match(packed.packIntegrity ?? "", /^sha512-/);

  // The npm credential exists only inside the publish subprocess environment
  // and a 0600 temporary userconfig. It is NOT forwarded to GitHub GET,
  // public registry GET, fixture pack, npm ci, or test processes.
  const root = mkdtempSync(join(tmpdir(), "gh-plan-first-stage-"));
  const fixtureDir = join(root, "fixture");
  const configFile = join(root, "npm-auth");
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fixtureDir, { mode: 0o700 });
    for (const [name, contents] of Object.entries(makeBootstrapFixture())) {
      writeFileSync(join(fixtureDir, name), contents, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(configFile,
      "registry=" + REGISTRY + "\n" +
      "//registry.npmjs.org/:_authToken=" + npmStageToken + "\n",
      { flag: "wx", mode: 0o600 });

    assert.deepEqual(BOOTSTRAP_STAGE_ARGS,
      ["stage", "publish", "--tag", "bootstrap", "--access", "public", "--ignore-scripts"]);
    const publish = spawnImpl("npm", [...BOOTSTRAP_STAGE_ARGS, "--registry", REGISTRY], {
      cwd: fixtureDir, encoding: "utf8", timeout: 120_000,
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        npm_config_userconfig: configFile,
        npm_config_update_notifier: "false",
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    });
    // Do not print untrusted CLI stderr/stdout: npm may include auth context.
    // If the outcome is unknown, inspect npm state; NEVER automatically retry.
    assert.equal(publish.status, 0, "FIRST_STAGE_OUTCOME_UNKNOWN_CHECK_NPM");
    return Object.freeze({
      type: "npm-bootstrap-first-stage-submitted", packageName: authorized.packageName,
      stagedVersion: authorized.version, stagedTag: authorized.tag,
      approvedSha: authorized.approvedSha, packIntegrity: packed.packIntegrity,
      firstPackagePlaceholderExpected: "0.0.0-stage",
      realVersionPublished: false, separatelyVerifyRegistryAndPendingStage: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const github = process.env;
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
  // Authorization and source checks happen before even reading the stage token.
  validateBootstrapContext({
    version: github.BOOTSTRAP_STAGE_VERSION,
    tag: github.BOOTSTRAP_STAGE_TAG, github, manifest, lock,
  });
  assert.equal(github.BOOTSTRAP_PLACEHOLDER_APPROVED, "true",
    "FIRST_STAGE_PLACEHOLDER_APPROVAL");
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(git.status, 0, "FIRST_STAGE_GIT_READ");
  const result = await runAuthorizedFirstStage({
    github, manifest, lock, localSha: git.stdout.trim(),
    version: github.BOOTSTRAP_STAGE_VERSION, tag: github.BOOTSTRAP_STAGE_TAG,
    consent: github.BOOTSTRAP_PLACEHOLDER_APPROVED,
    approvedSha: github.BOOTSTRAP_APPROVED_SHA,
    githubReadToken: github.BOOTSTRAP_GITHUB_READ_TOKEN,
    npmStageToken: github.BOOTSTRAP_NPM_STAGE_TOKEN,
  });
  console.log(JSON.stringify(result));
}
