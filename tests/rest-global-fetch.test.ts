import {
  createRestDiscoveryTransport,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
  type NormalizedDesiredStateGraph,
} from "../src/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class HeadersLike {
  get(): string | null {
    return null;
  }
}

function response(body: unknown): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new HeadersLike(),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

const requests: Array<{ url: string; init?: FetchRequestInitLike }> = [];
const routes: Record<string, FetchResponseLike> = {
  "https://api.github.com/repos/alice/widgets": response({
    id: 1,
    node_id: "R_1",
    full_name: "alice/widgets",
    owner: { login: "alice", type: "User" },
  }),
  "https://api.github.com/repos/alice/widgets/issues?state=all&per_page=100": response([]),
  "https://api.github.com/repos/alice/widgets/milestones?state=all&per_page=100": response([]),
  "https://api.github.com/repos/alice/widgets/issue-types": response([]),
};
const fallback: FetchLike = async (url, init) => {
  requests.push({ url, init });
  const found = routes[url];
  if (!found) throw new Error(`Unexpected request: ${url}`);
  return found;
};

const desired: NormalizedDesiredStateGraph = {
  repository: { fullName: "alice/widgets" },
  resources: [],
  relationships: [],
};

const savedFetch = (globalThis as { fetch?: unknown }).fetch;
try {
  (globalThis as { fetch?: unknown }).fetch = fallback;
  const snapshot = await createRestDiscoveryTransport({ auth: "global-secret" }).discover(desired);
  assert(snapshot.repository.fullName === "alice/widgets", "global fetch fallback should discover repository");
  assert(requests.length === 4, "global fetch fallback should service every REST request");
  assert(requests.every((request) => request.init?.headers?.Authorization === "Bearer global-secret"), "global fetch fallback should receive auth headers");
} finally {
  (globalThis as { fetch?: unknown }).fetch = savedFetch;
}
