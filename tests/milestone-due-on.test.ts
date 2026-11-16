import {
  normalizeSchema, diffGithubState, compileMilestoneSteps, planGithub,
} from "../src/index.ts";
import type {
  GithubPlanSchema, GithubStateSnapshot, ResourceResolution,
  FetchLike, FetchResponseLike,
} from "../src/index.ts";
import {
  isIsoCalendarDate, fromGithubMilestoneDueOn, toGithubMilestoneDueOn,
} from "../src/milestone-due-date.ts";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function same(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + "\nActual: " + JSON.stringify(actual) +
      "\nExpected: " + JSON.stringify(expected));
  }
}
for (const date of ["2026-11-16", "2028-02-29", "2000-02-29", "9999-12-31"]) {
  check(isIsoCalendarDate(date), "Valid Gregorian calendar date: " + date);
  same(toGithubMilestoneDueOn(date), date + "T00:00:00Z",
    "GitHub receives one deterministic midnight-UTC timestamp.");
}
for (const date of [
  "2026-2-03", "2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10",
  "2026-12-00", "2026-12-32", "2026-12-01T00:00:00Z",
  "2026-12-01+01:00", "", "01-12-2026", "2026-12-01 ",
]) {
  check(!isIsoCalendarDate(date), "Malformed/nonexistent date must fail: " + date);
}
same(fromGithubMilestoneDueOn("2026-11-16T18:42:19Z"), "2026-11-16",
  "Observed timestamp uses UTC calendar date, not clock-time equality.");
same(fromGithubMilestoneDueOn("2026-11-16T23:45:00-02:00"), "2026-11-17",
  "Offset timestamps compare the corresponding UTC date.");
same(fromGithubMilestoneDueOn("2026-02-30T00:00:00Z"), undefined,
  "Impossible observed timestamp must not be silently normalized.");
same(fromGithubMilestoneDueOn("not-a-date"), undefined,
  "Invalid observed timestamps cannot become a new deadline.");

const repo = "attention-spa/example";
const valid = (due_on: unknown, ref = false) => normalizeSchema({
  repository: repo,
  milestones: [{
    logicalId: "M", title: ref ? undefined : "Milestone",
    ...(ref ? { management: "reference", identity: { number: 4 } } : {}),
    due_on,
  }],
});
const expectedDate = valid("2028-02-29");
check(expectedDate.ok && !!expectedDate.graph, "Valid date must normalize.");
const desired = expectedDate.graph!.resources[0]!;
check(desired.kind === "milestone" && desired.management === "managed",
  "Managed milestone expected.");
same(desired.desired.due_on, { op: "set", value: "2028-02-29" },
  "Date shorthand becomes explicit set.");
const dateOp = valid({ op: "set", value: "2028-02-29" });
check(dateOp.ok && !!dateOp.graph, "Explicit date set accepted.");
same(dateOp.graph, expectedDate.graph, "Shorthand and explicit set normalize identically.");
const clear = valid({ op: "remove" });
check(clear.ok && !!clear.graph, "Explicit date clear accepted.");
for (const input of ["2027-02-29", "2028-2-29", null, 1739664000000,
  "2028-02-29T00:00:00Z", { op: "set", value: "2026-02-30" }]) {
  const result = valid(input);
  check(!result.ok && result.diagnostics.some((x) =>
    x.blocking && x.code === "INVALID_SCHEMA"),
  "Malformed due_on must block normalization: " + JSON.stringify(input));
}
const reference = valid({ op: "remove" }, true);
check(!reference.ok && reference.diagnostics.some((x) => x.blocking),
  "Reference-only milestones cannot change due dates.");

const snapshot = (due_on?: string | null): GithubStateSnapshot => ({
  repository: { fullName: repo }, issues: [], issueTypes: [], issueFields: [],
  milestones: [{ kind: "milestone", number: 4, id: 44,
    title: "Milestone", state: "open", description: "Untouched",
    ...(due_on === undefined ? {} : { due_on }) }],
});
const res: ResourceResolution[] = [{
  logicalId: "M", kind: "milestone", status: "existing", identity: { number: 4, id: 44 },
}];
function compiled(input: object, due_on?: string | null) {
  const normalized = normalizeSchema({
    repository: repo,
    milestones: [{ logicalId: "M", title: "Milestone", ...input }],
  });
  check(normalized.ok && normalized.graph, "Input must normalize.");
  const state = snapshot(due_on);
  const diffs = diffGithubState(normalized.graph, state, res);
  return { diffs, result: compileMilestoneSteps(normalized.graph, diffs, res) };
}
let run = compiled({ due_on: "2026-11-16" }, "2026-11-16T23:59:59Z");
same(run.result.steps, [], "Same UTC date must not produce a PATCH.");
check(run.diffs.diffs.some((x) => x.id === "milestone.due_on:M" && x.status === "noop"),
  "Due date should have its own semantic noop diff.");
