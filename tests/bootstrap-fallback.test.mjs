import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { actionsApi, checkContext, orchestrate, QUEUE_MS } from "../scripts/ci-fallback-controller.mjs";

const SHA = "a".repeat(40);
const CORR = "77-0123456789abcdef";
const name = "Bootstrap worker " + CORR + " oci " + SHA;
const yaml = (file) => YAML.parse(readFileSync(
  new URL("../.github/workflows/" + file, import.meta.url), "utf8"));
const coordinator = yaml("bootstrap-dry-run.yml");
const worker = yaml("bootstrap-worker.yml");
const ci = yaml("ci.yml");
const ciWorker = yaml("ci-worker.yml");
assert.deepEqual(Object.keys(coordinator.on), ["workflow_dispatch"]);
assert.equal(coordinator.permissions.contents, "read");
assert.equal(coordinator.permissions.actions, undefined);
const job = coordinator.jobs["bootstrap-controller"];
assert.match(job.if, /refs\/heads\/main/);
assert.match(job.if, /attention-spa\/gh-plan/);
assert.equal(job["runs-on"], "ubuntu-latest");
assert.equal(job.permissions.contents, "read");
assert.equal(job.permissions.actions, "write");
assert.equal(job.permissions.issues, undefined);
assert.ok(job.steps.some((step) => step.run === "node scripts/ci-fallback-controller.mjs"
  && step.env?.BOOTSTRAP_FALLBACK_RUN === "1"));
