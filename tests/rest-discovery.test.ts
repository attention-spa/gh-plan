import {
  createRestDiscoveryTransport,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
  type GithubStateSnapshot,
  type NormalizedDesiredStateGraph,
} from "../src/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (stable(actual) !== stable(expected)) {
    throw new Error(`${message}\nexpected: ${stable(expected)}\nactual:   ${stable(actual)}`);
  }
}

class HeadersLike {
  readonly values: Record<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.values = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }

  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  statusText = status >= 200 && status < 300 ? "OK" : "Failure",
): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new HeadersLike(headers),
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

interface RequestRecord {
  url: string;
  init?: FetchRequestInitLike;
}

type Route = FetchResponseLike | (() => FetchResponseLike | Promise<FetchResponseLike>);

function fakeFetch(routes: Record<string, Route>, requests: RequestRecord[] = []): FetchLike {
  return async (url, init) => {
    requests.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return typeof route === "function" ? await route() : route;
  };
}

const desired: NormalizedDesiredStateGraph = {
  repository: { fullName: "acme/widgets" },
  resources: [],
  relationships: [],
};

function baseRoutes(): Record<string, Route> {
  return {
    "https://api.github.com/repos/acme/widgets": response(200, {
      id: 101,
      node_id: "R_101",
      full_name: "acme/widgets",
      owner: { login: "acme", type: "Organization" },
    }),
    "https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100": response(200, [
      {
        id: 202,
        node_id: "I_202",
        number: 2,
        title: "Second",
        body: "Body 2",
        state: "closed",
        milestone: { number: 7 },
        type: { id: 12, node_id: "IT_12", name: "Task" },
      },
      {
        id: 999,
        node_id: "PR_999",
        number: 99,
        title: "PR",
        body: null,
        state: "open",
        pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/99" },
      },
    ], {
      link: '<https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100&page=2>; rel="next"',
    }),
    "https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100&page=2": response(200, [
      {
        id: 201,
        node_id: "I_201",
        number: 1,
        title: "First",
        body: null,
        state: "open",
        milestone: null,
        type: { id: 11, node_id: "IT_11", name: "Bug" },
      },
    ]),
    "https://api.github.com/repos/acme/widgets/milestones?state=all&per_page=100": response(200, [
      {
        id: 707,
        node_id: "M_707",
        number: 7,
        title: "Foundation",
        description: "Base milestone",
        state: "open",
      },
    ]),
    "https://api.github.com/repos/acme/widgets/issue-types": response(200, [
      { id: 12, node_id: "IT_12", name: "Task" },
      { id: 11, node_id: "IT_11", name: "Bug" },
    ]),
    "https://api.github.com/orgs/acme/issue-fields": response(200, [
      {
        id: 32,
        name: "Labels",
        data_type: "multi_select",
        options: [
          { id: 322, name: "Backend" },
          { id: 321, name: "Frontend" },
        ],
      },
      {
        id: 30,
        name: "Priority",
        data_type: "single_select",
        options: [
          { id: 302, name: "Low" },
          { id: 301, name: "High" },
        ],
      },
      { id: 31, name: "Points", data_type: "number" },
      { id: 33, name: "Due Date", data_type: "date" },
      { id: 34, name: "DRI", data_type: "text" },
    ]),
    "https://api.github.com/repos/acme/widgets/issues/1/issue-field-values?per_page=100": response(200, [
      {
        issue_field_id: 30,
        issue_field_name: "Priority",
        data_type: "single_select",
        value: 301,
        single_select_option: { id: 301, name: "High" },
      },
      {
        issue_field_id: 32,
        issue_field_name: "Labels",
        data_type: "multi_select",
        value: "Frontend,Backend",
        multi_select_options: [
          { id: 321, name: "Frontend" },
          { id: 322, name: "Backend" },
        ],
      },
      { issue_field_id: 31, issue_field_name: "Points", data_type: "number", value: 5 },
      { issue_field_id: 33, issue_field_name: "Due Date", data_type: "date", value: "2026-11-01" },
      { issue_field_id: 34, issue_field_name: "DRI", data_type: "text", value: "Ada" },
    ]),
    "https://api.github.com/repos/acme/widgets/issues/2/issue-field-values?per_page=100": response(200, []),
    "https://api.github.com/repos/acme/widgets/issues/1/parent": response(404, { message: "Not Found" }, {}, "Not Found"),
    "https://api.github.com/repos/acme/widgets/issues/2/parent": response(200, { number: 1 }),
    "https://api.github.com/repos/acme/widgets/issues/1/dependencies/blocked_by?per_page=100": response(200, [
      { number: 2 },
      { number: 2 },
    ]),
    "https://api.github.com/repos/acme/widgets/issues/2/dependencies/blocked_by?per_page=100": response(200, []),
    "https://api.github.com/repos/acme/widgets/issues/1/relates_to?per_page=100": response(200, [
      { id: 202, number: 2 },
      { id: 202, number: 2 },
    ], {
      link: '<https://api.github.com/repos/acme/widgets/issues/1/relates_to?per_page=100&page=2>; rel="next"',
    }),
    "https://api.github.com/repos/acme/widgets/issues/1/relates_to?per_page=100&page=2": response(200, [
      { id: 209, number: 9 },
    ]),
    "https://api.github.com/repos/acme/widgets/issues/2/relates_to?per_page=100": response(200, [
      { id: 201, number: 1 },
    ]),
  };
}

