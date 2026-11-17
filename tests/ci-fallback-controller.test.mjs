import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  actionsApi, checkContext, orchestrate, QUEUE_MS,
} from "../scripts/ci-fallback-controller.mjs";

const SHA = "a".repeat(40), CORRELATION = "51-0123456789abcdef";
const ID = 51;
const makeLog = () => [];
function fake(mode) {
  let elapsed = 0, firstReads = 0, secondReads = 0, cancelled = false;
  let cancelCalls = 0;
  const dispatches = [], log = [];
  const queued = { status: "queued", conclusion: null,
    jobs: [{ status: "queued", started_at: null, conclusion: null }] };
  const running = { status: "in_progress", conclusion: null,
    jobs: [{ status: "in_progress", started_at: "2026-11-16T10:00:00Z", conclusion: null }] };
  const passed = { status: "completed", conclusion: "success",
    jobs: [{ status: "completed", started_at: "2026-11-16T10:00:00Z", conclusion: "success" }] };
  const failed = { status: "completed", conclusion: "failure",
    jobs: [{ status: "completed", started_at: "2026-11-16T10:00:00Z", conclusion: "failure" }] };
  const beforeStartCancelled = { status: "completed", conclusion: "cancelled",
    jobs: [{ status: "completed", started_at: null, conclusion: "cancelled" }] };
  const api = {
    async dispatch(expected) {
      dispatches.push(expected.backend);
      if (mode === "unknown-dispatch") throw Error("CI_FALLBACK_UNKNOWN_DISPATCH");
      return expected.backend === "oci" ? 10 : 20;
    },
    async inspect(runId) {
      if (mode === "http-error") throw Error("CI_FALLBACK_HTTP_403");
      if (runId === 20) {
        secondReads++;
        return secondReads === 1 ? queued : secondReads === 2 ? running : passed;
      }
      assert.equal(runId, 10, "Must inspect only our own run IDs.");
      firstReads++;
      if (mode === "invalid-job" && firstReads === 1) return {
        status: "in_progress", jobs: [{}, {}], conclusion: null,
      };
      if (cancelled) {
        if (mode === "cancel-race") return { status: "completed", conclusion: "cancelled",
          jobs: [{ status: "completed", started_at: "2026-11-16T10:00:00Z",
            conclusion: "cancelled" }] };
        if (mode === "cancel-other-outcome") return failed;
        return beforeStartCancelled;
      }
      if (mode === "offline" || mode === "cancel-race" ||
          mode === "cancel-denied" || mode === "cancel-other-outcome")
        return queued;
      if (mode === "reread-started") {
        if (elapsed < 30 || firstReads < 5) return queued;
        return firstReads === 5 ? running : passed;
      }
      if (mode === "running-stuck") return firstReads === 1 ? queued : running;
      if (mode === "tests-fail") return firstReads === 1 ? queued : failed;
      return firstReads === 1 ? queued : firstReads === 2 ? running : passed;
    },
    async cancel(id) {
      assert.equal(id, 10, "Cannot cancel unrelated workflow runs.");
      cancelCalls++;
      if (mode === "cancel-denied") throw Error("CI_FALLBACK_HTTP_403");
      cancelled = true;
    },
  };
  const abort = new AbortController();
  return {
    api, log, dispatches, abort,
    get cancelCalls() { return cancelCalls; },
    get elapsed() { return elapsed; },
    async run(extra = {}) {
      return orchestrate({
        api, sha: SHA, parentRunId: ID, correlation: CORRELATION,
        now: () => elapsed, sleep: async (ms) => { elapsed += ms; },
        pollMs: 10, queueMs: 30, totalMs: 130,
        report: (entry) => log.push(entry), signal: abort.signal, ...extra,
      });
    },
  };
}
const success = fake("normal");
assert.deepEqual(await success.run(), { backend: "oci", runId: 10 });
assert.deepEqual(success.dispatches, ["oci"]);
assert.equal(success.cancelCalls, 0);
assert.deepEqual(success.log.map(x => x.state), ["dispatched", "passed"]);

