// Trusted main-only OCI-first CI controller. Never imported by untrusted PR code.
import { randomBytes } from "node:crypto";

const REPO = "attention-spa/gh-plan";
const WORKFLOW = "ci-worker.yml";
export const QUEUE_MS = 180_000;
const POLL_MS = 10_000, TOTAL_MS = 2_400_000;
const fail = (code) => new Error("CI_FALLBACK_" + code);
const int = (n) => Number.isSafeInteger(n) && n > 0;
const validSha = (s) => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
const title = (c, b, sha) => "CI worker " + c + " " + b + " " + sha;

export function checkContext(env) {
  if (env.GITHUB_EVENT_NAME !== "push" ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_REPOSITORY !== REPO || !validSha(env.GITHUB_SHA) ||
      !int(Number(env.GITHUB_RUN_ID)) || !env.GITHUB_TOKEN) {
    throw fail("UNTRUSTED_CONTEXT");
  }
  return { sha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID), token: env.GITHUB_TOKEN };
}

/** Injected fetch is intended only for deterministic mock tests. */
export function actionsApi({ token, fetchImpl = globalThis.fetch,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!token || typeof fetchImpl !== "function") throw fail("INVALID_TRANSPORT");
  const base = "https://api.github.com/repos/" + REPO + "/actions";
  const headers = {
    Accept: "application/vnd.github+json", Authorization: "Bearer " + token,
    "X-GitHub-Api-Version": "2026-03-10",
  };
  async function request(method, path, body) {
    if (!/^\/(runs|workflows)\//.test(path) || path.includes("..") || path.includes("://"))
      throw fail("INVALID_PATH");
    let response;
    try {
      response = await fetchImpl(base + path, {
        method, headers, redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw fail("NETWORK"); }
    if (!Number.isInteger(response?.status) ||
        response.status < 200 || response.status > 299)
      throw fail("HTTP_" + (Number.isInteger(response?.status) ? response.status : "INVALID"));
    if (response.status === 204 || (method === "POST" && path.endsWith("/cancel") && response.status === 202))
      return { status: response.status, data: null };
    try { return { status: response.status, data: await response.json() }; }
    catch { throw fail("INVALID_RESPONSE"); }
  }
  let workflowId;
  async function workflow() {
    if (!workflowId) {
      const { data } = await request("GET", "/workflows/" + WORKFLOW);
      if (!int(data?.id) || data?.path !== ".github/workflows/" + WORKFLOW)
        throw fail("WORKFLOW_IDENTITY");
      workflowId = data.id;
    }
    return workflowId;
  }
  async function discover(expected, since) {
    const workflowId = await workflow();
    for (let attempts = 0; attempts < 8; attempts++) {
      const { data } = await request("GET", "/workflows/" + WORKFLOW +
        "/runs?event=workflow_dispatch&branch=main&per_page=100");
      if (!Array.isArray(data?.workflow_runs)) throw fail("INVALID_RUN_LIST");
      const found = data.workflow_runs.filter((run) =>
        run.workflow_id === workflowId && run.event === "workflow_dispatch" &&
        run.head_branch === "main" && run.repository?.full_name === REPO &&
        run.display_title === title(expected.correlation, expected.backend, expected.sha) &&
        Number.isFinite(Date.parse(run.created_at)) &&
        Date.parse(run.created_at) >= since - 60_000);
      if (found.length > 1) throw fail("AMBIGUOUS_DISPATCH");
      if (found.length === 1) {
        if (!int(found[0].id)) throw fail("UNKNOWN_DISPATCH");
        return found[0].id;
      }
      await sleep(2_000);
    }
    throw fail("UNKNOWN_DISPATCH");
  }
  return {
    async dispatch(expected, parentRunId) {
      const since = now();
      const { status, data } = await request("POST", "/workflows/" + WORKFLOW + "/dispatches", {
        ref: "main", return_run_details: true,
        inputs: {
          backend: expected.backend, sha: expected.sha,
          parent_run_id: String(parentRunId), correlation: expected.correlation,
        },
      });
      if (status === 200) {
        if (!int(data?.workflow_run_id)) throw fail("UNKNOWN_DISPATCH");
        return data.workflow_run_id;
      }
      if (status === 204) return discover(expected, since);
      throw fail("UNKNOWN_DISPATCH");
    },
    async inspect(id, expected) {
      if (!int(id)) throw fail("INVALID_RUN_ID");
      const wid = await workflow();
      let run, mismatch = "UNKNOWN";
      // Dispatch may return an ID before GitHub has populated run-name and
      // repository fields. Never accept a wrong identity, but allow the new
      // run's read model a bounded 12-second convergence window.
      for (let attempt = 0; attempt < 7; attempt++) {
        ({ data: run } = await request("GET", "/runs/" + id));
        mismatch = run?.id !== id ? "ID" :
          run.workflow_id !== wid ? "WORKFLOW" :
          run.event !== "workflow_dispatch" ? "EVENT" :
          run.head_branch !== "main" ? "BRANCH" :
          run.repository?.full_name !== REPO ? "REPOSITORY" :
          run.display_title !== title(expected.correlation, expected.backend, expected.sha) ? "TITLE" :
          run.run_attempt !== 1 ? "ATTEMPT" : null;
        if (mismatch === null) break;
        if (attempt < 6) await sleep(2_000);
      }
      if (mismatch !== null) throw fail("RUN_IDENTITY_" + mismatch);
      if (!["queued", "pending", "waiting", "in_progress", "completed"].includes(run.status))
        throw fail("RUN_STATE");
      const { data: listed } = await request("GET", "/runs/" + id + "/jobs?per_page=100");
      if (!Number.isSafeInteger(listed?.total_count) || listed.total_count < 0 ||
          !Array.isArray(listed.jobs) || listed.total_count !== listed.jobs.length ||
          listed.jobs.length > 1 || listed.jobs.some((j) => j.run_id !== id))
        throw fail("JOB_LIST");
      return { status: run.status, conclusion: run.conclusion, jobs: listed.jobs };
    },
    async cancel(id) {
      if (!int(id)) throw fail("INVALID_RUN_ID");
      await request("POST", "/runs/" + id + "/cancel");
    },
  };
}
const started = (jobs) => jobs.some((j) => j.started_at != null ||
  j.status === "in_progress" ||
  (j.status === "completed" && j.conclusion !== "cancelled") ||
  !["queued", "waiting", "pending", "cancelled", "completed"].includes(j.status));
function verifiedOutcome(observation, hadStarted) {
  if (observation.status !== "completed") return false;
  if (hadStarted && observation.conclusion === "success" &&
      observation.jobs.length === 1 && observation.jobs[0].conclusion === "success")
    return true;
  throw fail("WORKER_FAILED");
}

/** Never dispatch hosted after started execution or uncertain cancellation. */
export async function orchestrate({ api, sha, parentRunId,
  correlation = String(parentRunId) + "-" + randomBytes(8).toString("hex"),
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  queueMs = QUEUE_MS, pollMs = POLL_MS, totalMs = TOTAL_MS,
  report = () => {}, signal }) {
  if (!validSha(sha) || !int(parentRunId) ||
      !new RegExp("^" + parentRunId + "-[a-f0-9]{16}$").test(correlation) ||
      !(queueMs > 0 && pollMs > 0 && totalMs > queueMs))
    throw fail("INVALID_INPUT");
  const deadline = now() + totalMs;
  let active;
  function guard() {
    if (signal?.aborted) throw fail("INTERRUPTED");
    if (now() >= deadline) throw fail("CONTROLLER_TIMEOUT");
  }
  async function observe() {
    guard();
    const x = await api.inspect(active.id, active.expected);
    if (!Array.isArray(x?.jobs) || x.jobs.length > 1 ||
        !["queued", "pending", "waiting", "in_progress", "completed"].includes(x.status))
      throw fail("INVALID_STATE");
    active.hasStarted ||= started(x.jobs);
    return x;
  }
  async function execute(backend) {
    const expected = { backend, sha, correlation };
    const id = await api.dispatch(expected, parentRunId);
    if (!int(id)) throw fail("UNKNOWN_DISPATCH");
    active = { id, expected, hasStarted: false };
    report({ backend, id, state: "dispatched" });
    const queuedUntil = now() + queueMs;
    for (;;) {
      const state = await observe();
      if (verifiedOutcome(state, active.hasStarted)) {
        report({ backend, id, state: "passed" });
        return { id, fallback: false };
      }
      if (backend === "oci" && !active.hasStarted && now() >= queuedUntil) {
        const last = await observe();
        if (verifiedOutcome(last, active.hasStarted)) {
          report({ backend, id, state: "passed" });
          return { id, fallback: false };
        }
        if (active.hasStarted) continue;
        await api.cancel(id);
        for (;;) {
          const next = await observe();
          if (active.hasStarted) throw fail("CANCELLATION_RACE");
          if (next.status === "completed") {
            if (next.conclusion !== "cancelled") throw fail("CANCELLATION_RACE");
            report({ backend, id, state: "cancelled_before_start" });
            return { id, fallback: true };
          }
          await sleep(pollMs);
        }
      }
      await sleep(pollMs);
    }
  }
  try {
    const oci = await execute("oci");
    if (!oci.fallback) return { backend: "oci", runId: oci.id };
    const hosted = await execute("hosted");
    return { backend: "hosted", runId: hosted.id, cancelledOciRunId: oci.id };
  } catch (e) {
    // Parent cancellation is best-effort propagated to the known child run.
    // A cancellation acknowledgement never authorizes hosted failover.
    if (signal?.aborted && active?.id) {
      try { await api.cancel(active.id); } catch { /* leave original failure sanitized */ }
    }
    throw /^CI_FALLBACK_[A-Z0-9_]+$/.test(e?.message ?? "")
      ? e : fail("UNEXPECTED");
  }
}

async function main() {
  const context = checkContext(process.env);
  const report = ({ backend, id, state }) =>
    console.log("CI worker " + backend + " " + state + ": https://github.com/" +
      REPO + "/actions/runs/" + id);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const result = await orchestrate({
    api: actionsApi({ token: context.token }),
    sha: context.sha, parentRunId: context.runId, report,
    signal: controller.signal,
  });
  console.log("Verified CI contracts on " + result.backend + ".");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\nCI backend: **" + result.backend +
      "** ([worker run](https://github.com/" + REPO + "/actions/runs/" + result.runId + ")).\n");
  }
}
if (process.env.CI_FALLBACK_RUN === "1") {
  main().catch((e) => {
    console.error(/^CI_FALLBACK_[A-Z0-9_]+$/.test(e?.message ?? "")
      ? e.message : "CI_FALLBACK_UNEXPECTED");
    process.exitCode = 1;
  });
}
