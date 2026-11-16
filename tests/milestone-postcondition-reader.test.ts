import { createRestMilestonePostconditionReader, MilestoneReadError } from
  "../src/apply-milestone-reader.ts";
import type { ApplyPostconditionSpec } from "../src/apply-preflight.ts";
import type { FetchLike, FetchResponseLike } from "../src/types.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(message + " expected=" + JSON.stringify(expected) +
      " actual=" + JSON.stringify(actual));
}
const ROOT = "https://api.github.com/repos/acme/widgets/milestones";
const LIST = ROOT + "?state=all&per_page=100";
const PAGE2 = LIST + "&page=2";
const TOKEN = "very-secret-milestone-fixture";
const due = "2027-03-02T00:00:00Z";
const good = (overrides: Record<string, unknown> = {}) => ({
  number: 7, id: 700, node_id: "M_700", title: "Release",
  description: null, state: "open", due_on: "2027-03-01T23:30:00-01:00",
  ...overrides,
});
const create: ApplyPostconditionSpec = {
  version: 1, stepId: "milestone.create:M", kind: "milestone.create",
  repository: "acme/widgets", method: "POST", path: "/repos/acme/widgets/milestones",
  identity: { strategy: "unique_milestone_title", title: "Release" },
  predicates: [
    { field: "title", comparison: "exact", expected: "Release" },
    { field: "description", comparison: "exact", expected: "" },
    { field: "state", comparison: "exact", expected: "open" },
    { field: "due_on", comparison: "utc_day", expected: due },
  ],
  reads: ["milestones.catalog", "milestones.byNumber"],
};
const update: ApplyPostconditionSpec = {
  version: 1, stepId: "milestone.update:M", kind: "milestone.update",
  repository: "acme/widgets", method: "PATCH", path: "/repos/acme/widgets/milestones/7",
  identity: { strategy: "milestone_number", number: 7 },
  predicates: [
    { field: "title", comparison: "exact", expected: "Updated" },
    { field: "description", comparison: "exact", expected: "" },
    { field: "state", comparison: "exact", expected: "closed" },
    { field: "due_on", comparison: "null", expected: null },
  ],
  reads: ["milestones.byNumber"],
};

function response(data: unknown, status = 200, link: string | null = null,
  url?: string): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300, status,
    statusText: status === 200 ? "OK" : "failure " + TOKEN,
    ...(url === undefined ? {} : { url }),
    headers: { get(name: string) {
      if (name.toLowerCase() === "link") return link;
      return null;
    } },
    async json() { if (data instanceof Error) throw data; return data; },
    async text() { return JSON.stringify(data); },
  };
}
type Route = () => FetchResponseLike | Promise<FetchResponseLike>;
function fixtures(routes: Record<string, Route>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    assert(init?.method === "GET", "Reader may never POST/PATCH.");
    assert(init.headers?.Authorization === "Bearer " + TOKEN, "Runtime-only auth.");
    assert(init.headers?.["X-GitHub-Api-Version"] === "2026-03-10", "Pinned API version.");
    assert(init.headers?.Accept === "application/vnd.github+json", "GitHub media type.");
    assert(init.body === undefined, "GET request cannot have a body.");
    if (!routes[url]) throw Error("secret " + TOKEN + " unexpected URL " + url);
    return routes[url]!();
  };
  return { fetch, calls };
}
function reader(routes: Record<string, Route>) {
  const rig = fixtures(routes);
  return { ...rig, verify: createRestMilestonePostconditionReader({ auth: TOKEN, fetch: rig.fetch }) };
}
async function rejection(
  what: string, fn: () => Promise<unknown>, code: MilestoneReadError["code"],
): Promise<void> {
  let thrown: unknown;
  try { await fn(); } catch (error) { thrown = error; }
  assert(thrown instanceof MilestoneReadError, what + ": must throw a sanitized typed error.");
  equal(thrown.code, code, what + ": error class.");
  assert(!JSON.stringify(thrown).includes(TOKEN) && !thrown.message.includes(TOKEN),
    what + ": sensitive URL/token/exception text must not escape.");
}

