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

// #186: a newly dispatched positive ID may briefly return 404 before the
// run GET exists. This is GET-only convergence, never permission to re-dispatch.
function visibilityFixture(responses, { jobs404 = false } = {}) {
  let reads = 0, jobs = 0;
  const dispatchBackends = [], sleeps = [];
  const valid = {
    id: 123, workflow_id: 444, event: "workflow_dispatch",
    head_branch: "main", run_attempt: 1, display_title: title,
    repository: { full_name: "attention-spa/gh-plan" },
    status: "completed", conclusion: "success",
  };
  const api = actionsApi({
    token, sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (url, opts) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/workflows/ci-worker.yml"))
        return json(200, { id: 444, path: ".github/workflows/ci-worker.yml" });
      if (path.endsWith("/dispatches")) {
        const input = JSON.parse(opts.body);
        dispatchBackends.push(input.inputs.backend);
        return json(200, { workflow_run_id: 123 });
      }
      if (path.endsWith("/runs/123")) {
        const answer = responses[Math.min(reads++, responses.length - 1)];
        if (Number.isInteger(answer))
          return json(answer, { message: "secret-token-never-log" });
        if (answer === "incomplete")
          return json(200, { ...valid, repository: null });
        if (answer === "wrong")
          return json(200, { ...valid, display_title: "different-run" });
        assert.equal(answer, "valid", "Unexpected visibility fixture response.");
        return json(200, valid);
      }
      if (path.endsWith("/runs/123/jobs")) {
        jobs++;
        if (jobs404) return json(404, { message: "secret-token-never-log" });
        return json(200, { total_count: 1, jobs: [{
          run_id: 123, status: "completed",
          started_at: "2026-11-16T10:00:00Z", conclusion: "success",
        }] });
      }
      throw Error("Unexpected visibility fixture endpoint: " + path);
    },
  });
  return {
    api, dispatchBackends, sleeps,
    get reads() { return reads; },
    get jobs() { return jobs; },
    run() {
      return orchestrate({
        api, sha: SHA, parentRunId: ID, correlation: CORRELATION,
        now: () => 0, sleep: async () => {},
        queueMs: 30_000, pollMs: 1_000, totalMs: 100_000,
      });
    },
  };
}

const delayedVisibility = visibilityFixture([404, 404, "valid"]);
assert.deepEqual(await delayedVisibility.run(), { backend: "oci", runId: 123 });
assert.equal(delayedVisibility.reads, 3);
assert.equal(delayedVisibility.jobs, 1);
assert.deepEqual(delayedVisibility.sleeps, [2_000, 2_000]);
assert.deepEqual(delayedVisibility.dispatchBackends, ["oci"],
  "A delayed GET must not dispatch a second worker.");

const neverVisible = visibilityFixture([404]);
await assert.rejects(neverVisible.run(), /CI_FALLBACK_HTTP_404/);
assert.equal(neverVisible.reads, 7, "Bound previsibility GETs to seven requests.");
assert.deepEqual(neverVisible.sleeps, Array(6).fill(2_000));
assert.equal(neverVisible.jobs, 0);
assert.deepEqual(neverVisible.dispatchBackends, ["oci"],
  "An unresolved 404 must not initiate hosted fallback or a duplicate POST.");

const previouslyObserved = visibilityFixture(["valid", 404]);
assert.equal(await previouslyObserved.api.dispatch(expected, 51), 123);
assert.equal((await previouslyObserved.api.inspect(123, expected)).conclusion, "success");
await assert.rejects(previouslyObserved.api.inspect(123, expected), /CI_FALLBACK_HTTP_404/);
assert.equal(previouslyObserved.reads, 2);
assert.deepEqual(previouslyObserved.sleeps, [],
  "A 404 after a prior 200 must never be retried.");

const partiallyObserved = visibilityFixture(["incomplete", 404, "valid"]);
assert.equal(await partiallyObserved.api.dispatch(expected, 51), 123);
await assert.rejects(partiallyObserved.api.inspect(123, expected), /CI_FALLBACK_HTTP_404/);
assert.equal(partiallyObserved.reads, 2,
  "A 404 following even a partial HTTP 200 must fail closed.");
assert.deepEqual(partiallyObserved.dispatchBackends, ["oci"]);

const falseIdentity = visibilityFixture(["wrong"]);
await assert.rejects(falseIdentity.run(), /CI_FALLBACK_RUN_IDENTITY_TITLE/);
assert.equal(falseIdentity.reads, 7);
assert.deepEqual(falseIdentity.dispatchBackends, ["oci"],
  "A mismatched run must not spawn an alternative worker.");