async function discoverWith(routes: Record<string, Route>, requests: RequestRecord[] = []): Promise<GithubStateSnapshot> {
  const transport = createRestDiscoveryTransport({
    auth: "secret-token",
    fetch: fakeFetch(routes, requests),
  });
  // Discovery is now two-phase; these existing fixtures deliberately test
  // detailed REST mapping for the two known issues.
  const broad = await transport.discover(desired);
  return transport.enrich(broad, [1, 2]);
}

// Injected fetch wins, every request carries the required GitHub headers, pagination follows Link,
// PRs are excluded, and normalized output is deterministic.
const requests: RequestRecord[] = [];
const snapshot = await discoverWith(baseRoutes(), requests);
assert(requests.length > 0, "discovery should use injected fetch");
for (const request of requests) {
  equal(request.init?.method, "GET", "REST discovery uses GET only");
  equal(request.init?.headers?.Accept, "application/vnd.github+json", "Accept header");
  equal(request.init?.headers?.Authorization, "Bearer secret-token", "Authorization header");
  equal(request.init?.headers?.["X-GitHub-Api-Version"], "2026-03-10", "API version header");
}
assert(
  requests.some((request) => request.url.endsWith("page=2")),
  "Link rel=next pagination should be followed",
);
assert(
  requests.some((request) => request.url.endsWith("/issues/1/relates_to?per_page=100&page=2")),
  "Native relates_to relationships should follow pagination",
);

equal(snapshot, {
  repository: { fullName: "acme/widgets", id: 101, nodeId: "R_101" },
  issues: [
    {
      kind: "issue",
      number: 1,
      id: 201,
      nodeId: "I_201",
      title: "First",
      body: null,
      state: "open",
      milestoneNumber: null,
      issueType: "Bug",
      fields: {
        DRI: "Ada",
        "Due Date": "2026-11-01",
        Labels: ["Backend", "Frontend"],
        Points: 5,
        Priority: "High",
      },
      parentNumber: null,
      blockedByNumbers: [2],
      relatesToNumbers: [2, 9],
    },
    {
      kind: "issue",
      number: 2,
      id: 202,
      nodeId: "I_202",
      title: "Second",
      body: "Body 2",
      state: "closed",
      milestoneNumber: 7,
      issueType: "Task",
      fields: {},
      parentNumber: 1,
      blockedByNumbers: [],
      relatesToNumbers: [1],
    },
  ],
  milestones: [{
    kind: "milestone",
    number: 7,
    id: 707,
    nodeId: "M_707",
    title: "Foundation",
    description: "Base milestone",
    state: "open",
  }],
  issueTypes: [
    { id: 11, nodeId: "IT_11", name: "Bug" },
    { id: 12, nodeId: "IT_12", name: "Task" },
  ],
  issueFields: [
    { id: 34, name: "DRI", dataType: "text" },
    { id: 33, name: "Due Date", dataType: "date" },
    {
      id: 32,
      name: "Labels",
      dataType: "multi_select",
      options: [
        { id: 322, name: "Backend" },
        { id: 321, name: "Frontend" },
      ],
    },
    { id: 31, name: "Points", dataType: "number" },
    {
      id: 30,
      name: "Priority",
      dataType: "single_select",
      options: [
        { id: 301, name: "High" },
        { id: 302, name: "Low" },
      ],
    },
  ],
}, "complete REST discovery snapshot");

