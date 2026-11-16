import { createRestIssuePostconditionReader, IssueReadError } from
  "../src/apply-issue-reader.ts";
import type { ApplyPostconditionSpec } from "../src/apply-preflight.ts";
import type { FetchLike, FetchResponseLike } from "../src/types.ts";

function assert(ok: unknown, why: string): asserts ok { if (!ok) throw Error(why); }
function equal(a: unknown, b: unknown, why: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(why + " expected=" + JSON.stringify(b) + " actual=" + JSON.stringify(a));
}
const ROOT = "https://api.github.com/repos/acme/widgets/issues";
const LIST = ROOT + "?state=all&per_page=100";
const PAGE2 = LIST + "&page=2";
const SECRET = "secret-issue-fixture-token";
const marker = (id: string) => "<!-- gh-plan:" + id + " -->";
const B = "A short body\n" + marker("I");
const issue = (overrides: Record<string, unknown> = {}) => ({
  id: 1100, number: 11, node_id: "I_1100", title: "Ship",
  body: B, state: "open", milestone: { number: 7 }, ...overrides,
});
const issueU = (overrides: Record<string, unknown> = {}) => ({
  id: 1200, number: 12, node_id: "I_1200", title: "Existing",
  body: "Original " + marker("U"), state: "open", milestone: { number: 8 },
  ...overrides,
});
const pr = (overrides: Record<string, unknown> = {}) => ({
  id: 1300, number: 13, node_id: "PR_1300", title: "Pull request",
  body: B, state: "open", milestone: null, pull_request: { url: ROOT + "/13" },
  ...overrides,
});
const create: ApplyPostconditionSpec = {
  version: 1, stepId: "issue.create:I", kind: "issue.create",
  repository: "acme/widgets", method: "POST", path: "/repos/acme/widgets/issues",
  identity: { strategy: "unique_issue_marker", marker: marker("I") },
  predicates: [
    { field: "body", comparison: "exact", expected: B },
    { field: "title", comparison: "exact", expected: "Ship" },
    { field: "milestone", comparison: "exact", expected: { $ref: "M.number" } },
    { field: "state", comparison: "exact", expected: "open" },
  ],
  reads: ["issues.catalog", "issues.byNumber"],
};
const update: ApplyPostconditionSpec = {
  version: 1, stepId: "issue.update:U", kind: "issue.update",
  repository: "acme/widgets", method: "PATCH", path: "/repos/acme/widgets/issues/12",
  identity: { strategy: "issue_number", marker: marker("U"), number: 12 },
  predicates: [
    { field: "title", comparison: "exact", expected: "Revised" },
    { field: "body", comparison: "exact", expected: "Revised body " + marker("U") },
    { field: "state", comparison: "exact", expected: "closed" },
    { field: "milestone", comparison: "null", expected: null },
  ],
  reads: ["issues.byNumber", "issues.catalog"],
};
const closeCreated: ApplyPostconditionSpec = {
  version: 1, stepId: "issue.update:I", kind: "issue.update",
  repository: "acme/widgets", method: "PATCH",
  path: ["/repos/acme/widgets/issues/", { $ref: "I.number" }],
  identity: { strategy: "issue_number", number: { $ref: "I.number" }, marker: marker("I") },
  predicates: [{ field: "state", comparison: "exact", expected: "closed" }],
  reads: ["issues.byNumber", "issues.catalog"],
};
type Route = () => FetchResponseLike | Promise<FetchResponseLike>;
function response(data: unknown, status = 200, link: string | null = null,
  url?: string): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300, status,
    statusText: status === 200 ? "OK" : SECRET,
    ...(url ? { url } : {}),
    headers: { get(k) {
      if (k.toLowerCase() === "link") return link;
      return null;
    } },
    async json() { if (data instanceof Error) throw data; return data; },
    async text() { return JSON.stringify(data); },
  };
}
function reader(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    assert(init?.method === "GET", "Verification cannot dispatch a mutation.");
    assert(init.body === undefined, "Read transport cannot send a request body.");
    assert(init.redirect === "error", "Redirects cannot forward secrets.");
    assert(init.headers?.Authorization === "Bearer " + SECRET, "Runtime-only token.");
    assert(init.headers?.["X-GitHub-Api-Version"] === "2026-03-10", "Shared pinned API.");
    assert(init.headers?.Accept === "application/vnd.github+json", "Correct GitHub Accept.");
    if (!routes[url]) throw Error(SECRET + ": unexpected URL " + url);
    return routes[url]!();
  };
  return { calls, verify: createRestIssuePostconditionReader({ auth: SECRET, fetch }) };
}
async function reject(name: string, fn: () => Promise<unknown>,
  code: IssueReadError["code"]): Promise<void> {
  let error: unknown;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error instanceof IssueReadError, name + " must reject with typed error.");
  equal(error.code, code, name + " must have expected failure code");
  assert(!JSON.stringify(error).includes(SECRET) && !error.message.includes(SECRET),
    name + " must not leak token or caller exception text.");
}
const M = { bindings: { M: { number: 7 } } };
let created = false;
const fresh = reader({
  [LIST]: () => response(created ? [pr(), issue()] : [pr()]),
  [ROOT + "/11"]: () => response(issue()),
});
const before = await fresh.verify.readBefore(create, M);
equal(before.status, "unsatisfied", "PR marker collision cannot identify an issue.");
equal(fresh.calls, [LIST], "Fresh create preflight must read complete open/closed catalog.");
created = true;
const after = await fresh.verify.readAfter(create, before,
  { number: 11, id: 1100, node_id: "I_1100" });