for (const http of [403, 429, 503]) {
  const rejected = visibilityFixture([http]);
  await assert.rejects(rejected.run(), new RegExp("CI_FALLBACK_HTTP_" + http));
  assert.equal(rejected.reads, 1, "Only a previsibility 404 may retry.");
  assert.deepEqual(rejected.sleeps, []);
  assert.deepEqual(rejected.dispatchBackends, ["oci"]);
}
const missingJobs = visibilityFixture(["valid"], { jobs404: true });
await assert.rejects(missingJobs.run(), /CI_FALLBACK_HTTP_404/);
assert.equal(missingJobs.reads, 1);
assert.equal(missingJobs.jobs, 1);
assert.deepEqual(missingJobs.sleeps, [],
  "404 retries apply only to the run GET, not the jobs endpoint.");
assert.deepEqual(missingJobs.dispatchBackends, ["oci"]);

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
// #227: immutable GitHub-verified first-party Actions only. Walk ALL workflow
// jobs, including manually dispatched bootstrap and OCI worker variants.
const expectedActionPins = new Map([
  ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
]);
for (const file of [
  "ci.yml", "ci-worker.yml", "bootstrap-dry-run.yml", "bootstrap-worker.yml",
  "npm-release-preflight.yml", "npm-bootstrap-preview.yml",
]) {
  const source = readFileSync(new URL("../.github/workflows/" + file, import.meta.url), "utf8");
  const workflow = YAML.parse(source);
  assert(workflow && typeof workflow.jobs === "object", file + " missing jobs.");
  let checked = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert(Array.isArray(job.steps), file + " missing steps in " + jobName);
    for (const [stepIndex, step] of job.steps.entries()) {
      if (!Object.hasOwn(step, "uses")) continue;
      const ref = step.uses;
      const match = typeof ref === "string"
        ? /^(actions\/(?:checkout|setup-node))@([a-f0-9]{40})$/.exec(ref)
        : null;
      assert(match,
        file + " job " + jobName + " step " + stepIndex +
        " must use a reviewed first-party 40-hex commit reference, not " + String(ref));
      assert.equal(match[2], expectedActionPins.get(match[1]),
        file + " job " + jobName + " action ref differs from reviewed commit.");
      checked++;
    }
  }
  assert.equal(checked, file === "ci.yml" ? 6 : 2,
    "Every existing first-party action use must be pinned in " + file);
}
// #235: manually dispatched prerelease preview cannot request registry-write
// credentials, create a tag or stage/publish. Never run release input on OCI.
const preflightSource = readFileSync(
  new URL("../.github/workflows/npm-release-preflight.yml", import.meta.url), "utf8");
const preflight = YAML.parse(preflightSource);
assert.deepEqual(Object.keys(preflight.on), ["workflow_dispatch"],
  "Release preflight must not run on push, PR, tags or privilege-bearing events.");
assert.deepEqual(preflight.on.workflow_dispatch.inputs.version.options, ["0.1.0-beta.1"]);
assert.equal(preflight.on.workflow_dispatch.inputs.version.type, "choice");
assert.deepEqual(preflight.permissions, { contents: "read" });
assert.deepEqual(Object.keys(preflight.jobs), ["preflight"]);
const previewJob = preflight.jobs.preflight;
assert.equal(previewJob["runs-on"], "ubuntu-latest",
  "Release preflight must never run on a persistent self-hosted OCI runner.");
assert.deepEqual(previewJob.permissions, { contents: "read" },
  "Preflight must not receive OIDC, actions-write or registry capabilities.");
assert(previewJob.steps.length >= 8);
assert.deepEqual(previewJob.steps.filter(step => typeof step.run === "string")
  .map(step => step.run).slice(0, 2),
  ["node scripts/release-preflight.mjs",
    "npm ci --ignore-scripts --no-audit --no-fund"]);
const previewStep = previewJob.steps.find(step => step.run === "node scripts/release-preflight.mjs");
assert.equal(previewStep.env.RELEASE_TARGET_TAG, "v0.1.0-beta.1");
assert.match(previewStep.env.RELEASE_TARGET_VERSION, /inputs.version/);
assert(previewJob.steps.some(step => step.run === "npm run test:consumer"));
assert(previewJob.steps.some(step =>
  step.run === "npm pack --dry-run --json --ignore-scripts"));
assert(!preflightSource.includes("id-token") && !preflightSource.includes("secrets."),
  "Preflight must not request an OIDC publishing token or access secrets.");
for (const step of previewJob.steps) {
  const run = step.run ?? "";
  assert(!/\\bnpm\\s+(?:stage|publish|trust|dist-tag|version|login)\\b|\\bgit\\s+tag\\b|\\bgh\\s+release\\b/.test(run),
    "No release or registry mutation is authorized in this workflow.");
}
// #240: first-package bootstrap preview is an OFFLINE test, never a stage.
// Inspect parsed commands, token permissions, events and trusted hosted runner.
const bootstrapPreviewText = readFileSync(
  new URL("../.github/workflows/npm-bootstrap-preview.yml", import.meta.url), "utf8");
