import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFileSync as read } from "node:fs";
import { BOOTSTRAP_VERSION, BOOTSTRAP_TAG } from "../scripts/npm-bootstrap-preview.mjs";
import { diagnoseBootstrapNpm, assertBootstrapDiagnosticContext } from "../scripts/npm-bootstrap-auth-diagnose.mjs";
import {
  assertStageCliVersion, readBootstrapLocalSha, runAuthorizedFirstStage,
  validateFirstStageAuthorization,
} from "../scripts/npm-bootstrap-first-stage.mjs";

const manifest = JSON.parse(read(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(read(new URL("../package-lock.json", import.meta.url)));
const sha = "a".repeat(40), token = "TEST_TOKEN_DO_NOT_LOG";
const github = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "attention-spa/gh-plan",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  GITHUB_ACTOR: "agent-hachi",
  GITHUB_TRIGGERING_ACTOR: "agent-hachi",
  GITHUB_WORKFLOW_REF:
    "attention-spa/gh-plan/.github/workflows/npm-bootstrap-first-stage.yml@refs/heads/main",
};
const base = {
  github, manifest, lock,
  version: BOOTSTRAP_VERSION, tag: BOOTSTRAP_TAG,
  localSha: sha, approvedSha: sha, consent: "true",
  githubReadToken: "read-only-GitHub-token", npmStageToken: token,
  nodeVersion: "24.0.0",
};
const approved = validateFirstStageAuthorization({
  ...base, npmTokenPresent: true, githubReadTokenPresent: true,
});
assert.equal(approved.publicPlaceholderAuthorized, true);
assert.equal(approved.version, "0.0.0-bootstrap.0");
assert.equal(approved.tag, "bootstrap");
// Credential-bearing workflow entrypoint must scrub all tokens from the
// git child process. The real Git HEAD check runs before registry inspection.
const parentEnv = {
  PATH: "/trusted/bin", HOME: "/home/runner",
  BOOTSTRAP_NPM_STAGE_TOKEN: token,
  BOOTSTRAP_GITHUB_READ_TOKEN: base.githubReadToken,
  NODE_AUTH_TOKEN: "node-secret",
  GH_TOKEN: "github-secret",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "malicious-helper",
};
let gitCalls = 0;
const localHead = readBootstrapLocalSha({
  env: parentEnv,
  spawnImpl: (command, args, options) => {
    gitCalls++;
    assert.equal(command, "git");
    assert.deepEqual(args, ["rev-parse", "HEAD"]);
    assert.equal(options.timeout, 10_000);
    assert.deepEqual(options.env, { PATH: parentEnv.PATH, HOME: parentEnv.HOME });
    assert(!JSON.stringify(options).includes(token));
    assert(!JSON.stringify(options).includes(base.githubReadToken));
    return { status: 0, stdout: sha + "\n" };
  },
});
assert.equal(localHead, sha);
assert.equal(gitCalls, 1);
assert.throws(() => readBootstrapLocalSha({
  env: parentEnv,
  spawnImpl: () => ({ status: 0, stdout: "not-a-git-sha" }),
}), /FIRST_STAGE_GIT_SHA_FORMAT/);
assert.throws(() => readBootstrapLocalSha({
  env: parentEnv,
  spawnImpl: () => ({ status: 1, stdout: "", stderr: token }),
}), error => {
  assert.match(error.message, /FIRST_STAGE_GIT_READ/);
  assert(!error.message.includes(token));
  return true;
});

assertStageCliVersion("11.15.0", "24.0.0");
assertStageCliVersion("12.0.0", "24.0.0");
assert.throws(() => assertStageCliVersion("11.14.9", "24.0.0"),
  /FIRST_STAGE_NPM_MINIMUM/);
assert.throws(() => assertStageCliVersion("11.15.0", "22.16.0"),
  /FIRST_STAGE_NODE24_REQUIRED/);

for (const [change, message] of [
  [{ consent: "false" }, /FIRST_STAGE_PLACEHOLDER_APPROVAL/],
  [{ approvedSha: "b".repeat(40) }, /FIRST_STAGE_APPROVED_SHA/],
  [{ approvedSha: "not-hex" }, /FIRST_STAGE_APPROVED_SHA_FORMAT/],
  [{ localSha: "b".repeat(40) }, /FIRST_STAGE_LOCAL_SHA/],
  [{ npmTokenPresent: false }, /FIRST_STAGE_TOKEN_NOT_CONFIGURED/],
  [{ githubReadTokenPresent: false }, /FIRST_STAGE_GITHUB_READ_MISSING/],
  [{ github: { ...github, GITHUB_ACTOR: "dddominikk" } }, /FIRST_STAGE_ACTOR/],
  [{ github: { ...github, GITHUB_TRIGGERING_ACTOR: "someone-else" } },
    /FIRST_STAGE_TRIGGERING_ACTOR/],
  [{ github: { ...github, GITHUB_WORKFLOW_REF:
    "attention-spa/gh-plan/.github/workflows/npm-bootstrap-stage.yml@refs/heads/main" } },
  /FIRST_STAGE_WORKFLOW/],
  [{ github: { ...github, GITHUB_REF: "refs/heads/test" } }, /BOOTSTRAP_PREVIEW_REF/],
  [{ manifest: { ...manifest, private: false } }, /BOOTSTRAP_PREVIEW_SOURCE_PRIVATE/],
  [{ version: "0.1.0-beta.1" }, /BOOTSTRAP_PREVIEW_VERSION/],
]) {
  assert.throws(() => validateFirstStageAuthorization({
    ...base, npmTokenPresent: true, githubReadTokenPresent: true, ...change,
  }), message);
}

const MAIN = "https://api.github.com/repos/attention-spa/gh-plan/branches/main";
const REG = "https://registry.npmjs.org/@attention-spa%2fgh-plan";
function fakeRemote({ mainSha = sha, registryStatus = 404 } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    if (url === MAIN) {
      assert.equal(options.headers.Authorization, "Bearer " + base.githubReadToken);
      return { status: 200, redirected: false, url: MAIN, json: async () =>
        ({ commit: { sha: mainSha }, protected: true }) };
    }
    assert.equal(url, REG);
    assert.equal(options.headers.Authorization, undefined);
    return { status: registryStatus, redirected: false, url: REG };
  } };
}
const remote = fakeRemote();
const calls = [];
let fixturePath = null, authPath = null;
function fakeSpawn(cmd, args, options) {
  calls.push({ cmd, args, options });
  assert.equal(cmd, "npm");
  if (args[0] === "--version") return { status: 0, stdout: "11.15.0\n" };
  assert.deepEqual(args, [
    "stage", "publish", "--tag", "bootstrap", "--access", "public",
    "--ignore-scripts", "--registry", "https://registry.npmjs.org/",
  ]);
  fixturePath = options.cwd;
  authPath = options.env.npm_config_userconfig;
  assert(existsSync(authPath));
  assert.equal(statSync(authPath).mode & 0o777, 0o600);
  assert.match(readFileSync(authPath, "utf8"), /registry\.npmjs\.org\/:_authToken=/);
  assert(readFileSync(authPath, "utf8").includes(token));
  assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(options.env.BOOTSTRAP_NPM_STAGE_TOKEN, undefined);
  assert.equal(options.env.BOOTSTRAP_GITHUB_READ_TOKEN, undefined);
  assert.deepEqual(JSON.parse(readFileSync(options.cwd + "/package.json", "utf8")).version,
    "0.0.0-bootstrap.0");
  assert(!readFileSync(options.cwd + "/index.js", "utf8").includes(token));
  return { status: 0, stdout: "fake stage submitted", stderr: "" };
}
const result = await runAuthorizedFirstStage({
  ...base, fetchImpl: remote.fetchImpl, spawnImpl: fakeSpawn,
});
assert.equal(result.type, "npm-bootstrap-first-stage-submitted");
assert.equal(result.stagedVersion, "0.0.0-bootstrap.0");
assert.equal(result.realVersionPublished, false);
assert.equal(result.separatelyVerifyRegistryAndPendingStage, true);
assert(!JSON.stringify(result).includes(token));
assert.equal(calls.length, 2);
assert.equal(calls[0].args[0], "--version");
assert.equal(calls[1].args[0], "stage");
assert.deepEqual(remote.calls.map(x => x.url), [MAIN, REG]);
assert.equal(existsSync(fixturePath), false);
assert.equal(existsSync(authPath), false);
assert.equal(manifest.private, true);
assert.equal(manifest.version, "0.0.0");

