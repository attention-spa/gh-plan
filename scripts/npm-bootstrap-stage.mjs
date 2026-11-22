import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_TAG, BOOTSTRAP_VERSION, previewBootstrapPackage,
  validateBootstrapContext,
} from "./npm-bootstrap-preview.mjs";

const REPO = "attention-spa/gh-plan";
const PACKAGE = "@attention-spa/gh-plan";
const WORKFLOW = REPO + "/.github/workflows/npm-bootstrap-stage.yml@refs/heads/main";
const FIRST_STAGE_WORKFLOW = REPO + "/.github/workflows/npm-bootstrap-first-stage.yml@refs/heads/main";
const REGISTRY_URL = "https://registry.npmjs.org/@attention-spa%2fgh-plan";
const MAIN_URL = "https://api.github.com/repos/" + REPO + "/branches/main";

// This is a REVIEWABLE FUTURE command, never executed by this module or
// its GitHub Actions workflow. Only a separately authorized change may
// introduce a registry-write job, stage-only token, or stage invocation.
export const BOOTSTRAP_STAGE_ARGS = Object.freeze([
  "stage", "publish", "--tag", BOOTSTRAP_TAG, "--access", "public", "--ignore-scripts",
]);

export function validateStageContext({
  version, tag, github, manifest, lock, localSha, mainSha,
  mainProtected, registryStatus, mode = "preflight",
}) {
  const preview = validateBootstrapContext({ version, tag, github, manifest, lock });
  assert.equal(github.GITHUB_ACTOR, "agent-hachi", "BOOTSTRAP_STAGE_ACTOR");
  assert.equal(github.GITHUB_TRIGGERING_ACTOR, "agent-hachi",
    "BOOTSTRAP_STAGE_TRIGGERING_ACTOR");
  assert(["preflight", "first-stage"].includes(mode), "BOOTSTRAP_STAGE_MODE");
  assert.equal(github.GITHUB_WORKFLOW_REF,
    mode === "first-stage" ? FIRST_STAGE_WORKFLOW : WORKFLOW,
    "BOOTSTRAP_STAGE_WORKFLOW");
  assert.equal(localSha, github.GITHUB_SHA, "BOOTSTRAP_STAGE_LOCAL_SHA");
  assert.equal(mainSha, github.GITHUB_SHA, "BOOTSTRAP_STAGE_MAIN_SHA");
  assert.equal(mainProtected, true, "BOOTSTRAP_STAGE_PROTECTED_MAIN");
  assert.equal(registryStatus, 404, "BOOTSTRAP_STAGE_REGISTRY_NOT_ABSENT");
  assert.deepEqual(BOOTSTRAP_STAGE_ARGS, [
    "stage", "publish", "--tag", "bootstrap", "--access", "public", "--ignore-scripts",
  ]);
  return Object.freeze({
    ...preview,
    trustedMain: true,
    npmPackageAbsentAtCheck: true,
    plannedCommand: "npm " + BOOTSTRAP_STAGE_ARGS.join(" "),
    registryWritesAuthorized: false,
    stagingEnabled: false,
  });
}

function safeReadOnlyResponse(response, status, code) {
  assert.equal(response?.status, status, code);
  assert.equal(response?.redirected, false, code + "_REDIRECT");
  assert.equal(response?.url?.startsWith("https://"), true, code + "_ORIGIN");
}

export async function inspectBootstrapRemotes({
  token, fetchImpl = fetch, github, manifest, lock,
  version, tag, localSha, mode = "preflight",
}) {
  // Authenticate ONLY the GitHub read. Never pass its token to npm or npmjs.
  assert(typeof token === "string" && token.length > 0,
    "BOOTSTRAP_STAGE_MISSING_READ_TOKEN");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "X-GitHub-Api-Version": "2022-11-28",
    "Cache-Control": "no-cache",
  };
  const mainResponse = await fetchImpl(MAIN_URL, {
    method: "GET", headers, redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  safeReadOnlyResponse(mainResponse, 200, "BOOTSTRAP_STAGE_MAIN_HTTP");
  assert.equal(mainResponse.url, MAIN_URL, "BOOTSTRAP_STAGE_MAIN_URL");
  const main = await mainResponse.json();
  const mainSha = main?.commit?.sha;
  assert.match(mainSha ?? "", /^[a-f0-9]{40}$/, "BOOTSTRAP_STAGE_MAIN_SHA_FORMAT");

  // Only this public registry endpoint is queried, never authenticated.
  const registryResponse = await fetchImpl(REGISTRY_URL, {
    method: "GET",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  safeReadOnlyResponse(registryResponse, 404, "BOOTSTRAP_STAGE_REGISTRY_HTTP");
  assert.equal(registryResponse.url, REGISTRY_URL, "BOOTSTRAP_STAGE_REGISTRY_URL");

  return validateStageContext({
    version, tag, github, manifest, lock, localSha, mainSha,
    mainProtected: main?.protected, registryStatus: registryResponse.status, mode,
  });
}

export async function previewStageBootstrap({
  version, tag, github, manifest, lock, token, fetchImpl = fetch, localSha,
}) {
  // Fail closed before any pack: a second public 404 is not an authorization
  // to create a placeholder. Real staging later must recheck immediately.
  const contract = await inspectBootstrapRemotes({
    version, tag, github, manifest, lock, token, fetchImpl, localSha,
  });
  const fixture = previewBootstrapPackage({ version, tag, github, manifest, lock });
  return Object.freeze({ ...fixture, ...contract, type: "npm-bootstrap-stage-read-only" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
  const github = process.env;
  // Check local, event and source identity BEFORE any external request.
  validateBootstrapContext({
    version: github.BOOTSTRAP_STAGE_VERSION,
    tag: github.BOOTSTRAP_STAGE_TAG, github, manifest, lock,
  });
  assert.equal(github.GITHUB_ACTOR, "agent-hachi", "BOOTSTRAP_STAGE_ACTOR");
  assert.equal(github.GITHUB_TRIGGERING_ACTOR, "agent-hachi",
    "BOOTSTRAP_STAGE_TRIGGERING_ACTOR");
  assert.equal(github.GITHUB_WORKFLOW_REF, WORKFLOW, "BOOTSTRAP_STAGE_WORKFLOW");
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(git.status, 0, "BOOTSTRAP_STAGE_GIT");
  const result = await previewStageBootstrap({
    version: github.BOOTSTRAP_STAGE_VERSION,
    tag: github.BOOTSTRAP_STAGE_TAG,
    github, manifest, lock,
    token: github.BOOTSTRAP_GITHUB_READ_TOKEN,
    localSha: git.stdout.trim(),
  });
  console.log(JSON.stringify(result));
}