const bootstrapPreview = YAML.parse(bootstrapPreviewText);
assert.deepEqual(Object.keys(bootstrapPreview.on), ["workflow_dispatch"]);
assert.deepEqual(bootstrapPreview.on.workflow_dispatch.inputs.version.options,
  ["0.0.0-bootstrap.0"]);
assert.equal(bootstrapPreview.on.workflow_dispatch.inputs.version.type, "choice");
assert.deepEqual(bootstrapPreview.permissions, { contents: "read" });
assert.deepEqual(Object.keys(bootstrapPreview.jobs), ["bootstrap-preview"]);
const bootstrapJob = bootstrapPreview.jobs["bootstrap-preview"];
assert.equal(bootstrapJob["runs-on"], "ubuntu-latest",
  "Bootstrap preview must use ephemeral hosted infrastructure.");
assert.deepEqual(bootstrapJob.permissions, { contents: "read" },
  "Bootstrap preview MUST NOT receive npm/OIDC/Actions write permissions.");
assert.equal(bootstrapJob.steps.length, 7);
assert.equal(bootstrapJob.steps[2].run, "node scripts/npm-bootstrap-preview.mjs");
assert.equal(bootstrapJob.steps[2].env.BOOTSTRAP_PREVIEW_TAG, "bootstrap");
assert.match(bootstrapJob.steps[2].env.BOOTSTRAP_PREVIEW_VERSION, /inputs.version/);
assert(bootstrapJob.steps.some(step => step.run === "npm run test:bootstrap-preview"));
assert(bootstrapJob.steps.some(step => step.run === "npm run test:ci-fallback"));
assert(!/id-token|secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|NODE_OPTIONS/.test(bootstrapPreviewText),
  "Bootstrap preview MUST NOT receive an authentication mechanism.");
for (const step of bootstrapJob.steps) {
  const cmd = step.run ?? "";
  assert(!/\bnpm\s+(?:stage|publish|trust|dist-tag|token|version|login)\b|\bgit\s+tag\b|\bgh\s+release\b/.test(cmd),
    "Bootstrap preview MUST NOT mutate npm registry, Git tags, or release identity.");
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
  "npm run build", "npm run test:dist", "npm run test:consumer",
];
// #203: a committed npm lock is the single source for PR and trusted-main CI.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const locked = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
// #209: independently install the actual packed tarball on Node 22/24.
assert.equal(manifest.scripts["test:consumer"], "node tests/tarball-consumer.test.mjs");
const smoke24 = ci.jobs["consumer-node24"];
assert(smoke24, "Hosted Node 24 consumer verification must exist.");
assert.equal(smoke24["runs-on"], "ubuntu-latest");
assert.equal(smoke24.permissions.contents, "read");
assert.equal(smoke24.permissions.actions, undefined);
assert.equal(smoke24.permissions["id-token"], undefined);
assert.equal(smoke24.steps[1].with["node-version"], 24);
assert.deepEqual(smoke24.steps.filter((s) => typeof s.run === "string")
  .map((s) => s.run), [
  "npm ci --ignore-scripts --no-audit --no-fund",
  "git diff --exit-code -- package.json package-lock.json",
  "npm audit --package-lock-only --audit-level=moderate",
  "npm run build", "npm run test:dist", "npm run test:consumer",
]);
// #211: audit is an unconditional, failure-propagating, hosted-only PR+main
// check against every locked package (including dev dependencies).
const audit = smoke24.steps.filter((step) => typeof step.run === "string" &&
  step.run.includes("npm audit"));
assert.equal(audit.length, 1, "Exactly one hosted audit must be enforced.");
assert.equal(audit[0].run, "npm audit --package-lock-only --audit-level=moderate");
assert.equal(audit[0]["continue-on-error"], undefined,
  "Dependency advisories must not be swallowed by continue-on-error.");
assert.equal(audit[0].if, undefined,
  "Hosted dependency audit must execute for PRs and main without condition.");
assert.equal(audit[0].env, undefined,
  "Hosted dependency audit must never receive extra registry credentials.");
for (const job of [ci.jobs.contracts, worker.jobs["contracts-worker"]]) {
  assert(!job.steps.some((step) => (step.run ?? "").includes("npm audit")),
    "Security auditing must stay on the hosted Node24 worker.");
}
const baseline = readFileSync(new URL("../docs/security-baseline.md", import.meta.url), "utf8");
for (const needle of ["CodeQL", "secret-scanning", "Dependabot", "#186", "BLOCKED"]) {
  assert(baseline.includes(needle), "Security policy must document " + needle);
}
assert.equal(worker.jobs["contracts-worker"].steps.find(
  (step) => step.uses?.startsWith("actions/setup-node@"))?.with["node-version"], 22,
"OCI stays on the tested Node 22 trust path; Node 24 is hosted-only.");
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