// Non-organization repositories skip organization issue-field and per-issue field-value reads.
const userRequests: RequestRecord[] = [];
const userDesired: NormalizedDesiredStateGraph = {
  repository: { fullName: "alice/widgets" },
  resources: [],
  relationships: [],
};
const userRoutes: Record<string, Route> = {
  "https://api.github.com/repos/alice/widgets": response(200, {
    id: 1,
    node_id: "R_1",
    full_name: "alice/widgets",
    owner: { login: "alice", type: "User" },
  }),
  "https://api.github.com/repos/alice/widgets/issues?state=all&per_page=100": response(200, []),
  "https://api.github.com/repos/alice/widgets/milestones?state=all&per_page=100": response(200, []),
  // User-owned repos can return populated issue types; do not infer absence
  // from the owner's type (V3 observed a populated response on octocat/Hello-World).
  "https://api.github.com/repos/alice/widgets/issue-types": response(200, [
    { id: 3, node_id: "IT_3", name: "Feature" },
    { id: 1, node_id: "IT_1", name: "Bug" },
    { id: 2, node_id: "IT_2", name: "Task" },
  ]),
};
const userSnapshot = await createRestDiscoveryTransport({
  auth: "secret-token",
  fetch: fakeFetch(userRoutes, userRequests),
}).discover(userDesired);
equal(userSnapshot.issueFields, [], "user-owned repositories have no organization issue fields");
equal(userSnapshot.issueTypes, [
  { id: 1, nodeId: "IT_1", name: "Bug" },
  { id: 3, nodeId: "IT_3", name: "Feature" },
  { id: 2, nodeId: "IT_2", name: "Task" },
], "successful user-owned issue-types responses must be preserved and sorted");
assert(!userRequests.some((request) => request.url.includes("/orgs/")), "user-owned repository must skip org field discovery");
assert(!userRequests.some((request) => request.url.includes("issue-field-values")), "user-owned repository must skip field-value discovery");

// Missing transport is classified without leaking auth.
const savedFetch = (globalThis as { fetch?: unknown }).fetch;
try {
  (globalThis as { fetch?: unknown }).fetch = undefined;
  let missingTransport: unknown;
  try {
    createRestDiscoveryTransport({ auth: "missing-transport-secret" });
  } catch (error) {
    missingTransport = error;
  }
  assert(missingTransport instanceof Error, "missing transport should throw an Error");
  assert((missingTransport as { code?: string }).code === "NO_REST_TRANSPORT", "missing transport code");
  assert(!String(missingTransport).includes("missing-transport-secret"), "missing transport error must not leak token");
} finally {
  (globalThis as { fetch?: unknown }).fetch = savedFetch;
}

async function expectRepoFailure(
  status: number,
  expectedCode: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const token = `token-${status}-${expectedCode}`;
  const transport = createRestDiscoveryTransport({
    auth: token,
    fetch: fakeFetch({
      "https://api.github.com/repos/acme/widgets": response(
        status,
        { message: `server echoed ${token}` },
        headers,
        "Failure",
      ),
    }),
  });
  let caught: unknown;
  try {
    await transport.discover(desired);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `${status} should throw`);
  assert((caught as { code?: string }).code === expectedCode, `${status} classification`);
  const serialized = JSON.stringify(caught);
  assert(!String(caught).includes(token), `${status} message must not leak token`);
  assert(!serialized.includes(token), `${status} safe error data must not leak token`);
  assert(!serialized.includes("server echoed"), `${status} error must not leak response body`);
}

await expectRepoFailure(401, "AUTH_FAILED");
await expectRepoFailure(403, "FORBIDDEN");
await expectRepoFailure(403, "RATE_LIMITED", { "x-ratelimit-remaining": "0" });
await expectRepoFailure(404, "NOT_FOUND");
await expectRepoFailure(429, "RATE_LIMITED");

// Malformed successful JSON is classified safely.
let invalidResponse: unknown;
try {
  await discoverWith({
    "https://api.github.com/repos/acme/widgets": response(200, new Error("secret parser detail")),
  });
} catch (error) {
  invalidResponse = error;
}
assert(invalidResponse instanceof Error, "invalid successful JSON should throw");
assert((invalidResponse as { code?: string }).code === "INVALID_RESPONSE", "invalid response classification");
assert(!String(invalidResponse).includes("secret parser detail"), "parser details must not leak");

// Repeated pagination URLs are rejected rather than looping forever.
const cyclicRoutes = baseRoutes();
cyclicRoutes["https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100"] = response(200, [], {
  link: '<https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100>; rel="next"',
});
let paginationCycle: unknown;
try {
  await discoverWith(cyclicRoutes);
} catch (error) {
  paginationCycle = error;
}
assert(paginationCycle instanceof Error, "pagination cycle should throw");
assert((paginationCycle as { code?: string }).code === "PAGINATION_CYCLE", "pagination cycle classification");

// Pagination may never redirect the bearer token to another origin.
const foreignRoutes = baseRoutes();
foreignRoutes["https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100"] = response(200, [], {
  link: '<https://evil.example/issues?page=2>; rel="next"',
});
let unsafePagination: unknown;
try {
  await discoverWith(foreignRoutes);
} catch (error) {
  unsafePagination = error;
}
assert(unsafePagination instanceof Error, "foreign pagination URL should throw");
assert((unsafePagination as { code?: string }).code === "UNSAFE_PAGINATION_URL", "foreign pagination URL classification");