equal(after.identity, { number: 11, id: 1100, nodeId: "I_1100" },
  "Create response and independent readback must agree on all REST identifiers.");
equal(fresh.calls, [LIST, LIST, ROOT + "/11"],
  "After possible POST, a fresh catalog and independent by-number GET are mandatory.");
const rerun = await fresh.verify.readBefore(create, M);
equal(rerun.status, "satisfied", "Repeat creates detect verified zero-write state.");
equal(fresh.calls.length, 5, "Repeat-run never uses stale initial observation.");

const lost = reader({
  [LIST]: () => response([issue()]),
  [ROOT + "/11"]: () => response(issue()),
});
const already = await lost.verify.readBefore(create, M);
equal((await lost.verify.readAfter(create, already)).status, "satisfied",
  "Unique fully verified issue can reconcile lost create POST response.");
await reject("create response mismatch", () => lost.verify.readAfter(create, already,
  { number: 11, id: 1099, node_id: "I_1100" }), "IDENTITY_MISMATCH");
await reject("create incomplete response identity", () => lost.verify.readAfter(create, already,
  { number: 11 }), "IDENTITY_MISMATCH");
await reject("create forged response identity", () => lost.verify.readAfter(create, already,
  { number: 11, id: 1100, node_id: "I_other" }), "IDENTITY_MISMATCH");

let changed = false;
const patch = reader({
  [LIST]: () => response([changed
    ? issueU({ title: "Revised", body: "Revised body " + marker("U"),
      state: "closed", milestone: null })
    : issueU()]),
  [ROOT + "/12"]: () => response(changed
    ? issueU({ title: "Revised", body: "Revised body " + marker("U"),
      state: "closed", milestone: null })
    : issueU()),
});
const beforeUpdate = await patch.verify.readBefore(update,
  { expectedIdentity: { number: 12, id: 1200, nodeId: "I_1200" } });
equal(beforeUpdate.status, "unsatisfied", "PATCH outstanding managed changes must be detected.");
changed = true;
const afterUpdate = await patch.verify.readAfter(update, beforeUpdate,
  { number: 12, id: 1200, node_id: "I_1200" });
equal(afterUpdate.status, "satisfied", "Title, body, closed state, null milestone verified.");
equal(patch.calls, [LIST, ROOT + "/12", LIST, ROOT + "/12"],
  "Update checks exact marker uniqueness and by-number before and after.");
equal((await patch.verify.readBefore(update)).status, "satisfied",
  "Already-applied PATCH returns verified no-op on fresh reread.");

