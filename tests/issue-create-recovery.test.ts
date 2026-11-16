import { executePlanSteps } from "../src/execute-steps.ts";
import { createRestIssueCatalogReader } from "../src/rest.ts";
import type {
  FetchLike, FetchResponseLike, GithubPlan, ObservedIssue, PlanStep,
} from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(message + "\nexpected: " + JSON.stringify(expected) +
      "\nactual: " + JSON.stringify(actual));
  }
}
async function mustFail(run: () => Promise<unknown>, label: string): Promise<void> {
  let failed = false;
  try { await run(); } catch { failed = true; }
  assert(failed, label + " must fail closed.");
}
const marker = "<!-- gh-plan:I -->";
const marked = (number: number): ObservedIssue => ({
  kind: "issue", number, id: number * 10, nodeId: "I_" + number,
  title: "Created", body: marker + "\nText", state: "open",
});
const issue: PlanStep = {
  id: "issue.create:I", logicalId: "I", kind: "issue.create",
  status: "planned", current: null, desired: null, reason: "missing",
  preconditions: [], expectedPostconditions: ["Issue exists"], dependsOn: [],
  destructive: false, reversible: "partial",
  request: {
    protocol: "rest", method: "POST", path: "/repos/a/b/issues",
    body: { title: "Created", body: marker + "\nText" },
  },
};
const follow: PlanStep = {
  ...issue, id: "issue.update:I", kind: "issue.update",
  dependsOn: [issue.id], reversible: true,
  request: { protocol: "rest", method: "PATCH",
    path: ["/repos/a/b/issues/", { $ref: "I.number" }],
    body: { state: "closed" } },
};
function plan(steps: PlanStep[] = [follow, issue]): GithubPlan {
  return {
    metadata: { planner: "gh-plan", version: "0.1.0", mode: "rest" },
    repository: { fullName: "a/b" },
    desired: { resourceCount: 1, relationshipCount: 0 },
    resolutions: [{ kind: "issue", logicalId: "I", status: "new", identity: { marker } }],
    steps, noops: [], warnings: [], blockers: [], unsupported: [], readiness: "ready",
    summary: { planned: steps.length, noops: 0, blocked: 0,
      unsupported: 0, warnings: 0 },
  };
}
const base = "https://api.github.com/repos/a/b/issues?state=all&per_page=100";
function response(data: unknown, next?: string, status = 200): FetchResponseLike {
  return {
    status, ok: status >= 200 && status < 300, statusText: status === 200 ? "OK" : "Forbidden",
    headers: { get(name) {
      return name.toLowerCase() === "link" && next ?
        "<" + next + ">; rel=\"next\"" : null;
    } },
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}
const reads: string[] = [];
const catalog: ObservedIssue[] = [];
const mock: FetchLike = async (url, init) => {
  reads.push(url);
  assert(init?.method === "GET", "Recovery catalog may only GET.");
  equal(init?.headers?.Authorization, "Bearer injected-secret", "Runtime auth in GET only.");
  assert(url === base, "Unexpected catalog URL: " + url);
  return response(catalog.map((i) => ({
    id: i.id, number: i.number, node_id: i.nodeId,
    title: i.title, body: i.body, state: i.state,
  })));
};
const lookup = createRestIssueCatalogReader({ auth: "injected-secret", fetch: mock });
let creates = 0, patches = 0;
const dispatch = async (request: Parameters<typeof executePlanSteps>[1] extends (
  ...args: infer A) => unknown ? A[0] : never, step: PlanStep): Promise<unknown> => {
  if (step.kind === "issue.create") {
    creates++;
    // Simulate GitHub committing the create before the client loses its reply.
    catalog.push(marked(41));
    throw Error("lost response after successful issue create");
  }
  assert(request.protocol === "rest", "Update should be REST.");
  equal(request.path, "/repos/a/b/issues/41",
    "Recovered issue number must bind dependent update path.");
  patches++;
  return {};
};
const read = async (step: PlanStep) => {
  if (step.kind === "issue.create") {
    return catalog.length ? { status: "satisfied" as const,
      identity: { number: 41, id: 410, node_id: "I_41" } } :
      { status: "unsatisfied" as const };
  }
  return patches ? { status: "satisfied" as const } :
    { status: "unsatisfied" as const };
};
await mustFail(() => executePlanSteps(plan(), dispatch, read, lookup),
  "Simulated lost reply");
equal(creates, 1, "First attempt must create exactly once.");
equal(patches, 0, "Dependent operation must not run after ambiguous write failure.");
const second = await executePlanSteps(plan(), dispatch, read, lookup);
equal(creates, 1, "Restart must not create an issue with an existing marker.");
equal(patches, 1, "Downstream operation resumes from recovered identity.");
equal(second.skippedStepIds, ["issue.create:I"],
  "Recovered issue create is skipped and downstream step runs.");
equal(second.bindings.I, { id: 410, number: 41, nodeId: "I_41" },
  "Recovered IDs are derived from the authoritative catalog.");
const third = await executePlanSteps(plan(), dispatch, read, lookup);
equal(creates, 1, "Third invocation never duplicates existing issue.");
equal(third.skippedStepIds, ["issue.create:I", "issue.update:I"],
  "Satisfied steps are both skipped on replay.");
equal(reads.length, 3, "Every attempt must requery issue catalog for create.");

let writes = 0;
const noWrite = async () => { writes++; return {}; };
const satisfied = async () => ({
  status: "satisfied" as const, identity: { number: 41, id: 410, node_id: "I_41" },
});
await mustFail(() => executePlanSteps(plan([issue]), noWrite, satisfied,
  async () => [marked(41), marked(42)]), "Ambiguous duplicate markers");
await mustFail(() => executePlanSteps(plan([issue]), noWrite, satisfied,
  async () => []), "Satisfied postcondition but marker missing");
await mustFail(() => executePlanSteps(plan([issue]), noWrite,
  async () => ({ status: "unsatisfied" as const }),
  async () => [marked(41)]), "Marker exists with drifted postconditions");
await mustFail(() => executePlanSteps(plan([issue]), noWrite,
  async () => ({ status: "satisfied" as const, identity: { number: 99 } }),
  async () => [marked(41)]), "Observed marker and asserted identity conflict");
await mustFail(() => executePlanSteps(plan([issue]), noWrite, satisfied,
  async () => null as unknown as ObservedIssue[]), "Malformed catalog");
await mustFail(() => executePlanSteps(plan([issue]), noWrite, satisfied),
  "Missing recovery catalog callback");
await mustFail(() => executePlanSteps(plan([{ ...issue,
  request: { protocol: "rest", method: "POST", path: "/repos/a/b/issues",
    body: { title: "Created", body: "Without marker" } } }]), noWrite,
  async () => ({ status: "unsatisfied" as const }), async () => []),
"Missing marker must reject during preflight");
equal(writes, 0, "Safety conflicts and malformed catalogs never dispatch writes.");

// Custom markers must match whole token boundaries, not substring collisions.
const custom = "custom:issue/42";
const customStep: PlanStep = {
  ...issue, request: {
    protocol: "rest", method: "POST", path: "/repos/a/b/issues",
    body: { title: "Created", body: "prefix " + custom + " suffix" },
  },
};
const customPlan = plan([customStep]);
customPlan.resolutions = [{ kind: "issue", logicalId: "I", status: "new",
  identity: { marker: custom } }];
let customWrites = 0;
const customResult = await executePlanSteps(customPlan,
  async () => { customWrites++; return { number: 10 }; },
  async () => customWrites
    ? { status: "satisfied", identity: { number: 10 } }
    : { status: "unsatisfied" },
  async () => customWrites
    ? [{ ...marked(10), body: "prefix " + custom + " suffix" }]
    : [{ ...marked(100), body: "prefix " + custom + "x suffix" }]);
equal(customWrites, 1, "Boundary-adjacent custom marker must not cause false adoption.");
equal(customResult.skippedStepIds, [], "Unmatched custom marker is not a skip.");

// Use the actual transport to prove full pagination, closed-issue recovery,
// PR exclusion, and failure on a later page rather than trusting page one.
const secondPage = base + "&page=2";
const pageCalls: string[] = [];
const pagedFetch: FetchLike = async (url, init) => {
  pageCalls.push(url);
  assert(init?.method === "GET", "Catalog transport must be read-only.");
  if (url === base) return response([
    { id: 31, number: 3, title: "Other", body: "unmarked", state: "open" },
    { id: 91, number: 9, title: "PR", body: marker, state: "open",
      pull_request: { url: "https://api.github.com/repos/a/b/pulls/9" } },
  ], secondPage);
  if (url === secondPage) return response([
    { id: 410, number: 41, node_id: "I_41", title: "Created",
      body: marker + "\nText", state: "closed" },
  ]);
  throw Error("Unexpected page URL.");
};
const paged = createRestIssueCatalogReader({ auth: "injected-secret", fetch: pagedFetch });
equal((await paged("a/b")).map((i) => i.number), [3, 41],
  "Catalog includes closed issue from later page and excludes PR.");
equal(pageCalls, [base, secondPage],
  "Catalog reader must fetch every Link page before making a create decision.");
let seen = 0;
const got = await executePlanSteps(plan([issue]),
  async () => { seen++; return {}; },
  satisfied, paged);
equal(seen, 0, "Found closed issue marker on page 2 must suppress create.");
equal(got.bindings.I?.number, 41, "Recovery binds closed issue from page 2.");
const badPaged = createRestIssueCatalogReader({ auth: "injected-secret",
  fetch: async (url) => url === base
    ? response([], secondPage) : response({ message: "forbidden" }, undefined, 403),
});
await mustFail(() => executePlanSteps(plan([issue]), noWrite,
  async () => ({ status: "unsatisfied" as const }), badPaged),
  "Late-page read failure must fail closed");
equal(writes, 0, "No write after partial catalog read.");
console.log("M8.1.3 marker recovery, interruption replay and REST pagination fixtures passed.");
