import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_STAGE_ARGS, inspectBootstrapRemotes,
  previewStageBootstrap, validateStageContext,
} from "../scripts/npm-bootstrap-stage.mjs";
import { BOOTSTRAP_VERSION, BOOTSTRAP_TAG } from "../scripts/npm-bootstrap-preview.mjs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
const sha = "a".repeat(40);
const github = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "attention-spa/gh-plan",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  GITHUB_ACTOR: "agent-hachi",
  GITHUB_TRIGGERING_ACTOR: "agent-hachi",
  GITHUB_WORKFLOW_REF:
    "attention-spa/gh-plan/.github/workflows/npm-bootstrap-stage.yml@refs/heads/main",
};
const base = {
  version: BOOTSTRAP_VERSION, tag: BOOTSTRAP_TAG,
  github, manifest, lock, localSha: sha, mainSha: sha,
  mainProtected: true, registryStatus: 404,
};

assert.deepEqual(BOOTSTRAP_STAGE_ARGS, [
  "stage", "publish", "--tag", "bootstrap", "--access", "public", "--ignore-scripts",
]);
const validFirstStage = validateStageContext({
  ...base,
  mode: "first-stage",
  github: { ...github, GITHUB_WORKFLOW_REF:
    "attention-spa/gh-plan/.github/workflows/npm-bootstrap-first-stage.yml@refs/heads/main" },
});
assert.equal(validFirstStage.registryWritesAuthorized, false,
  "Shared remote preflight does not authorize writes by itself.");
assert.throws(() => validateStageContext({ ...base, mode: "first-stage" }),
  /BOOTSTRAP_STAGE_WORKFLOW/,
  "Read-only preflight identity must not impersonate authorized writer.");
const valid = validateStageContext(base);
assert.equal(valid.trustedMain, true);
assert.equal(valid.npmPackageAbsentAtCheck, true);
assert.equal(valid.registryWritesAuthorized, false);
assert.equal(valid.stagingEnabled, false);
assert.equal(valid.plannedCommand,
  "npm stage publish --tag bootstrap --access public --ignore-scripts");

for (const [input, error] of [
  [{ github: { ...github, GITHUB_ACTOR: "fork-author" } }, /BOOTSTRAP_STAGE_ACTOR/],
  [{ github: { ...github, GITHUB_TRIGGERING_ACTOR: "other" } },
    /BOOTSTRAP_STAGE_TRIGGERING_ACTOR/],
  [{ github: { ...github, GITHUB_WORKFLOW_REF:
    "attention-spa/gh-plan/.github/workflows/npm-bootstrap-stage.yml@refs/tags/v1" } },
  /BOOTSTRAP_STAGE_WORKFLOW/],
  [{ localSha: "b".repeat(40) }, /BOOTSTRAP_STAGE_LOCAL_SHA/],
  [{ mainSha: "b".repeat(40) }, /BOOTSTRAP_STAGE_MAIN_SHA/],
  [{ mainProtected: false }, /BOOTSTRAP_STAGE_PROTECTED_MAIN/],
  [{ registryStatus: 200 }, /BOOTSTRAP_STAGE_REGISTRY_NOT_ABSENT/],
  [{ registryStatus: 403 }, /BOOTSTRAP_STAGE_REGISTRY_NOT_ABSENT/],
  [{ registryStatus: 500 }, /BOOTSTRAP_STAGE_REGISTRY_NOT_ABSENT/],
  [{ github: { ...github, GITHUB_REF: "refs/heads/attacker" } },
    /BOOTSTRAP_PREVIEW_REF/],
  [{ manifest: { ...manifest, private: false } }, /BOOTSTRAP_PREVIEW_SOURCE_PRIVATE/],
  [{ lock: { ...lock, version: "1.0.0" } }, /BOOTSTRAP_PREVIEW_LOCK_VERSION/],
  [{ version: "0.1.0-beta.1" }, /BOOTSTRAP_PREVIEW_VERSION/],
  [{ tag: "latest" }, /BOOTSTRAP_PREVIEW_TAG/],
]) {
  assert.throws(() => validateStageContext({ ...base, ...input }), error);
}

const MAIN = "https://api.github.com/repos/attention-spa/gh-plan/branches/main";
const REGISTRY = "https://registry.npmjs.org/@attention-spa%2fgh-plan";
function mockRemote({ mainStatus = 200, registryStatus = 404, protectedMain = true,
  mainSha = sha, redirectMain = false, redirectRegistry = false,
  wrongMainUrl = false, wrongRegistryUrl = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    if (url === MAIN) {
      assert.match(options.headers.Authorization, /^Bearer /);
      return {
        status: mainStatus, redirected: redirectMain,
        url: wrongMainUrl ? "https://evil.example/main" : MAIN,
        json: async () => ({ commit: { sha: mainSha }, protected: protectedMain }),
      };
    }
    assert.equal(url, REGISTRY);
    assert.equal(options.headers.Authorization, undefined,
      "Never forward GitHub read credentials to npm registry.");
    assert.equal(options.headers["X-GitHub-Api-Version"], undefined);
    return {
      status: registryStatus, redirected: redirectRegistry,
      url: wrongRegistryUrl ? "https://evil.example/pkg" : REGISTRY,
    };
  };
  return { calls, fetchImpl };
}