let present = false; // External test fixture simulates a remotely committed POST.
const fresh = reader({
  [LIST]: () => response(present ? [good()] : []),
  [ROOT + "/7"]: () => response(good()),
});
const beforeCreate = await fresh.verify.readBefore(create);
equal(beforeCreate, { status: "unsatisfied" }, "Absent title permits a future create under lock.");
equal(fresh.calls, [LIST], "Create precondition reads full open/closed catalog.");
present = true;
const verified = await fresh.verify.readAfter(create, beforeCreate,
  { id: 700, node_id: "M_700", number: 7 });
equal(verified.status, "satisfied", "Independent post-create read verifies all managed fields.");
equal(verified.identity, { number: 7, id: 700, nodeId: "M_700" },
  "REST number, id and node ID are reconciled.");
equal(fresh.calls, [LIST, LIST, ROOT + "/7"], "Before/after must use fresh independent GETs.");
const rerun = await fresh.verify.readBefore(create);
equal(rerun.status, "satisfied", "Already created milestone is recognized on rerun.");
equal(rerun.snapshot?.title, "Release", "Already-satisfied create returns verified state.");
equal(fresh.calls.length, 5, "Rerun performs fresh catalog and detail reads, no writes.");

const recover = reader({
  [LIST]: () => response([good()]),
  [ROOT + "/7"]: () => response(good()),
});
const prior = await recover.verify.readBefore(create);
const recovered = await recover.verify.readAfter(create, prior);
equal(recovered.status, "satisfied", "Lost create response can be reconciled via unique identity.");
await rejection("conflicting returned create identity", () =>
  recover.verify.readAfter(create, prior, { number: 7, id: 701, node_id: "M_700" }),
"IDENTITY_MISMATCH");
await rejection("incomplete returned identity", () =>
  recover.verify.readAfter(create, prior, { number: 7 }),
"IDENTITY_MISMATCH");
await rejection("update response identity wrong kind", () =>
  recover.verify.readAfter(create, prior, { number: -7, id: 700, node_id: "M_700" }),
"IDENTITY_MISMATCH");

let updated = false;
const updateRig = reader({
  [ROOT + "/7"]: () => response(updated
    ? good({ title: "Updated", description: null, state: "closed", due_on: null })
    : good({ title: "Release", description: "Before", state: "open", due_on: due })),
});
const beforeUpdate = await updateRig.verify.readBefore(update,
  { number: 7, id: 700, nodeId: "M_700" });
equal(beforeUpdate.status, "unsatisfied", "Fresh update precondition detects outstanding changes.");
updated = true;
const afterUpdate = await updateRig.verify.readAfter(update, beforeUpdate,
  { number: 7, id: 700, node_id: "M_700" });
equal(afterUpdate.status, "satisfied", "All changed fields including explicit clears verified.");
equal(updateRig.calls, [ROOT + "/7", ROOT + "/7"],
  "Update uses independent before/after GET-by-number.");
const repeat = await updateRig.verify.readBefore(update);
equal(repeat.status, "satisfied", "Update rerun is a fresh zero-write noop.");

const onlyDue: ApplyPostconditionSpec = {
  ...update, predicates: [{ field: "due_on", comparison: "utc_day", expected: due }],
};
let offDate = false;
const offsetRig = reader({ [ROOT + "/7"]: () => response(offDate
  ? good({ due_on: "2027-03-01T23:30:00-01:00" })
  : good({ due_on: "2027-02-20T12:00:00Z" })) });
const offsetBefore = await offsetRig.verify.readBefore(onlyDue);
offDate = true;
equal((await offsetRig.verify.readAfter(onlyDue, offsetBefore)).status, "satisfied",
  "Matching UTC calendar day accepts a non-midnight, offset timestamp.");
const badOffsetRig = reader({ [ROOT + "/7"]: () => response(good({
  due_on: "2027-03-02T23:30:00-01:00",
})) });
const badOffset = await badOffsetRig.verify.readBefore(onlyDue);
equal(badOffset.status, "unsatisfied",
  "An offset that crosses UTC midnight is not the same due date.");

