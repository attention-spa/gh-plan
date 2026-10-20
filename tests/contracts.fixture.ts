import type {
  FetchLike,
  GithubDiagnostic,
  GithubPlan,
  GithubPlannerConfig,
  JsonValue,
  NormalizedDesiredStateGraph,
  PlanRequest,
  PlanStep,
  ResourceResolution,
} from "../src/index.ts";

const customFetch: FetchLike = async (input, init) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  url: input,
  headers: { get: () => null },
  async json() {
    return { method: init?.method ?? "GET" };
  },
  async text() {
    return "ok";
  },
});

const config = {
  schema: { repository: "attention-spa/example" },
  auth: "runtime-only-secret",
  fetch: customFetch,
  octokit: { graphql: async () => ({}) },
  mode: "graphql",
} satisfies GithubPlannerConfig;

void config;

const graph = {
  repository: { fullName: "attention-spa/example" },
  resources: [
    {
      kind: "milestone",
      logicalId: "M1",
      management: "managed",
      identity: { number: 1 },
      desired: {
        title: { op: "set", value: "Foundation" },
      },
    },
    {
      kind: "issue",
      logicalId: "PARENT",
      management: "managed",
      identity: { number: 42, marker: "gh-plan:PARENT" },
      desired: {
        title: { op: "set", value: "Parent" },
      },
    },
    {
      kind: "issue",
      logicalId: "CHILD",
      management: "managed",
      desired: {
        title: { op: "set", value: "Child" },
        body: { op: "remove" },
        milestone: { op: "set", value: { logicalId: "M1" } },
        issueType: { op: "set", value: "Task" },
        fields: {
          Priority: { op: "set", value: "High" },
          Effort: { op: "remove" },
        },
      },
    },
    {
      kind: "issue",
      logicalId: "EXTERNAL",
      management: "reference",
      identity: { number: 99 },
    },
  ],
  relationships: [
    { kind: "parent", parent: "PARENT", child: "CHILD" },
    { kind: "blocked_by", issue: "CHILD", blocker: "EXTERNAL" },
    { kind: "related", from: "CHILD", to: "EXTERNAL" },
  ],
} satisfies NormalizedDesiredStateGraph;

void graph;

const resolutions = [
  {
    logicalId: "PARENT",
    kind: "issue",
    status: "existing",
    identity: { number: 42, id: 4242, nodeId: "I_parent" },
  },
  {
    logicalId: "CHILD",
    kind: "issue",
    status: "new",
  },
] satisfies ResourceResolution[];

const createStep = {
  id: "issue.create:CHILD",
  kind: "issue.create",
  logicalId: "CHILD",
  status: "planned",
  current: null,
  desired: { title: "Child" },
  reason: "CHILD does not exist yet",
  dependsOn: [],
  request: {
    protocol: "rest",
    method: "POST",
    path: "/repos/attention-spa/example/issues",
    body: { title: "Child" },
  },
  preconditions: ["repository remains accessible"],
  expectedPostconditions: ["CHILD resolves to a GitHub issue"],
  destructive: false,
  reversible: "partial",
} satisfies PlanStep;

const noopStep = {
  id: "issue.title:PARENT",
  kind: "issue.update",
  logicalId: "PARENT",
  status: "noop",
  current: { title: "Parent" },
  desired: { title: "Parent" },
  reason: "Title already matches",
  dependsOn: [],
  preconditions: [],
  expectedPostconditions: [],
  destructive: false,
  reversible: true,
} satisfies PlanStep;

const warning = {
  code: "UNSUPPORTED_SCHEMA_FEATURE",
  severity: "warning",
  blocking: false,
  logicalId: "CHILD",
  schemaPath: "issues[1].futureFeature",
  message: "Feature is not supported in v0.1",
  details: { feature: "futureFeature" },
} satisfies GithubDiagnostic;

const plan = {
  metadata: {
    planner: "gh-plan",
    version: "0.1.0",
    mode: "rest",
  },
  repository: {
    fullName: "attention-spa/example",
    id: 123,
    nodeId: "R_example",
  },
  desired: {
    resourceCount: 4,
    relationshipCount: 3,
  },
  resolutions,
  steps: [createStep],
  noops: [noopStep],
  warnings: [warning],
  blockers: [],
  unsupported: [],
  summary: {
    planned: 1,
    noops: 1,
    blocked: 0,
    unsupported: 0,
    warnings: 1,
  },
  readiness: "ready_with_warnings",
} satisfies GithubPlan;

void plan;

type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

const planHasNoAuthField: HasKey<GithubPlan, "auth"> = false;
const planHasNoTokenField: HasKey<GithubPlan, "token"> = false;
const requestHasNoAuthField: HasKey<PlanRequest, "auth"> = false;
const requestHasNoTokenField: HasKey<PlanRequest, "token"> = false;

void planHasNoAuthField;
void planHasNoTokenField;
void requestHasNoAuthField;
void requestHasNoTokenField;

const serializableCurrentState: JsonValue = {
  title: "Parent",
  milestone: null,
  labels: ["one", "two"],
};

void serializableCurrentState;
