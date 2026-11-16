import { normalizeSchema, planGithub, compileProjectItemSteps, bindPlanRequest,
  requestReferences } from "../src/index.ts";
import type { FetchLike, FetchResponseLike, GithubPlanSchema,
  GithubStateSnapshot, NormalizedDesiredStateGraph } from "../src/index.ts";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function equal(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message +
    "\nactual: " + JSON.stringify(a) + "\nexpected: " + JSON.stringify(b));
}
const repo = "alice/plan";
const base = "https://api.github.com/repos/" + repo;
const projectPath = "https://api.github.com/orgs/alice/projectsV2/7";
const schema = {
  repository: repo,
  projects: [{ logicalId: "ROADMAP", owner: "alice", number: 7 }],
  issues: [{
    logicalId: "TASK", management: "reference", identity: { number: 10 },
    projects: { ROADMAP: { "Notes": "Updated", "Points": 3 } },
  }],
  pullRequests: [{
    logicalId: "PR", head: "feature", base: "main", title: "Propose",
    projects: { ROADMAP: {
      "Notes": "Review", "Points": 5, "Due": "2026-11-25",
      "Status": "Doing", "Sprint": "Sprint 2",
    } },
  }],
} satisfies GithubPlanSchema;
const fields = [
  { id: 1, name: "Notes", data_type: "text" },
  { id: 2, name: "Points", data_type: "number" },
  { id: 3, name: "Due", data_type: "date" },
  { id: 4, name: "Status", data_type: "single_select",
    options: [{ id: "opt-todo", name: { raw: "Todo" } },
      { id: "opt-doing", name: { raw: "Doing" } }] },
  { id: 5, name: "Sprint", data_type: "iteration",
    configuration: { iterations: [{ id: "iter1", title: { raw: "Sprint 1" } },
      { id: "iter2", title: { raw: "Sprint 2" } }] } },
];
const projectItems = [{
  id: 90, content_type: "Issue",
  content: { id: 100, number: 10, repository_url: base },
  fields: [{ id: 1, value: "Old" }, { id: 2, value: 3 }],
}, {
  id: 999, content_type: "Issue",
  content: { id: 999, number: 10,
    repository_url: "https://api.github.com/repos/other/other" },
  fields: [],
}, {
  id: 91, content_type: "PullRequest",
  content: { id: 501, number: 51, base: { repo: { full_name: repo } } },
  fields: [{ id: 4, value: "opt-doing" }],
}];
function response(status: number, data: unknown): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, statusText: "Mock",
    headers: { get() { return null; } },
    async json() { return data; }, async text() { return JSON.stringify(data); } };
}
function fakeFetch(calls: string[], missing = false): FetchLike {
  return async (url, options) => {
    calls.push(url);
    check(options?.method === "GET", "Planner may only make GET requests.");
    check(options?.headers?.Authorization === "Bearer test-secret",
      "Auth stays in runtime transport headers.");
    if (url === base) return response(200,
      { id: 1, full_name: repo, owner: { type: "User" } });
    if (url === base + "/issues?state=all&per_page=100") return response(200, [
      { id: 100, number: 10, title: "Task", body: "", state: "open" },
    ]);
    if (url === base + "/milestones?state=all&per_page=100" ||
        url === base + "/issue-types") return response(200, []);
    if (url === base + "/pulls?state=open&head=alice%3Afeature&base=main&per_page=100")
      return response(200, []);
    if (url === base + "/git/ref/heads/feature" ||
        url === base + "/git/ref/heads/main") return response(200, { ref: "refs/heads/test" });
    if (url === base + "/compare/main...feature") return response(200, { ahead_by: 1 });
    if (url === projectPath) return response(missing ? 404 : 200, missing ? {} : { number: 7 });
    if (url === projectPath + "/fields?per_page=100") return response(200, fields);
    if (url === projectPath +
        "/items?q=repo%3Aalice%2Fplan&fields=1%2C2%2C3%2C4%2C5&per_page=100")
      return response(200, projectItems);
    throw Error("Unanticipated GET: " + url);
  };
}
const calls: string[] = [];
let plan = await planGithub({ schema, auth: "test-secret", fetch: fakeFetch(calls) });
equal(plan.readiness, "ready", "Project membership must be ready when board and fields are known.");
check(plan.steps.some((x) => x.kind === "pull_request.create"), "New PR must be planned.");
const adds = plan.steps.filter((x) => x.kind === "project.item.add");
equal(adds.length, 1, "Existing issue item must not be added twice.");
check(adds[0]!.logicalId === "project-item:ROADMAP:PR" &&
      adds[0]!.dependsOn.includes("pull_request.create:PR"),
  "New PR must precede project membership.");
const prAdd = adds[0]!;
check(prAdd.request?.protocol === "rest" &&
      prAdd.request.method === "POST" &&
      JSON.stringify(prAdd.request.body).includes("PullRequest"),
  "Project membership uses the native REST add-item POST.");
check(requestReferences(prAdd.request!).includes("PR"),
  "New project item must bind the created PR's content number.");
const patches = plan.steps.filter((x) => x.kind === "project.item.fields.set");
equal(patches.length, 2, "Issue and PR have field changes.");
const prPatch = patches.find((x) => x.logicalId === "project-item:ROADMAP:PR")!;
check(prPatch.dependsOn.includes("project.item.add:project-item:ROADMAP:PR"),
  "New item fields must depend on project.item.add.");