const omitTitle = { ...onlyDue };
let unrelatedTitle = false;
const driftRig = reader({ [ROOT + "/7"]: () => response(unrelatedTitle
  ? good({ title: "Mutated elsewhere" })
  : good({ title: "Release", due_on: "2027-02-20T12:00:00Z" })) });
const driftBefore = await driftRig.verify.readBefore(omitTitle);
unrelatedTitle = true;
await rejection("omitted title mutated", () =>
  driftRig.verify.readAfter(omitTitle, driftBefore), "IDENTITY_MISMATCH");

const omittedDescription = reader({ [ROOT + "/7"]: () => response(good({
  description: "Do not clear", due_on: "2027-02-20T12:00:00Z",
})) });
const unchangedBefore = await omittedDescription.verify.readBefore(onlyDue);
await rejection("stale identity expected hint", () =>
  omittedDescription.verify.readBefore(onlyDue, { id: 999 }), "IDENTITY_MISMATCH");
// No write took place. Calling readAfter on the same unchanged GET may not claim success.
await rejection("unverified post-update predicate", () =>
  omittedDescription.verify.readAfter(onlyDue, unchangedBefore), "POSTCONDITION_MISMATCH");

const duplicate = reader({
  [LIST]: () => response([good({ state: "open" })],
    200, "<" + PAGE2 + '>; rel="next"'),
  [PAGE2]: () => response([good({ number: 8, id: 800, node_id: "M_800", state: "closed" })]),
});
await rejection("duplicate exact title among open and closed pages", () =>
  duplicate.verify.readBefore(create), "AMBIGUOUS_TITLE");
equal(duplicate.calls, [LIST, PAGE2], "Catalog follows every GitHub Link page.");

const wrongDetails = reader({
  [LIST]: () => response([good()]),
  [ROOT + "/7"]: () => response(good({ id: 999 })),
});
await rejection("catalog/by-number REST identity mismatch", () =>
  wrongDetails.verify.readBefore(create), "IDENTITY_MISMATCH");
const sameIdDifferentState = reader({
  [LIST]: () => response([good({ state: "open" })]),
  [ROOT + "/7"]: () => response(good({ state: "closed" })),
});
await rejection("inconsistent catalog and detail state", () =>
  sameIdDifferentState.verify.readBefore(create), "IDENTITY_MISMATCH");
const collision = reader({
  [LIST]: () => response([good(), good({ title: "Other" })]),
});
await rejection("duplicate milestone number across catalog", () =>
  collision.verify.readBefore(create), "INCOMPLETE_CATALOG");

const missingTitle = reader({
  [LIST]: () => response([good({ title: "Other" })]),
});
await rejection("post-create absent title is indeterminate", async () => {
  const initial = await missingTitle.verify.readBefore(create);
  await missingTitle.verify.readAfter(create, initial);
}, "INDETERMINATE_WRITE");
const conflict = reader({
  [LIST]: () => response([good({ state: "closed" })]),
  [ROOT + "/7"]: () => response(good({ state: "closed" })),
});
await rejection("existing title with incompatible managed properties", () =>
  conflict.verify.readBefore(create), "POSTCONDITION_MISMATCH");