const offline = fake("offline");
assert.deepEqual(await offline.run(), {
  backend: "hosted", runId: 20, cancelledOciRunId: 10,
});
assert.deepEqual(offline.dispatches, ["oci", "hosted"]);
assert.equal(offline.cancelCalls, 1);
assert.deepEqual(offline.log.map(x => x.state), [
  "dispatched", "cancelled_before_start", "dispatched", "passed",
]);
assert.ok(offline.elapsed >= 30, "OCI must get its queue deadline first.");
for (const [mode, message] of [
  ["cancel-race", /CI_FALLBACK_CANCELLATION_RACE/],
  ["cancel-denied", /CI_FALLBACK_HTTP_403/],
  ["cancel-other-outcome", /CI_FALLBACK_CANCELLATION_RACE/],
  ["tests-fail", /CI_FALLBACK_WORKER_FAILED/],
  ["running-stuck", /CI_FALLBACK_CONTROLLER_TIMEOUT/],
  ["unknown-dispatch", /CI_FALLBACK_UNKNOWN_DISPATCH/],
  ["http-error", /CI_FALLBACK_HTTP_403/],
  ["invalid-job", /CI_FALLBACK_INVALID_STATE/],
]) {
  const scenario = fake(mode);
  await assert.rejects(scenario.run(), message, mode);
  assert.deepEqual(scenario.dispatches.includes("hosted"), false,
    mode + " must never launch a duplicate worker.");
}
const recheck = fake("reread-started");
assert.deepEqual(await recheck.run(), { backend: "oci", runId: 10 });
assert.equal(recheck.cancelCalls, 0,
  "A worker that starts during pre-cancellation recheck must continue on OCI.");
const aborted = fake("offline");
await assert.rejects(aborted.run({
  sleep: async () => { aborted.abort.abort(); },
}), /CI_FALLBACK_INTERRUPTED/);
assert.equal(aborted.cancelCalls, 1, "Parent cancellation attempts child cleanup.");
assert.deepEqual(aborted.dispatches, ["oci"]);
const malicious = fake("normal");
await assert.rejects(malicious.run({ sha: "a; rm -rf /" }), /CI_FALLBACK_INVALID_INPUT/);
assert.deepEqual(malicious.dispatches, [], "Invalid input must not dispatch a worker.");
const wrongEvent = {
  GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "attention-spa/gh-plan", GITHUB_SHA: SHA,
  GITHUB_RUN_ID: "51", GITHUB_TOKEN: "injected-secret",
};
assert.throws(() => checkContext(wrongEvent), /CI_FALLBACK_UNTRUSTED_CONTEXT/);
assert.throws(() => checkContext({ ...wrongEvent, GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "other/repo" }), /CI_FALLBACK_UNTRUSTED_CONTEXT/);
assert.deepEqual(checkContext({ ...wrongEvent, GITHUB_EVENT_NAME: "push" }),
  { sha: SHA, runId: 51, token: "injected-secret" });

function json(status, data) {
  return { status, json: async () => data };
}
const title = "CI worker " + CORRELATION + " oci " + SHA;
const apiEvents = [];
const token = "secret-token-never-log";
const mockFetch = async (url, opts) => {
  apiEvents.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
  const path = new URL(url).pathname;
  if (path.endsWith("/actions/workflows/ci-worker.yml"))
    return json(200, { id: 444, path: ".github/workflows/ci-worker.yml" });
  if (path.endsWith("/dispatches")) {
    const submitted = JSON.parse(opts.body);
    assert.equal(submitted.return_run_details, true);
    assert.equal(submitted.ref, "main");
    assert.equal(submitted.inputs.sha, SHA);
    assert.equal(submitted.inputs.backend, "oci");
    assert.equal(submitted.inputs.parent_run_id, "51");
    return json(200, { workflow_run_id: 123 });
  }
  if (path.endsWith("/actions/runs/123")) return json(200, {
    id: 123, workflow_id: 444, event: "workflow_dispatch",
    head_branch: "main", run_attempt: 1, display_title: title,
    repository: { full_name: "attention-spa/gh-plan" },
    status: "completed", conclusion: "success",
  });
  if (path.endsWith("/actions/runs/123/jobs")) return json(200, {
    total_count: 1,
    jobs: [{ run_id: 123, status: "completed",
      started_at: "2026-11-16T10:00:00Z", conclusion: "success" }],
  });
  if (path.endsWith("/actions/runs/123/cancel")) return {
    status: 202, json: async () => { throw Error("Cancelled HTTP body is empty."); },
  };
  throw Error("Unexpected API endpoint: " + path);
};
const expected = { backend: "oci", sha: SHA, correlation: CORRELATION };
const transport = actionsApi({ token, fetchImpl: mockFetch });
assert.equal(await transport.dispatch(expected, 51), 123);
assert.equal((await transport.inspect(123, expected)).conclusion, "success");
await transport.cancel(123);
assert.ok(apiEvents.every(x => x.headers.Authorization === "Bearer " + token));
assert.ok(apiEvents.every(x => x.headers["X-GitHub-Api-Version"] === "2026-03-10"));
assert.ok(apiEvents.every(x => x.url.startsWith("https://api.github.com/repos/attention-spa/gh-plan/actions/")));
assert.ok(!JSON.stringify(apiEvents.map(x => x.url)).includes(token));