let closed = false;
const close = reader({
  [LIST]: () => response([issue({ state: closed ? "closed" : "open" })]),
  [ROOT + "/11"]: () => response(issue({ state: closed ? "closed" : "open" })),
  [ROOT + "/77"]: () => response(issue()), // path/returned issue-number mismatch
});
const closeBefore = await close.verify.readBefore(closeCreated,
  { bindings: { I: { number: 11, id: 1100, nodeId: "I_1100" } },
    expectedIdentity: { number: 11, id: 1100 } });
equal(closeBefore.status, "unsatisfied", "Create-followed-by-close binds producer issue number.");
closed = true;
equal((await close.verify.readAfter(closeCreated, closeBefore)).status, "satisfied",
  "Create->close verifies closed while keeping body/milestone unchanged.");
equal((await close.verify.readBefore(closeCreated,
  { bindings: { I: { number: 11 } } })).status, "satisfied",
  "Bound created issue is idempotently closeable.");
await reject("producer REST id contradicts matched marker owner", () =>
  close.verify.readBefore(closeCreated, { bindings: {
    I: { number: 11, id: 9999, nodeId: "I_1100" },
  } }), "IDENTITY_MISMATCH");
await reject("producer nodeId contradicts matched marker owner", () =>
  close.verify.readBefore(closeCreated, { bindings: {
    I: { number: 11, id: 1100, nodeId: "I_wrong" },
  } }), "IDENTITY_MISMATCH");
await reject("explicit hint contradicts verified producer identity", () =>
  close.verify.readBefore(closeCreated, {
    bindings: { I: { number: 11, id: 1100, nodeId: "I_1100" } },
    expectedIdentity: { id: 9999 },
  }), "IDENTITY_MISMATCH");


const trickyReference: ApplyPostconditionSpec = {
  ...create, predicates: create.predicates.map((p) => p.field === "milestone"
    ? { ...p, expected: { $ref: "M.number-sub.number" } } : p),
};
const tricky = reader({
  [LIST]: () => response([issue()]),
  [ROOT + "/11"]: () => response(issue()),
});
equal((await tricky.verify.readBefore(trickyReference, {
  bindings: { "M.number-sub": { number: 7 } },
})).status, "satisfied", "Logical IDs containing .number must bind exactly.");

const setMilestone: ApplyPostconditionSpec = {
  ...update, predicates: [{ field: "milestone", comparison: "exact",
    expected: { $ref: "M.number" } }],
};
let assigned = false;
const setReader = reader({
  [LIST]: () => response([issueU({ milestone: assigned ? { number: 9 } : null })]),
  [ROOT + "/12"]: () => response(issueU({ milestone: assigned ? { number: 9 } : null })),
});
const setBefore = await setReader.verify.readBefore(setMilestone, {
  bindings: { M: { number: 9 } },
});
equal(setBefore.status, "unsatisfied", "Late-bound milestone number is not its REST id.");
assigned = true;
equal((await setReader.verify.readAfter(setMilestone, setBefore)).status, "satisfied",
  "PATCH milestone set resolves verified producer number.");
await reject("unresolved milestone producer", () =>
  setReader.verify.readBefore(setMilestone), "INVALID_SPEC");
await reject("missing created issue producer", () =>
  close.verify.readBefore(closeCreated), "INVALID_SPEC");
await reject("wrong bound issue number", () =>
  close.verify.readBefore(closeCreated, { bindings: { I: { number: 77 } } }),
  "IDENTITY_MISMATCH"); // marker points to #11, GET #77 cannot match.
await reject("wrong explicit issue ID", () =>
  patch.verify.readBefore(update, { expectedIdentity: { id: 999 } }),
  "IDENTITY_MISMATCH");
await reject("cross-reader before result", () =>
  close.verify.readAfter(create, before), "INVALID_SPEC");
await reject("cross-descriptor before result", () =>
  patch.verify.readAfter(closeCreated, beforeUpdate), "INVALID_SPEC");
await reject("forged before result", () =>
  patch.verify.readAfter(update, { ...beforeUpdate }), "INVALID_SPEC");

const duplicate = reader({
  [LIST]: () => response([issue({ state: "open" })], 200,
    '<' + PAGE2 + '>; rel="next"'),
  [PAGE2]: () => response([
    issue({ number: 16, id: 1600, node_id: "I_1600", state: "closed" }),
  ]),
});
await reject("duplicate exact issue marker across all pages and states", () =>
  duplicate.verify.readBefore(create, M), "AMBIGUOUS_MARKER");
