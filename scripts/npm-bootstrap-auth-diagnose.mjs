import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const PACKAGE = "@attention-spa/gh-plan";
const CANDIDATE = "0.0.0-bootstrap.0";
const WORKFLOW = "attention-spa/gh-plan/.github/workflows/npm-bootstrap-diagnose.yml@refs/heads/main";

export function assertBootstrapDiagnosticContext({ github, expectedSha, token }) {
  assert.equal(github.GITHUB_ACTIONS, "true", "DIAG_NOT_ACTIONS");
  assert.equal(github.GITHUB_EVENT_NAME, "workflow_dispatch", "DIAG_EVENT");
  assert.equal(github.GITHUB_REPOSITORY, "attention-spa/gh-plan", "DIAG_REPO");
  assert.equal(github.GITHUB_ACTOR, "agent-hachi", "DIAG_ACTOR");
  assert.equal(github.GITHUB_TRIGGERING_ACTOR, "agent-hachi", "DIAG_TRIGGER");
  assert.equal(github.GITHUB_REF, "refs/heads/main", "DIAG_REF");
  assert.equal(github.GITHUB_WORKFLOW_REF, WORKFLOW, "DIAG_WORKFLOW");
  assert.match(expectedSha ?? "", /^[a-f0-9]{40}$/, "DIAG_SHA_FORMAT");
  assert.equal(github.GITHUB_SHA, expectedSha, "DIAG_SHA");
  assert.equal(typeof token === "string" && token.length > 0, true, "DIAG_TOKEN_ABSENT");
}

function reason(stderr = "") {
  // Never return untrusted output or a free-form CLI error. npm's stderr
  // may include auth context, personal information, or token material.
  if (/\bE401\b/i.test(stderr)) return "E401";
  if (/\bE403\b/i.test(stderr)) return "E403";
  if (/\bENEEDAUTH\b/i.test(stderr)) return "ENEEDAUTH";
  if (/\bE404\b/i.test(stderr)) return "E404";
  if (/\bEOTP\b/i.test(stderr)) return "EOTP";
  return "OTHER";
}

function safeNpm(spawnImpl, args, options) {
  try {
    const p = spawnImpl("npm", args, options);
    return {
      success: p?.status === 0,
      stdout: p?.status === 0 ? String(p.stdout ?? "") : "",
      failure: p?.status === 0 ? null : reason(String(p?.stderr ?? "")),
    };
  } catch {
    return { success: false, stdout: "", failure: "SUBPROCESS_ERROR" };
  }
}

// Read-only diagnostic after ONE failed/ambiguous stage attempt.
// Auth config exists only in 0600 temporary storage. Never print npm output.
export function diagnoseBootstrapNpm({
  github, expectedSha, token, spawnImpl = spawnSync, env = process.env,
}) {
  assertBootstrapDiagnosticContext({ github, expectedSha, token });
  const root = mkdtempSync(join(tmpdir(), "gh-plan-npm-diagnostic-"));
  const config = join(root, "npm-auth");
  try {
    writeFileSync(config,
      "registry=" + REGISTRY + "\n" +
      "//registry.npmjs.org/:_authToken=" + token + "\n",
      { flag: "wx", mode: 0o600 });
    const options = {
      encoding: "utf8", timeout: 30_000,
      env: {
        PATH: env.PATH ?? "", HOME: env.HOME ?? "",
        TMPDIR: env.TMPDIR ?? "/tmp",
        npm_config_userconfig: config,
        npm_config_update_notifier: "false",
        npm_config_audit: "false",
      },
    };
    const whoami = safeNpm(spawnImpl,
      ["whoami", "--registry", REGISTRY], options);
    if (!whoami.success) {
      return Object.freeze({
        type: "npm-bootstrap-readonly-diagnostic",
        npmAuthenticated: false, whoamiFailure: whoami.failure,
        stagedPackageListReadable: false, bootstrapStageVisible: false,
        stageListFailure: "SKIPPED_NOT_AUTHENTICATED",
        registryWriteAttempted: false,
      });
    }
    const list = safeNpm(spawnImpl,
      ["stage", "list", PACKAGE, "--json", "--registry", REGISTRY], options);
    return Object.freeze({
      type: "npm-bootstrap-readonly-diagnostic",
      npmAuthenticated: true, whoamiFailure: null,
      stagedPackageListReadable: list.success,
      bootstrapStageVisible: list.success && list.stdout.includes(CANDIDATE),
      stageListFailure: list.failure,
      registryWriteAttempted: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = diagnoseBootstrapNpm({
    github: process.env, expectedSha: process.env.DIAG_EXPECTED_SHA,
    token: process.env.DIAG_NPM_TOKEN,
  });
  console.log(JSON.stringify(result));
}