for (const [status, code] of [
  [401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [429, "RATE_LIMITED"],
] as const) {
  const errorRig = reader({ [LIST]: () => response({ message: TOKEN }, status) });
  await rejection("catalog HTTP " + status, () =>
    errorRig.verify.readBefore(create), code);
}
const partial = reader({
  [LIST]: () => response([good()], 200, "<" + PAGE2 + '>; rel="next"'),
  [PAGE2]: () => response({ message: TOKEN }, 403),
});
await rejection("failed second page cannot imply unique title", () =>
  partial.verify.readBefore(create), "FORBIDDEN");
const wrongRepo = reader({
  [LIST]: () => response([good()], 200,
    '<https://api.github.com/repos/attacker/repo/milestones?state=all&per_page=100&page=2>; rel="next"'),
});
await rejection("off-repository next Link", () =>
  wrongRepo.verify.readBefore(create), "INCOMPLETE_CATALOG");
const truncated = reader({
  [LIST]: () => response([good()], 200, '<' + LIST + '&page=9>; rel="next"'),
});
await rejection("skipped pagination page", () =>
  truncated.verify.readBefore(create), "INCOMPLETE_CATALOG");
const unsafeHost = reader({
  [LIST]: () => response([good()], 200,
    '<https://evil.example/repos/acme/widgets/milestones?state=all&per_page=100&page=2>; rel="next"'),
});
await rejection("cross-origin next Link", () =>
  unsafeHost.verify.readBefore(create), "INCOMPLETE_CATALOG");
const malformedPage = reader({
  [LIST]: () => response({ incomplete_results: true }),
});
await rejection("partial JSON array", () =>
  malformedPage.verify.readBefore(create), "INCOMPLETE_CATALOG");
const absentId = reader({ [ROOT + "/7"]: () =>
  response(good({ id: undefined })) });
await rejection("missing REST id on update", () =>
  absentId.verify.readBefore(update), "INVALID_RESPONSE");
const absentNode = reader({ [ROOT + "/7"]: () =>
  response(good({ node_id: undefined })) });
await rejection("missing node_id on update", () =>
  absentNode.verify.readBefore(update), "INVALID_RESPONSE");
const wrongNumber = reader({ [ROOT + "/7"]: () =>
  response(good({ number: 14 })) });
await rejection("by-number path identity stale", () =>
  wrongNumber.verify.readBefore(update), "IDENTITY_MISMATCH");
const invalidDay = reader({ [ROOT + "/7"]: () =>
  response(good({ due_on: "2027-02-30T00:00:00Z" })) });
await rejection("invalid GitHub calendar date", () =>
  invalidDay.verify.readBefore(update), "INVALID_RESPONSE");
const noDescription = reader({ [ROOT + "/7"]: () =>
  response(good({ description: undefined })) });
await rejection("partial GitHub response missing description", () =>
  noDescription.verify.readBefore(update), "INVALID_RESPONSE");
const noDue = reader({ [ROOT + "/7"]: () =>
  response(good({ due_on: undefined })) });
await rejection("partial GitHub response missing due_on", () =>
  noDue.verify.readBefore(update), "INVALID_RESPONSE");
const redirected = reader({ [LIST]: () =>
  response([], 200, null, "https://untrusted.example/redirect") });
await rejection("redirected response", () =>
  redirected.verify.readBefore(create), "READ_FAILED");
const thrown = fixtures({ [LIST]: () => { throw Error(TOKEN + " secret in transport"); } });
await rejection("fetch exception sanitized", () =>
  createRestMilestonePostconditionReader({ auth: TOKEN, fetch: thrown.fetch })
    .readBefore(create), "READ_FAILED");

const invalidSpec = { ...create, path: "/repos/other/repo/milestones" };
const noNetwork = reader({ [LIST]: () => { throw Error("must not reach fetch"); } });
await rejection("unsafe descriptor refuses before GET", () =>
  noNetwork.verify.readBefore(invalidSpec), "INVALID_SPEC");
equal(noNetwork.calls, [], "Invalid descriptor should cause no network operations.");
const issueSpec = { ...create, kind: "issue.create" as const };
await rejection("issue kind refused by milestone reader", () =>
  noNetwork.verify.readBefore(issueSpec), "INVALID_SPEC");
await rejection("wrong-reader baseline refused", () =>
  recover.verify.readAfter(create, beforeCreate), "INVALID_SPEC");
const invalidFetch = createRestMilestonePostconditionReader({ auth: TOKEN, fetch: thrown.fetch });
await rejection("malformed JSON error cannot leak", () => {
  const bad = reader({ [LIST]: () => response(Error(TOKEN)) });
  return bad.verify.readBefore(create);
}, "INVALID_RESPONSE");
assert(typeof invalidFetch.readBefore === "function", "Constructed reader is internal and callable.");
console.log("M8.1.6b.2 milestone readback: identity, pagination, fields, replay and fail-closed cases passed.");