equal(duplicate.calls, [LIST, PAGE2], "Second page read before declaring unique marker.");
const badCatalog = reader({
  [LIST]: () => response([issue()]),
  [ROOT + "/11"]: () => response(issue({ id: 1101 })),
});
await reject("catalog-detail REST id mismatch", () =>
  badCatalog.verify.readBefore(create, M), "IDENTITY_MISMATCH");
const badNode = reader({
  [LIST]: () => response([issue()]),
  [ROOT + "/11"]: () => response(issue({ node_id: "I_1101" })),
});
await reject("catalog-detail node_id mismatch", () =>
  badNode.verify.readBefore(create, M), "IDENTITY_MISMATCH");
const alteredFields = reader({
  [LIST]: () => response([issue()]),
  [ROOT + "/11"]: () => response(issue({ state: "closed" })),
});
await reject("catalog/detail state disagree", () =>
  alteredFields.verify.readBefore(create, M), "IDENTITY_MISMATCH");
const stale = reader({
  [LIST]: () => response([issue({ state: "closed" })]),
  [ROOT + "/11"]: () => response(issue({ state: "closed" })),
});
await reject("marker exists but initial state incompatible", () =>
  stale.verify.readBefore(create, M), "POSTCONDITION_MISMATCH");
const missingAfter = reader({ [LIST]: () => response([]) });
const missingBefore = await missingAfter.verify.readBefore(create, M);
await reject("unknown POST cannot authorize a duplicate", () =>
  missingAfter.verify.readAfter(create, missingBefore), "INDETERMINATE_WRITE");

const markerDrift = reader({
  [LIST]: () => response([issueU({ body: "marker removed" })]),
  [ROOT + "/12"]: () => response(issueU({ body: "marker removed" })),
});
await reject("marker absent on update must not adopt issue by number", () =>
  markerDrift.verify.readBefore(update), "IDENTITY_MISMATCH");
const conflictingMarker = reader({
  [LIST]: () => response([issueU({ body: "Original " + marker("U") }),
    issueU({ number: 15, id: 1500, node_id: "I_1500" })]),
});
await reject("duplicate issue owner on PATCH", () =>
  conflictingMarker.verify.readBefore(update), "AMBIGUOUS_MARKER");
const prOnly = reader({ [LIST]: () => response([pr()]) });
equal((await prOnly.verify.readBefore(create, M)).status, "unsatisfied",
  "A PR carrying the marker is excluded from issue identity matching.");

const omitted: ApplyPostconditionSpec = {
  ...update, predicates: [{ field: "state", comparison: "exact", expected: "closed" }],
};
let externalBody = false;
const drift = reader({
  [LIST]: () => response([issueU({ state: externalBody ? "closed" : "open",
    body: externalBody ? "Edited " + marker("U") : "Original " + marker("U") })]),
  [ROOT + "/12"]: () => response(issueU({ state: externalBody ? "closed" : "open",
    body: externalBody ? "Edited " + marker("U") : "Original " + marker("U") })),
});
const driftBefore = await drift.verify.readBefore(omitted);
externalBody = true;
await reject("omitted field drift during PATCH", () =>
  drift.verify.readAfter(omitted, driftBefore), "POSTCONDITION_MISMATCH");
const unchanged = reader({
  [LIST]: () => response([issueU()]),
  [ROOT + "/12"]: () => response(issueU()),
});
const staleBefore = await unchanged.verify.readBefore(update);
await reject("unchanged PATCH must not claim verified outcome", () =>
  unchanged.verify.readAfter(update, staleBefore), "POSTCONDITION_MISMATCH");