assert.deepEqual(worker.on.workflow_dispatch.inputs.backend.options, ["oci", "hosted"]);
assert.equal(worker.permissions.contents, "read");
assert.equal(worker.permissions.issues, "read");
assert.equal(worker.permissions.actions, undefined);
const w = worker.jobs["bootstrap-worker"];
assert.equal(w.permissions.contents, "read");
assert.equal(w.permissions.issues, "read");
assert.equal(w.permissions.actions, undefined);
assert.match(w["runs-on"], /self-hosted.*Linux.*trusted/);
assert.match(w["runs-on"], /ubuntu-latest/);
assert.equal(w.steps[0].with["fetch-depth"], 0);
const identity = w.steps.find((step) => step.name?.startsWith("Verify immutable"));
assert.match(identity.run, /git merge-base --is-ancestor "\$TARGET_SHA"/);
assert.match(identity.run, /git checkout --detach "\$TARGET_SHA"/);
assert.match(identity.run, /"\$REPOSITORY" == "attention-spa\/gh-plan"/);
assert.match(identity.run, /"\$GIT_REF" == "refs\/heads\/main"/);
const dry = w.steps.find((step) => step.name === "Confirm no GitHub writes are needed");
assert.equal(dry.env.GH_TOKEN, "$" + "{{ github.token }}");
assert.equal(dry.env.GH_PROMPT_DISABLED, "1");
assert.match(dry.run, /node \.github\/plan\/bootstrap\.mjs \| tee bootstrap-dry-run\.log/);
assert.match(dry.run, /grep -Fx 'Mutations required: 0' bootstrap-dry-run\.log/);
assert.doesNotMatch(dry.run, /--apply\b/);
assert.match(dry.run, /set -euo pipefail/);
assert.equal(w.steps.find((s) => s.uses?.startsWith("actions/setup-node@")).with["node-version"], "22");
for (const file of ["bootstrap-dry-run.yml", "bootstrap-worker.yml"]) {
  const source = readFileSync(new URL("../.github/workflows/" + file, import.meta.url), "utf8");
  assert.equal((source.match(/\$\{\{/g) ?? []).length,
    (source.match(/\$\{\{[^\n]*?\}\}/g) ?? []).length,
    file + " contains an unclosed GitHub Actions expression.");
}
assert.equal(ci.jobs.contracts["runs-on"], "ubuntu-latest");
assert.equal(ci.jobs.contracts.permissions.actions, undefined);
assert.equal(ci.jobs["main-controller"].permissions.actions, "write");
assert.equal(ciWorker.jobs["contracts-worker"].permissions.actions, undefined);

const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "attention-spa/gh-plan", GITHUB_SHA: SHA,
  GITHUB_RUN_ID: "77", GITHUB_TOKEN: "synthetic",
};
assert.deepEqual(checkContext(env, "bootstrap"), { sha: SHA, runId: 77, token: "synthetic" });
assert.throws(() => checkContext(env), /CI_FALLBACK_UNTRUSTED_CONTEXT/);
assert.throws(() => checkContext(env, "unknown"), /CI_FALLBACK_UNTRUSTED_CONTEXT/);
for (const broken of [
  { ...env, GITHUB_EVENT_NAME: "pull_request" },
  { ...env, GITHUB_REF: "refs/heads/feature" },
  { ...env, GITHUB_REPOSITORY: "other/repo" },
  { ...env, GITHUB_SHA: "invalid" }, { ...env, GITHUB_TOKEN: "" },
]) assert.throws(() => checkContext(broken, "bootstrap"), /CI_FALLBACK_UNTRUSTED_CONTEXT/);
assert.throws(() => actionsApi({ token: "abc", profile: "bad" }), /CI_FALLBACK_INVALID_TRANSPORT/);

const expected = { backend: "oci", correlation: CORR, sha: SHA };
const http = (status, data) => ({ status, json: async () => data });
const requests = [];
const api = actionsApi({
  token: "private-secret", profile: "bootstrap",
  fetchImpl: async (url, opts) => {
    requests.push({ url, method: opts.method, body: opts.body });
    if (url.endsWith("/workflows/bootstrap-worker.yml"))
      return http(200, { id: 440, path: ".github/workflows/bootstrap-worker.yml" });
    if (url.endsWith("/dispatches")) {
      assert.deepEqual(JSON.parse(opts.body).inputs, {
        backend: "oci", correlation: CORR, parent_run_id: "77", sha: SHA,
      });
      return http(200, { workflow_run_id: 880 });
    }
    if (url.endsWith("/runs/880"))
      return http(200, { id: 880, workflow_id: 440,
        event: "workflow_dispatch", head_branch: "main", run_attempt: 1,
        display_title: name, repository: { full_name: "attention-spa/gh-plan" },
        status: "completed", conclusion: "success" });
    if (url.includes("/runs/880/jobs?"))
      return http(200, { total_count: 1,
        jobs: [{ run_id: 880, status: "completed", conclusion: "success",
          started_at: "2026-11-16T10:00:00Z" }] });
    throw Error("Unexpected bootstrap endpoint");
  },
});
assert.equal(await api.dispatch(expected, 77), 880);
assert.equal((await api.inspect(880, expected)).conclusion, "success");
assert.ok(requests.every((r) => r.url.includes("/repos/attention-spa/gh-plan/actions/")));
assert.ok(!JSON.stringify(requests).includes("private-secret"));
const mismatch = actionsApi({
  token: "synthetic", profile: "bootstrap", sleep: async () => {},
  fetchImpl: async (url) => {
    if (url.endsWith("/workflows/bootstrap-worker.yml"))
      return http(200, { id: 440, path: ".github/workflows/bootstrap-worker.yml" });
    if (url.endsWith("/runs/880"))
      return http(200, { id: 880, workflow_id: 440, event: "workflow_dispatch",
        head_branch: "main", run_attempt: 1,
        display_title: "CI worker " + CORR + " oci " + SHA,
        repository: { full_name: "attention-spa/gh-plan" },
        status: "completed", conclusion: "success" });
    throw Error("Unexpected identity query");
  },
});
await assert.rejects(mismatch.inspect(880, expected), /CI_FALLBACK_RUN_IDENTITY_TITLE/);

const queued = { status: "queued", conclusion: null,
  jobs: [{ status: "queued", started_at: null, conclusion: null }] };
const canceled = { status: "completed", conclusion: "cancelled",
  jobs: [{ status: "completed", started_at: null, conclusion: "cancelled" }] };
const passed = { status: "completed", conclusion: "success",
  jobs: [{ status: "completed", started_at: "2026-11-16T10:00:00Z",
    conclusion: "success" }] };
const failed = { status: "completed", conclusion: "failure",
  jobs: [{ status: "completed", started_at: "2026-11-16T10:00:00Z",
    conclusion: "failure" }] };
function fake(mode) {
  let elapsed = 0, observed = 0, stopped = false;
  const trace = [];
  const driver = {
    async dispatch(e) { trace.push("dispatch:" + e.backend); return e.backend === "oci" ? 101 : 202; },
    async inspect(id) {
      if (mode === "forbidden") throw Error("CI_FALLBACK_HTTP_403");
      if (id === 202) return passed;
      assert.equal(id, 101);
      observed++;
      if (stopped) return mode === "cancel-race"
        ? { status: "completed", conclusion: "cancelled",
          jobs: [{ status: "completed", started_at: "2026-11-16T10:00:00Z",
            conclusion: "cancelled" }] } : canceled;
      if (mode === "offline" || mode === "cancel-race") return queued;
      if (mode === "drift") return observed === 1 ? queued : failed;
      return observed === 1 ? queued : passed;
    },
    async cancel(id) { assert.equal(id, 101); trace.push("cancel:oci"); stopped = true; },
  };
  return { trace, run: () => orchestrate({ api: driver, sha: SHA, parentRunId: 77,
    correlation: CORR, now: () => elapsed, sleep: async (n) => { elapsed += n; },
    queueMs: 30, pollMs: 10, totalMs: 130 }) };
}
const normal = fake("normal");
assert.deepEqual(await normal.run(), { backend: "oci", runId: 101 });
assert.deepEqual(normal.trace, ["dispatch:oci"]);
const offline = fake("offline");
assert.deepEqual(await offline.run(), { backend: "hosted", runId: 202, cancelledOciRunId: 101 });
assert.deepEqual(offline.trace, ["dispatch:oci", "cancel:oci", "dispatch:hosted"]);
for (const [mode, error] of [
  ["drift", /CI_FALLBACK_WORKER_FAILED/],
  ["cancel-race", /CI_FALLBACK_CANCELLATION_RACE/],
  ["forbidden", /CI_FALLBACK_HTTP_403/],
]) {
  const scenario = fake(mode);
  await assert.rejects(scenario.run(), error);
  assert.equal(scenario.trace.includes("dispatch:hosted"), false);
}
if (process.platform !== "win32") {
  for (const [fixture, exit] of [
    ["Mutations required: 0", 0], ["Mutations required: 1", 1],
    ["Mutations required: 0 plus extra", 1],
  ]) {
    const result = spawnSync("bash", ["-c",
      "set -euo pipefail; printf '%s\\n' \"$FIXTURE\" | tee /dev/null | grep -Fx 'Mutations required: 0'"],
      { encoding: "utf8", env: { ...process.env, FIXTURE: fixture } });
    assert.equal(result.status, exit, "Bootstrap must fail on an altered mutation count.");
  }
}
assert.equal(QUEUE_MS, 180_000);
console.log("Bootstrap manual OCI-first failover and dry-run safety fixtures passed.");