// Invalid native relationship responses must fail safely rather than emit unsound IDs.
const invalidRelationsRoutes = baseRoutes();
invalidRelationsRoutes["https://api.github.com/repos/acme/widgets/issues/1/relates_to?per_page=100"] = response(200, [
  { number: "not-a-number" },
]);
let invalidRelations: unknown;
try {
  await discoverWith(invalidRelationsRoutes);
} catch (error) {
  invalidRelations = error;
}
assert(invalidRelations instanceof Error, "invalid native relates_to response should throw");
assert((invalidRelations as { code?: string }).code === "INVALID_RESPONSE", "invalid native relates_to error classification");

// Native relationship failures retain the existing redaction rules.
const rejectedRelationsRoutes = baseRoutes();
rejectedRelationsRoutes["https://api.github.com/repos/acme/widgets/issues/1/relates_to?per_page=100"] = response(403, {
  message: "server echoed secret-token",
}, {}, "Forbidden");
let rejectedRelations: unknown;
try {
  await discoverWith(rejectedRelationsRoutes);
} catch (error) {
  rejectedRelations = error;
}
assert(rejectedRelations instanceof Error, "forbidden native relates_to request should throw");
assert((rejectedRelations as { code?: string }).code === "FORBIDDEN", "related request failure classification");
assert(!JSON.stringify(rejectedRelations).includes("secret-token"), "related request errors must redact auth");


// M1.5: only the optional issue-types endpoint may return 404 without
// interrupting otherwise-valid discovery.
const unavailableTypesRequests: RequestRecord[] = [];
const unavailableTypesRoutes = baseRoutes();
unavailableTypesRoutes["https://api.github.com/repos/acme/widgets/issue-types"] =
  response(404, { message: "Not Found" }, {}, "Not Found");
const withoutTypes = await discoverWith(unavailableTypesRoutes, unavailableTypesRequests);
equal(withoutTypes.issueTypes, [], "404 issue-types endpoint should produce an empty type list");
equal(withoutTypes.issues, snapshot.issues,
  "optional issue-types 404 must not discard discovered and enriched issues");
equal(withoutTypes.milestones, snapshot.milestones,
  "optional issue-types 404 must not discard milestones");
equal(withoutTypes.issueFields, snapshot.issueFields,
  "optional issue-types 404 must not skip organization issue-field discovery");
assert(unavailableTypesRequests.some((request) =>
  request.url === "https://api.github.com/repos/acme/widgets/issue-types"),
  "discovery must attempt the issue-types endpoint before optional 404 fallback");

// User-owned repos can likewise have an unavailable issue-types endpoint.
const unavailableUserRoutes: Record<string, Route> = {
  ...userRoutes,
  "https://api.github.com/repos/alice/widgets/issue-types":
    response(404, { message: "Not Found" }, {}, "Not Found"),
};
const unavailableUser = await createRestDiscoveryTransport({
  auth: "secret-token",
  fetch: fakeFetch(unavailableUserRoutes),
}).discover(userDesired);
equal(unavailableUser.issueTypes, [], "404 on a user-owned issue-types endpoint must not fail discovery");
equal(unavailableUser.repository.fullName, "alice/widgets", "repository discovery must continue after issue-types 404");

// The 404 fallback must not mask permission failures, unexpected HTTP status
// codes, or malformed 200 responses.
for (const [status, expected] of [
  [401, "AUTH_FAILED"],
  [403, "FORBIDDEN"],
  [500, "REST_FAILURE"],
] as const) {
  const routes = baseRoutes();
  routes["https://api.github.com/repos/acme/widgets/issue-types"] =
    response(status, { message: "secret-token must not be leaked" });
  let failure: unknown;
  try {
    await discoverWith(routes);
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error, "HTTP " + status + " should fail issue-types discovery");
  assert((failure as { code?: string }).code === expected, "HTTP " + status + " must not be treated as optional 404");
  assert(!JSON.stringify(failure).includes("secret-token"), "HTTP " + status + " must not leak response body or auth");
}
for (const payload of [null, { items: [] }, "not-an-array"]) {
  const routes = baseRoutes();
  routes["https://api.github.com/repos/acme/widgets/issue-types"] = response(200, payload);
  let invalidTypes: unknown;
  try {
    await discoverWith(routes);
  } catch (error) {
    invalidTypes = error;
  }
  assert(invalidTypes instanceof Error, "invalid 200 issue-types shape must fail");
  assert((invalidTypes as { code?: string }).code === "INVALID_RESPONSE",
    "invalid 200 shape must not be interpreted as a missing endpoint");
}