for (const [status, code] of [
  [401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [429, "RATE_LIMITED"],
] as const) {
  const blocked = reader({ [LIST]: () => response({ message: SECRET }, status) });
  await reject("HTTP " + status + " is not absence", () =>
    blocked.verify.readBefore(create, M), code);
}
const secondFail = reader({
  [LIST]: () => response([pr()], 200, '<' + PAGE2 + '>; rel="next"'),
  [PAGE2]: () => response({ message: SECRET }, 403),
});
await reject("incomplete pagination cannot establish marker uniqueness", () =>
  secondFail.verify.readBefore(create, M), "FORBIDDEN");
const crossRepo = reader({
  [LIST]: () => response([], 200,
    '<https://api.github.com/repos/other/repo/issues?state=all&per_page=100&page=2>; rel="next"'),
});
await reject("off-repository page", () =>
  crossRepo.verify.readBefore(create, M), "INCOMPLETE_CATALOG");
const crossOrigin = reader({
  [LIST]: () => response([], 200,
    '<https://evil.example/repos/acme/widgets/issues?state=all&per_page=100&page=2>; rel="next"'),
});
await reject("off-origin page", () =>
  crossOrigin.verify.readBefore(create, M), "INCOMPLETE_CATALOG");
const skipped = reader({
  [LIST]: () => response([pr()], 200, "<" + LIST + '&page=6>; rel="next"'),
});
await reject("non-consecutive page", () =>
  skipped.verify.readBefore(create, M), "INCOMPLETE_CATALOG");
const malformed = reader({ [LIST]: () => response({ partial: true }) });
await reject("catalog not an array", () =>
  malformed.verify.readBefore(create, M), "INCOMPLETE_CATALOG");
const collision = reader({ [LIST]: () => response([issue(), issue({
  number: 11, id: 1500, node_id: "I_1500",
})]) });
await reject("duplicate REST number on catalog", () =>
  collision.verify.readBefore(create, M), "INCOMPLETE_CATALOG");
const noId = reader({ [LIST]: () => response([issue({ id: undefined })]) });
await reject("missing REST id", () =>
  noId.verify.readBefore(create, M), "INVALID_RESPONSE");
const noNode = reader({ [LIST]: () => response([issue({ node_id: undefined })]) });
await reject("missing REST node ID", () =>
  noNode.verify.readBefore(create, M), "INVALID_RESPONSE");
const noBody = reader({ [LIST]: () => response([issue({ body: undefined })]) });
await reject("incomplete body cannot prove marker", () =>
  noBody.verify.readBefore(create, M), "INVALID_RESPONSE");
const missingMilestone = reader({ [LIST]: () =>
  response([issue({ milestone: undefined })]) });
await reject("missing milestone property means unknown state", () =>
  missingMilestone.verify.readBefore(create, M), "INVALID_RESPONSE");
const redirect = reader({ [LIST]: () =>
  response([], 200, null, "https://unsafe.example/token-capture") });
await reject("redirect forbidden", () =>
  redirect.verify.readBefore(create, M), "READ_FAILED");
const transport = reader({ [LIST]: () => { throw Error(SECRET + " hidden exception"); } });
await reject("transport exception sanitization", () =>
  transport.verify.readBefore(create, M), "READ_FAILED");
const badJson = reader({ [LIST]: () => response(Error(SECRET)) });
await reject("malformed JSON sanitized", () =>
  badJson.verify.readBefore(create, M), "INVALID_RESPONSE");
const invalid = reader({ [LIST]: () => { throw Error("must not be called"); } });
await reject("unsafe target repository rejected pre-I/O", () =>
  invalid.verify.readBefore({ ...create, repository: "bad/other/repo" }, M), "INVALID_SPEC");
equal(invalid.calls, [], "Invalid specification cannot make GitHub requests.");
await reject("wrong kind not accepted by issue verifier", () =>
  invalid.verify.readBefore({ ...create, kind: "milestone.create" }, M), "INVALID_SPEC");
await reject("unsupported nested update field not accepted", () =>
  invalid.verify.readBefore({ ...update, predicates: [
    { field: "labels" as "state", expected: "closed", comparison: "exact" },
  ] }), "INVALID_SPEC");
await reject("malformed caller context sanitized", () =>
  invalid.verify.readBefore(update, { bindings: null as unknown as {} }), "INVALID_SPEC");

console.log("M8.1.6b.3 issue GET readback: markers, PR exclusion, refs, replay, drift, permissions, and failures passed.");
