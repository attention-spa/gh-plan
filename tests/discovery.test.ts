import {
  createRestDiscoveryTransport,
  discoverAndResolve,
  type FetchLike,
  type FetchResponseLike,
  type GithubStateSnapshot,
  type NormalizedDesiredStateGraph,
} from "../src/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(message + "\nexpected: " + b + "\nactual: " + a);
}

const prefix = "https://api.github.com/repos/alice/widgets";
function response(status: number, data: unknown, link?: string): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 404 ? "Not Found" : "OK",
    headers: { get(name) { return name.toLowerCase() === "link" ? link ?? null : null; } },
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

const available = Array.from({ length: 200 }, (_, index) => {
  const number = index + 1;
  return {
    id: 1000 + number,
    node_id: "I_" + number,
    number,
    title: "Issue " + number,
    body: null,
    state: "open",
    milestone: null,
    type: null,
  };
});

function mockFetch(calls: string[]): FetchLike {
  return async (url) => {
    calls.push(url);
    if (url === prefix) return response(200, {
      id: 101,
      node_id: "R_101",
      full_name: "alice/widgets",
      owner: { login: "alice", type: "User" },
    });
    if (url === prefix + "/issues?state=all&per_page=100") {
      return response(200, available.slice(0, 100),
        "<" + prefix + "/issues?state=all&per_page=100&page=2>; rel=\"next\"");
    }
    if (url === prefix + "/issues?state=all&per_page=100&page=2") {
      return response(200, available.slice(100));
    }
    if (url === prefix + "/milestones?state=all&per_page=100") return response(200, []);
    if (url === prefix + "/issue-types") return response(200, []);
    const match = url.match(/^https:\/\/api\.github\.com\/repos\/alice\/widgets\/issues\/(\d+)\/(parent|dependencies\/blocked_by\?per_page=100|relates_to\?per_page=100)$/);
    if (match) {
      if (match[2] === "parent") return response(404, { message: "Not Found" });
      if (match[2] === "dependencies/blocked_by?per_page=100") {
        return response(200, match[1] === "2" ? [{ number: 199 }] : []);
      }
      return response(200, match[1] === "75" ? [{ number: 2 }] : []);
    }
    throw new Error("Unexpected REST request: " + url);
  };
}

const desired: NormalizedDesiredStateGraph = {
  repository: { fullName: "alice/widgets" },
  resources: [
    {
      logicalId: "first", kind: "issue", management: "managed",
      identity: { number: 2 }, desired: { title: { op: "set", value: "Issue 2" } },
    },
    {
      logicalId: "second", kind: "issue", management: "managed",
      identity: { number: 75 }, desired: { title: { op: "set", value: "Issue 75" } },
    },
    {
      logicalId: "relationship-reference", kind: "issue", management: "reference",
      identity: { number: 199 },
    },
    {
      logicalId: "unused-reference", kind: "issue", management: "reference",
      identity: { number: 170 },
    },
    {
      logicalId: "to-create", kind: "issue", management: "managed",
      desired: { title: { op: "set", value: "New issue not on GitHub" } },
    },
  ],
  relationships: [
    { kind: "blocked_by", issue: "first", blocker: "relationship-reference" },
    { kind: "relates_to", from: "first", to: "second" },
  ],
};