run = compiled({ due_on: "2026-11-17" }, "2026-11-16T23:59:59Z");
same(run.result.steps[0]?.request, {
  protocol: "rest", method: "PATCH",
  path: "/repos/attention-spa/example/milestones/4",
  body: { due_on: "2026-11-17T00:00:00Z" },
}, "Changing only due_on must not modify title, state, description.");
same(run.result.steps[0]?.current, { due_on: "2026-11-16" },
  "Diff should preserve old normalized calendar date.");
run = compiled({ due_on: { op: "remove" } }, "2026-11-16T15:00:00Z");
same(run.result.steps[0]?.request, {
  protocol: "rest", method: "PATCH",
  path: "/repos/attention-spa/example/milestones/4",
  body: { due_on: null },
}, "Explicit remove must clear due_on using REST null.");
same(run.result.steps[0]?.reversible, "partial",
  "Explicit deadline clear must be marked partially reversible.");
run = compiled({ due_on: { op: "remove" } }, null);
same(run.result.steps, [], "Already empty deadline is a noop.");
run = compiled({}, "2026-11-16T15:00:00Z");
same(run.result.steps, [], "Omitting due_on must preserve existing deadline.");
run = compiled({ due_on: "2026-11-16" }, undefined);
check(run.diffs.blockers.some((x) => x.code === "UNRESOLVED_REFERENCE") &&
  !run.result.steps.length, "Missing discovered due_on must fail closed.");

const fresh: ResourceResolution[] = [{
  logicalId: "NEW", kind: "milestone", status: "new",
}];
const create = (due_on: unknown) => {
  const normalized = normalizeSchema({
    repository: repo, milestones: [{
      logicalId: "NEW", title: "Delivery", due_on,
    }],
  });
  check(normalized.ok && normalized.graph, "Create payload must normalize.");
  const diffs = diffGithubState(normalized.graph, {
    repository: { fullName: repo }, issues: [], milestones: [],
    issueTypes: [], issueFields: [],
  }, fresh);
  return compileMilestoneSteps(normalized.graph, diffs, fresh);
};
same(create("2026-12-20").steps[0]?.request, {
  protocol: "rest", method: "POST",
  path: "/repos/attention-spa/example/milestones",
  body: { title: "Delivery", due_on: "2026-12-20T00:00:00Z" },
}, "New milestone create must include date as an ISO timestamp.");
same(create({ op: "remove" }).steps[0]?.request, {
  protocol: "rest", method: "POST",
  path: "/repos/attention-spa/example/milestones",
  body: { title: "Delivery" },
}, "Removing due_on on a new resource is satisfied by omission.");

function response(data: unknown): FetchResponseLike {
  return { ok: true, status: 200, statusText: "OK",
    headers: { get() { return null; } },
    async json() { return data; }, async text() { return JSON.stringify(data); } };
}
const calls: string[] = [];
const fetch: FetchLike = async (url, options) => {
  calls.push(url);
  check(options?.method === "GET", "Planning may only send GET requests.");
  check(options?.headers?.Authorization === "Bearer runtime-only",
    "Auth must remain a transport header.");
  const prefix = "https://api.github.com/repos/attention-spa/example";
  if (url === prefix) return response({ id: 1, full_name: repo,
    owner: { type: "User" } });
  if (url === prefix + "/issues?state=all&per_page=100") return response([]);
  if (url === prefix + "/issue-types") return response([]);
  if (url === prefix + "/milestones?state=all&per_page=100") return response([
    { number: 4, id: 44, title: "Milestone",
      state: "open", description: "Untouched",
      due_on: "2026-12-20T12:00:00Z" },
  ]);
  throw Error("Unexpected GET: " + url);
};
const authored = {
  repository: repo,
  milestones: [{ logicalId: "M", title: "Milestone", due_on: "2026-12-20" }],
} satisfies GithubPlanSchema;
const plan = await planGithub({ schema: authored, auth: "runtime-only", fetch });
same(plan.readiness, "ready", "Read-only REST due_on discovery must yield a ready plan.");
same(plan.steps.filter((x) => x.status === "planned"), [],
  "Planner must not schedule a date update for an already matching UTC date.");
check(!JSON.stringify(plan).includes("runtime-only"), "Auth must not leak into plan.");
check(calls.length === 4, "Milestone due_on uses existing four broad GETs; no extra discovery.");
console.log("Milestone due_on schema, date validation, discovery, compare/set/clear/omit and no-I/O fixtures passed.");