const oldApi = actionsApi({
  token, now: () => 1_800_000_000_000, sleep: async () => {},
  fetchImpl: async (url, opts) => {
    if (url.endsWith("/workflows/ci-worker.yml"))
      return json(200, { id: 444, path: ".github/workflows/ci-worker.yml" });
    if (url.endsWith("/dispatches")) return { status: 204 };
    if (url.includes("/runs?")) return json(200, { workflow_runs: [{
      id: 789, workflow_id: 444, event: "workflow_dispatch", head_branch: "main",
      repository: { full_name: "attention-spa/gh-plan" },
      display_title: title, created_at: new Date(1_800_000_000_000).toISOString(),
    }] });
    throw Error("Unexpected legacy API request " + url);
  },
});
assert.equal(await oldApi.dispatch(expected, 51), 789,
  "Older HTTP 204 dispatch responses must use uniquely correlated discovery.");
const ambiguous = actionsApi({
  token, now: () => 1_800_000_000_000, sleep: async () => {},
  fetchImpl: async (url) => {
    if (url.endsWith("/workflows/ci-worker.yml"))
      return json(200, { id: 444, path: ".github/workflows/ci-worker.yml" });
    if (url.endsWith("/dispatches")) return { status: 204 };
    if (url.includes("/runs?")) {
      const record = {
        id: 789, workflow_id: 444, event: "workflow_dispatch",
        head_branch: "main", repository: { full_name: "attention-spa/gh-plan" },
        display_title: title, created_at: new Date(1_800_000_000_000).toISOString(),
      };
      return json(200, { workflow_runs: [record, { ...record, id: 790 }] });
    }
    throw Error("Unexpected legacy request " + url);
  },
});
await assert.rejects(ambiguous.dispatch(expected, 51),
  /CI_FALLBACK_AMBIGUOUS_DISPATCH/,
  "Two matching legacy runs must abort without guessing or re-dispatching.");

for (const code of [403, 429, 503]) {
  const bad = actionsApi({
    token, fetchImpl: async () => json(code, { message: "secret-token-never-log" }),
  });
  await assert.rejects(bad.dispatch(expected, 51),
    new RegExp("CI_FALLBACK_HTTP_" + code));
}
let temporaryRunReads = 0;
const hydrated = actionsApi({
  token, sleep: async () => {},
  fetchImpl: async (url) => {
    if (url.endsWith("/workflows/ci-worker.yml"))
      return json(200, { id: 444, path: ".github/workflows/ci-worker.yml" });
    if (url.endsWith("/runs/123")) {
      temporaryRunReads++;
      return json(200, {
        id: 123, workflow_id: 444, event: "workflow_dispatch",
        head_branch: "main", run_attempt: 1,
        repository: temporaryRunReads < 3 ? null : { full_name: "attention-spa/gh-plan" },
        display_title: temporaryRunReads < 3 ? "CI worker" : title,
        status: "completed", conclusion: "success",
      });
    }
    if (url.includes("/runs/123/jobs?")) return json(200, {
      total_count: 1, jobs: [{
        run_id: 123, status: "completed",
        started_at: "2026-11-16T10:00:00Z", conclusion: "success",
      }],
    });
    throw Error("Unexpected hydration request " + url);
  },
});
assert.equal((await hydrated.inspect(123, expected)).conclusion, "success",
  "Fresh workflow run IDs may precede the repository/run-name read model.");
assert.equal(temporaryRunReads, 3,
  "Run-identity reads must converge before the controller proceeds.");

const mismatch = actionsApi({
  token, sleep: async () => {}, fetchImpl: async (url) => url.endsWith("/workflows/ci-worker.yml")
    ? json(200, { id: 444, path: ".github/workflows/ci-worker.yml" })
    : json(200, { workflow_run_id: 123, display_title: "malicious" }),
});
assert.equal(await mismatch.dispatch(expected, 51), 123,
  "Run IDs are accepted provisionally; inspect must independently check identity.");
await assert.rejects(mismatch.inspect(123, expected), /CI_FALLBACK_RUN_IDENTITY/);

