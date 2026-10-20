import {
  createRestDiscoveryTransport,
  type FetchLike,
  type FetchResponseLike,
  type NormalizedDesiredStateGraph,
} from "../src/index.ts";

class HeadersLike {
  readonly values: Record<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.values = values;
  }

  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

function response(body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new HeadersLike(headers),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

const token = "pagination-secret-token";
const fetch: FetchLike = async (url) => {
  if (url === "https://api.github.com/repos/acme/widgets") {
    return response({
      id: 1,
      node_id: "R_1",
      full_name: "acme/widgets",
      owner: { login: "acme", type: "Organization" },
    });
  }
  if (url === "https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100") {
    return response([], {
      link: `<https://evil.example/issues?echo=${token}>; rel="next"`,
    });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const desired: NormalizedDesiredStateGraph = {
  repository: { fullName: "acme/widgets" },
  resources: [],
  relationships: [],
};

let caught: unknown;
try {
  await createRestDiscoveryTransport({ auth: token, fetch }).discover(desired);
} catch (error) {
  caught = error;
}

if (!(caught instanceof Error)) throw new Error("unsafe pagination URL should throw");
if ((caught as { code?: string }).code !== "UNSAFE_PAGINATION_URL") {
  throw new Error("unsafe pagination URL should use UNSAFE_PAGINATION_URL");
}
if (String(caught).includes(token) || JSON.stringify(caught).includes(token)) {
  throw new Error("safe error must not retain token-bearing pagination metadata");
}