const remote = mockRemote();
const validated = await inspectBootstrapRemotes({
  ...base, token: "test-gh-read-token", fetchImpl: remote.fetchImpl,
});
assert.equal(validated.stagingEnabled, false);
assert.equal(validated.registryWritesAuthorized, false);
assert.deepEqual(remote.calls.map(x => x.url), [MAIN, REGISTRY]);
assert.equal(remote.calls[0].options.headers.Authorization, "Bearer test-gh-read-token");
assert.equal(remote.calls[1].options.headers.Authorization, undefined);

const previewRemote = mockRemote();
const output = await previewStageBootstrap({
  ...base, token: "test-gh-read-token", fetchImpl: previewRemote.fetchImpl,
});
assert.equal(output.type, "npm-bootstrap-stage-read-only");
assert.equal(output.registryWritesAuthorized, false);
assert.equal(output.stagingEnabled, false);
assert.equal(output.temporaryFolderRemoved, true);
assert.deepEqual(output.packFilePaths, ["README.md", "index.js", "package.json"]);
assert.match(output.packIntegrity, /^sha512-/);

for (const [name, mockOptions, err] of [
  ["existing package", { registryStatus: 200 }, /BOOTSTRAP_STAGE_REGISTRY_HTTP/],
  ["registry forbidden", { registryStatus: 403 }, /BOOTSTRAP_STAGE_REGISTRY_HTTP/],
  ["registry server error", { registryStatus: 503 }, /BOOTSTRAP_STAGE_REGISTRY_HTTP/],
  ["unprotected main", { protectedMain: false }, /BOOTSTRAP_STAGE_PROTECTED_MAIN/],
  ["moved main", { mainSha: "b".repeat(40) }, /BOOTSTRAP_STAGE_MAIN_SHA/],
  ["main missing", { mainStatus: 404 }, /BOOTSTRAP_STAGE_MAIN_HTTP/],
  ["main redirect", { redirectMain: true }, /BOOTSTRAP_STAGE_MAIN_HTTP_REDIRECT/],
  ["registry redirect", { redirectRegistry: true }, /BOOTSTRAP_STAGE_REGISTRY_HTTP_REDIRECT/],
  ["main origin mismatch", { wrongMainUrl: true }, /BOOTSTRAP_STAGE_MAIN_URL/],
  ["registry origin mismatch", { wrongRegistryUrl: true }, /BOOTSTRAP_STAGE_REGISTRY_URL/],
]) {
  const scenario = mockRemote(mockOptions);
  await assert.rejects(inspectBootstrapRemotes({
    ...base, token: "test-gh-read-token", fetchImpl: scenario.fetchImpl,
  }), err, name);
}
await assert.rejects(inspectBootstrapRemotes({
  ...base, token: "", fetchImpl: mockRemote().fetchImpl,
}), /BOOTSTRAP_STAGE_MISSING_READ_TOKEN/);
await assert.rejects(inspectBootstrapRemotes({
  ...base, token: "test", fetchImpl: async () => { throw Error("network offline"); },
}), /network offline/);

// The CLI cannot be tricked into a privileged action from an invalid event,
// even with an npm token present in the environment: it validates first.
const executable = fileURLToPath(new URL("../scripts/npm-bootstrap-stage.mjs", import.meta.url));
const bad = spawnSync(process.execPath, [executable], {
  encoding: "utf8", timeout: 10_000,
  env: { ...process.env, ...github, GITHUB_EVENT_NAME: "pull_request",
    BOOTSTRAP_STAGE_VERSION: BOOTSTRAP_VERSION,
    BOOTSTRAP_STAGE_TAG: BOOTSTRAP_TAG,
    BOOTSTRAP_GITHUB_READ_TOKEN: "test-gh-read-token",
    NODE_AUTH_TOKEN: "do-not-ever-use",
  },
});
assert.notEqual(bad.status, 0);
assert.match(bad.stderr, /BOOTSTRAP_PREVIEW_EVENT/);
assert.equal(bad.stdout, "");
assert(!bad.stderr.includes("do-not-ever-use"),
  "A failed validator must never expose an npm credential.");

console.log("Read-only bootstrap staging preflight and adversarial cases passed.");