for (const [name, change, expected] of [
  ["missing secret", { npmStageToken: "" }, /FIRST_STAGE_TOKEN_NOT_CONFIGURED/],
  ["unapproved", { consent: "false" }, /FIRST_STAGE_PLACEHOLDER_APPROVAL/],
  ["wrong sha", { approvedSha: "b".repeat(40) }, /FIRST_STAGE_APPROVED_SHA/],
  ["existing npm package", { fetchImpl: fakeRemote({ registryStatus: 200 }).fetchImpl },
    /BOOTSTRAP_STAGE_REGISTRY_HTTP/],
  ["moving main", { fetchImpl: fakeRemote({ mainSha: "b".repeat(40) }).fetchImpl },
    /BOOTSTRAP_STAGE_MAIN_SHA/],
]) {
  const attempted = [];
  await assert.rejects(runAuthorizedFirstStage({
    ...base, ...change, spawnImpl: (...args) => { attempted.push(args); return fakeSpawn(...args); },
  }), expected, name);
  assert.deepEqual(attempted, [], name + " must fail before npm subprocess.");
}

// If the only possible write reports failure, do not reveal any npm output
// containing credentials and NEVER initiate a second stage attempt.
let stageCalls = 0;
await assert.rejects(runAuthorizedFirstStage({
  ...base, fetchImpl: fakeRemote().fetchImpl, spawnImpl: (cmd, args, options) => {
    if (args[0] === "--version") return { status: 0, stdout: "11.15.0\n" };
    stageCalls++;
    return { status: 1, stdout: token, stderr: token };
  },
}), (error) => {
  assert.match(error.message, /FIRST_STAGE_OUTCOME_UNKNOWN_CHECK_NPM/);
  assert(!error.message.includes(token));
  return true;
});
assert.equal(stageCalls, 1);