// First phase: listing 200 issues must NOT issue per-issue enrichment calls.
const broadCalls: string[] = [];
const transport = createRestDiscoveryTransport({ auth: "mock-token", fetch: mockFetch(broadCalls) });
const broad = await transport.discover(desired);
equal(broad.issues.length, 200, "first phase returns all 200 broad summaries");
equal(broadCalls.length, 5, "first phase uses repo, two issue pages, milestones and types only");
assert(broadCalls.every((url) => !/\/issues\/\d+\//.test(url)),
  "broad phase must not enrich any individual issue");
assert(broad.issues.every((issue) => issue.parentNumber === undefined
  && issue.blockedByNumbers === undefined && issue.relatesToNumbers === undefined),
  "broad issue summaries must not invent enriched fields");
equal(broad.issues.map((issue) => issue.number), available.map((issue) => issue.number),
  "broad issue order is deterministic");

// Orchestration resolves identities first, then enriches 2 managed issues and
// exactly one relationship endpoint; an unused reference and a new resource cost zero calls.
const calls: string[] = [];
const result = await discoverAndResolve(desired,
  createRestDiscoveryTransport({ auth: "mock-token", fetch: mockFetch(calls) }));
equal(result.resolution.blockers, [], "all desired identities should resolve");
equal(result.resolution.resolutions.find((r) => r.logicalId === "to-create")?.status,
  "new", "new resources must not become enrichment targets");
equal(result.snapshot.issues.length, 200, "enrichment must preserve broad summary coverage");
equal(result.snapshot.issues.map((issue) => issue.number),
  broad.issues.map((issue) => issue.number), "enriched snapshot must stay numerically sorted");
const detailCalls = calls.filter((url) => /\/issues\/\d+\//.test(url));
equal(detailCalls.length, 9, "only 3 touched user-owned issues need 3 detail calls each");
assert(detailCalls.length <= 3 * 3, "200-issue fixture exceeds the requested request budget");
equal(calls.length, 5 + 9, "discovery total must be five broad calls plus nine targeted calls");
const touchedNumbers = [...new Set(detailCalls.map((url) =>
  Number(url.match(/\/issues\/(\d+)\//)?.[1])))].sort((a, b) => a - b);
equal(touchedNumbers, [2, 75, 199], "only resolved desired issues and relationship references get enriched");
equal(result.snapshot.issues.find((i) => i.number === 2)?.blockedByNumbers, [199],
  "relationship detail should survive enrichment");
equal(result.snapshot.issues.find((i) => i.number === 75)?.relatesToNumbers, [2],
  "relates_to detail should survive enrichment");
assert(result.snapshot.issues.find((i) => i.number === 170)?.parentNumber === undefined,
  "unrelated reference-only issues must not be enriched");

// Enrich phase is side-effect free for the input snapshot, deduplicates requested
// issue numbers, and never returns issues in worker completion order.
const enriched = await transport.enrich(broad, [199, 2, 75, 2]);
equal(enriched.issues.length, 200, "targeted enrichment must retain all listed issues");
equal(enriched.issues.map((i) => i.number), broad.issues.map((i) => i.number),
  "merged snapshot must retain stable number ordering");
equal(broad.issues.find((i) => i.number === 2)?.blockedByNumbers, undefined,
  "enrichment must not mutate the original broad snapshot");
assert(broadCalls.length === 5 + 9,
  "duplicate requested issue numbers should not produce duplicate REST calls");
await transport.enrich(broad, []);
equal(broadCalls.length, 14, "empty enrich must issue no REST calls");
let unknown: unknown;
try { await transport.enrich(broad, [201]); } catch (error) { unknown = error; }
assert((unknown as { code?: string })?.code === "INVALID_RESPONSE",
  "explicit requests for unlisted issue numbers must fail safely");

// Prove the bounded worker pool never exceeds its configured concurrency and
// can execute multiple issue enrichments in parallel.
async function concurrencyCase(configured: number | undefined, expectedPeak: number): Promise<void> {
  const minimal: GithubStateSnapshot = {
    repository: { fullName: "alice/widgets" },
    issues: available.slice(0, 7).map((i) => ({
      kind: "issue", number: i.number, id: i.id, title: i.title, state: "open",
    })),
    milestones: [], issueTypes: [], issueFields: [],
  };
  let active = 0, peak = 0, parentReads = 0;
  const fetch: FetchLike = async (url) => {
    if (/\/parent$/.test(url)) {
      active++;
      peak = Math.max(peak, active);
      parentReads++;
      // Yield to sibling workers so an unbounded pool would exceed the cap.
      await Promise.resolve();
      await Promise.resolve();
      active--;
      return response(404, { message: "Not Found" });
    }
    if (/\/dependencies\/blocked_by\?per_page=100$/.test(url)
      || /\/relates_to\?per_page=100$/.test(url)) return response(200, []);
    throw new Error("Unexpected detail URL " + url);
  };
  const t = createRestDiscoveryTransport({
    auth: "mock-token", fetch,
    ...(configured === undefined ? {} : { enrichConcurrency: configured }),
  });
  const result = await t.enrich(minimal, [7, 6, 5, 4, 3, 2, 1]);
  equal(parentReads, 7, "each selected issue must be enriched once");
  equal(peak, expectedPeak, "enrichment concurrency cap must be respected");
  equal(result.issues.map((i) => i.number), [1, 2, 3, 4, 5, 6, 7],
    "output must be ordered regardless of worker scheduling");
}
await concurrencyCase(undefined, 4);
await concurrencyCase(2, 2);
await concurrencyCase(1, 1);
for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  let rejected: unknown;
  try { createRestDiscoveryTransport({ auth: "secret", fetch: mockFetch([]), enrichConcurrency: bad }); }
  catch (error) { rejected = error; }
  assert(rejected instanceof RangeError, "invalid enrichment concurrency must fail before discovery");
}