check(prPatch.request?.protocol === "rest" && Array.isArray(prPatch.request.path),
  "New item PATCH needs late-bound item id.");
const boundPatch = bindPlanRequest(prPatch.request!, {
  "project-item:ROADMAP:PR": { id: 987 },
});
check(boundPatch.protocol === "rest" && boundPatch.path.endsWith("/items/987"),
  "External binding must insert the newly created item REST id.");
check(JSON.stringify(prPatch.request).includes("opt-doing") &&
  JSON.stringify(prPatch.request).includes("iter2"),
  "Single select and iteration names must become existing IDs.");
const issuePatch = patches.find((x) => x.logicalId === "project-item:ROADMAP:TASK")!;
check(issuePatch.request?.protocol === "rest" &&
  issuePatch.request.path === "/orgs/alice/projectsV2/7/items/90",
  "Existing item fields must PATCH its numeric REST item ID.");
equal((issuePatch.request.body as {fields:unknown[]}).fields.length, 1,
  "Only changed issue fields should be patched.");
check(!JSON.stringify(plan).includes("test-secret"),
  "Plan results must never serialize authentication.");
check(!plan.steps.some((x) => /project.create|project.field.create|merge/.test(x.kind)),
  "No project/field creation or merging.");
check(calls.every((x) => x.startsWith("https://api.github.com/")),
  "Discovery cannot follow untrusted hosts.");

const repeated: string[] = [];
const repeat = await planGithub({ schema, auth: "test-secret", fetch: fakeFetch(repeated) });
equal(plan, repeat, "Identical project input must produce byte-stable plans.");
equal(calls, repeated, "REST request order must be deterministic.");

const missingCalls: string[] = [];
plan = await planGithub({ schema, auth: "test-secret", fetch: fakeFetch(missingCalls, true) });
equal(plan.readiness, "blocked", "A missing referenced board must block planning.");
check(plan.blockers.some((x) => x.code === "UNKNOWN_PROJECT"),
  "Missing board must produce a project-specific blocker.");
check(!plan.steps.some((x) => x.kind.startsWith("project.")),
  "A nonexistent board must never receive mutation proposals.");
check(!missingCalls.some((x) => x.includes("/items?")),
  "Missing board must not trigger item discovery.");

for (const invalid of [
  { projects: [{ logicalId: "ROADMAP", owner: "alice", number: 7, management: "managed" }] },
  { projects: [{ logicalId: "ROADMAP", owner: "alice", number: 7, fields: { Status: "Todo" } }] },
  { projects: [], issues: [{ logicalId: "I", projects: { UNKNOWN: {} } }] },
  { projects: [{ logicalId: "P", owner: "alice", number: 7 }],
    issues: [{ logicalId: "I", projects: { P: { Score: true } } }] },
]) {
  const result = normalizeSchema({ repository: repo, ...invalid });
  check(!result.ok, "Unsafe project authoring must block normalization.");
}
const normalized = normalizeSchema(schema);
check(normalized.ok && normalized.graph?.projectItems?.length === 2 &&
  normalized.graph.projects?.length === 1,
  "Schema must retain existing board references and both memberships.");
const baseSnapshot: GithubStateSnapshot = {
  repository: { fullName: repo }, issues: [], milestones: [],
  issueTypes: [], issueFields: [],
  projects: [{ logicalId: "ROADMAP", owner: "alice", number: 7, ownerType: "org",
    fields: [{ id: 4, name: "Status", dataType: "single_select",
      options: [{ id: "todo", name: "Todo" }] }],
    items: [] }],
};
const fixtureGraph = (value: string | number): NormalizedDesiredStateGraph => ({
  repository: { fullName: repo }, resources: [], relationships: [],
  projects: [{ logicalId: "ROADMAP", owner: "alice", number: 7, ownerType: "org" }],
  projectItems: [{ resourceLogicalId: "I", resourceKind: "issue",
    projectLogicalId: "ROADMAP", fields: { Status: value } }],
});
const resolved = [{ logicalId: "I", kind: "issue" as const,
  status: "existing" as const, identity: { id: 55, number: 6 } }];
const badOption = compileProjectItemSteps(fixtureGraph("Missing"), baseSnapshot, resolved);
check(badOption.blockers.some((x) => x.code === "UNKNOWN_PROJECT_FIELD_OPTION"),
  "Unknown project options must block item insertion.");
check(!badOption.steps.length, "Invalid fields must not create partial membership.");
const badType = compileProjectItemSteps(fixtureGraph(1), baseSnapshot, resolved);
check(badType.blockers.some((x) => x.code === "INVALID_SCHEMA"), "Option value must be a string.");
const unsupportedBoard = {
  ...baseSnapshot,
  projects: [{ ...baseSnapshot.projects![0]!,
    fields: [{ id: 4, name: "Status", dataType: "user" }] }],
};
const unsupported = compileProjectItemSteps(fixtureGraph("Alice"), unsupportedBoard, resolved);
check(unsupported.blockers.some((x) => x.code === "UNSUPPORTED_PROJECT_FIELD"),
  "Unsupported project field types must block.");
console.log("Projects v2 reference, scoped REST, idempotence, typed values, late binding, invalid/missing fixtures passed.");