// Read-only post-failure credential diagnosis: no npm writes, no raw
// stdout/stderr, no credential propagation beyond the bounded CLI child.
const diagGithub = {
  ...github,
  GITHUB_WORKFLOW_REF:
    "attention-spa/gh-plan/.github/workflows/npm-bootstrap-diagnose.yml@refs/heads/main",
};
const diagBase = {
  github: diagGithub, expectedSha: sha, token,
  env: {
    PATH: "/usr/bin", HOME: "/home/runner", TMPDIR: "/tmp",
    GH_TOKEN: "DO_NOT_PROPAGATE_GH", NODE_AUTH_TOKEN: "DO_NOT_PROPAGATE_NODE",
  },
};
let readCalls = 0;
let diagConfig = null;
const diag = diagnoseBootstrapNpm({
  ...diagBase,
  spawnImpl: (cmd, args, options) => {
    readCalls++;
    assert.equal(cmd, "npm");
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
    assert(!JSON.stringify(options.env).includes(token));
    diagConfig = options.env.npm_config_userconfig;
    assert.equal(statSync(diagConfig).mode & 0o777, 0o600);
    assert(readFileSync(diagConfig, "utf8").includes(token));
    if (args[0] === "whoami") {
      assert.deepEqual(args, ["whoami", "--registry", "https://registry.npmjs.org/"]);
      return { status: 0, stdout: "test-npm-user\n" };
    }
    assert.deepEqual(args, [
      "stage", "list", "@attention-spa/gh-plan", "--json",
      "--registry", "https://registry.npmjs.org/",
    ]);
    return { status: 0, stdout: JSON.stringify([
      { name: "@attention-spa/gh-plan", version: "0.0.0-bootstrap.0" },
    ]) };
  },
});
assert.deepEqual(diag, {
  type: "npm-bootstrap-readonly-diagnostic",
  npmAuthenticated: true, whoamiFailure: null,
  stagedPackageListReadable: true, bootstrapStageVisible: true,
  stageListFailure: null, registryWriteAttempted: false,
});
assert.equal(readCalls, 2);
assert.equal(existsSync(diagConfig), false);
assert(!JSON.stringify(diag).includes(token));
let failedCalls = 0;
const invalid = diagnoseBootstrapNpm({
  ...diagBase,
  spawnImpl: (cmd, args) => {
    failedCalls++;
    assert.equal(args[0], "whoami");
    return { status: 1, stdout: token, stderr: "npm error code E401\n" + token };
  },
});
assert.equal(failedCalls, 1, "Invalid authentication cannot reach stage list.");
assert.equal(invalid.npmAuthenticated, false);
assert.equal(invalid.whoamiFailure, "E401");
assert.equal(invalid.stageListFailure, "SKIPPED_NOT_AUTHENTICATED");
assert.equal(invalid.registryWriteAttempted, false);
assert(!JSON.stringify(invalid).includes(token));
const badList = diagnoseBootstrapNpm({
  ...diagBase,
  spawnImpl: (cmd, args) => args[0] === "whoami"
    ? { status: 0, stdout: "some-user" }
    : { status: 1, stdout: token, stderr: "npm error code E404\n" + token },
});
assert.equal(badList.npmAuthenticated, true);
assert.equal(badList.stagedPackageListReadable, false);
assert.equal(badList.bootstrapStageVisible, false);
assert.equal(badList.stageListFailure, "E404");
assert(!JSON.stringify(badList).includes(token));
assert.throws(() => assertBootstrapDiagnosticContext({
  ...diagBase, token: "",
}), /DIAG_TOKEN_ABSENT/);
assert.throws(() => assertBootstrapDiagnosticContext({
  ...diagBase, github: { ...diagGithub, GITHUB_ACTOR: "untrusted" },
}), /DIAG_ACTOR/);

console.log("First-stage single-write contract and hostile-context tests passed.");