// Guard against expression delimiter regressions that YAML itself accepts but Actions rejects.
for (const file of ["ci.yml", "ci-worker.yml"]) {
  const yamlSource = readFileSync(new URL("../.github/workflows/" + file, import.meta.url), "utf8");
  const starts = (yamlSource.match(/\$\{\{/g) ?? []).length;
  const closed = (yamlSource.match(/\$\{\{[^\n]*?\}\}/g) ?? []).length;
  assert.equal(starts, closed, file + " must close every GitHub Actions expression with }}.");
}
const ci = YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const worker = YAML.parse(readFileSync(new URL("../.github/workflows/ci-worker.yml", import.meta.url), "utf8"));
assert.deepEqual(ci.on.push.branches, ["main"]);
assert.ok(Object.hasOwn(ci.on, "pull_request"));
assert.equal(ci.permissions.contents, "read");
assert.equal(ci.jobs.contracts["runs-on"], "ubuntu-latest");
assert.equal(ci.jobs.contracts.permissions.actions, undefined);
assert.equal(ci.jobs["main-controller"]["runs-on"], "ubuntu-latest");
assert.equal(ci.jobs["main-controller"].permissions.actions, "write");
assert.match(ci.jobs.contracts.if, /pull_request/);
assert.match(ci.jobs["main-controller"].if, /push.*main/);
assert.ok(!Object.hasOwn(ci.on, "pull_request_target"));
assert.equal(worker.permissions.contents, "read");
assert.equal(worker.jobs["contracts-worker"].permissions.actions, undefined);
assert.match(worker.jobs["contracts-worker"]["runs-on"], /self-hosted.*Linux.*trusted/);
assert.match(worker.jobs["contracts-worker"]["runs-on"], /ubuntu-latest/);
assert.match(worker.jobs["contracts-worker"].steps[1].run, /git merge-base --is-ancestor/);
assert.match(worker.jobs["contracts-worker"].steps[1].run, /git checkout --detach/);
assert.deepEqual(worker.on.workflow_dispatch.inputs.backend.options, ["oci", "hosted"]);
const expectedCommands = [
  "npm ci --ignore-scripts --no-audit --no-fund",
  "npm run schema:check", "npm run docs:check", "npm test",
  "npm run build", "npm run test:dist",
];
// #203: a committed npm lock is the single source for PR and trusted-main CI.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const locked = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.equal(locked.lockfileVersion, 3, "npm ci requires a v3 lockfile.");
assert.equal(locked.name, manifest.name);
assert.equal(locked.version, manifest.version);
assert.equal(locked.packages[""].name, manifest.name);
assert.equal(locked.packages[""].version, manifest.version);
assert.deepEqual(locked.packages[""].devDependencies, manifest.devDependencies,
  "Root lock dependencies must equal the unchanged pinned manifest.");
for (const [name, entry] of Object.entries(locked.packages)) {
  if (!name) continue;
  assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/=]+$/,
    "Every resolved dependency must have an integrity hash: " + name);
}
// #206: fail deterministic CI if the known reviewed dev-only advisories return.
// Upstream ts-json-schema-generator currently requests glob ^13, so this narrow
// override is intentional until the schema generator supports a patched major.
assert.deepEqual(manifest.overrides, { "ts-json-schema-generator": { glob: "14.0.2" } });
const securityFloors = new Map([
  ["ajv", [8, 18, 0]], ["yaml", [2, 8, 3]],
  ["glob", [14, 0, 2]], ["minimatch", [11, 0, 1]],
]);
function semverAtLeast(version, floor) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:$|-)/.exec(version ?? "");
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    const current = Number(parts[i + 1]);
    if (current !== floor[i]) return current > floor[i];
  }
  return true;
}
for (const [name, floor] of securityFloors) {
  const matches = Object.entries(locked.packages).filter(([path]) =>
    path.endsWith("node_modules/" + name));
  assert(matches.length, "Missing reviewed package: " + name);
  for (const [path, entry] of matches) {
    assert(semverAtLeast(entry.version, floor),
      "Reviewed security floor violated at " + path + "@" + entry.version);
  }
}
assert.equal(manifest.devDependencies.ajv, locked.packages["node_modules/ajv"].version);
assert.equal(manifest.devDependencies.yaml, locked.packages["node_modules/yaml"].version);
for (const workflow of [ci, worker]) {
  const job = workflow.jobs.contracts ?? workflow.jobs["contracts-worker"];
  const commands = job.steps.filter((step) => typeof step.run === "string")
    .map((step) => step.run);
  assert(!commands.some((cmd) => /\\bnpm install\\b|\\bnpm update\\b/.test(cmd)),
    "CI must not resolve a fresh dependency graph outside the lock.");
}
for (const command of expectedCommands) {
  assert.ok(ci.jobs.contracts.steps.some((s) => s.run === command),
    "PR CI still runs " + command);
  assert.ok(worker.jobs["contracts-worker"].steps.some((s) => s.run === command),
    "OCI and hosted workers run " + command);
}
assert.equal(QUEUE_MS, 180_000, "Operator-approved queue limit is three minutes.");
console.log("OCI-first main CI failover, API contract, and workflow isolation tests passed.");
