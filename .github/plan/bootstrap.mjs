#!/usr/bin/env node
/**
 * Phase A GitHub-native bootstrap. Requires Node >=22 and an authenticated gh CLI.
 *
 * Run without arguments to dry-run. Run with --apply only when the plan's
 * GitHub mutations have been authorized. Existing resources are identified
 * exclusively by canonical markers (or a known explicit legacy issue number).
 * This script never deletes an issue or changes repository visibility.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const spec = JSON.parse(readFileSync(new URL("./bootstrap.json", import.meta.url), "utf8"));
const root = "/repos/" + spec.repository;
const apply = process.argv.includes("--apply");
const marker = (id) => "<!-- gh-plan:" + id + " -->";
const issueMarker = /<!-- gh-plan:(PLAN|M[1-8]\.\d+(?:\.\d+)?) -->/g;
const stages = [
  "labels", "milestones", "tracker", "parents", "children",
  "parent-links", "child-links", "dependencies", "relations", "pin",
];

function request(method, path, payload) {
  const args = ["api", "--method", method, path, "-H", "X-GitHub-Api-Version: 2026-03-10"];
  if (payload !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: payload === undefined ? undefined : JSON.stringify(payload),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("GitHub request failed (" + method + " " + path + "; exit " +
      result.status + "). Authentication and transport details were suppressed.");
  }
  const output = result.stdout.trim();
  return output ? JSON.parse(output) : null;
}

function graphql(query, variables = {}) {
  const result = request("POST", "graphql", { query, variables });
  if (result.errors?.length) throw new Error("GraphQL request failed; response details suppressed.");
  return result.data;
}

function allIssues() {
  const results = [];
  for (let page = 1; page <= 100; page++) {
    const part = request("GET", root + "/issues?state=all&per_page=100&page=" + page);
    results.push(...part.filter((issue) => !issue.pull_request));
    if (part.length < 100) return results;
  }
  throw new Error("Issue pagination exceeded safe limit");
}

function snapshot() {
  const issues = allIssues();
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const byMarker = new Map();
  for (const issue of issues) {
    for (const match of (issue.body ?? "").matchAll(issueMarker)) {
      const previous = byMarker.get(match[1]);
      if (previous && previous.id !== issue.id) {
        throw new Error("Ambiguous gh-plan marker " + match[1] +
          " on issues #" + previous.number + " and #" + issue.number);
      }
      byMarker.set(match[1], issue);
    }
  }
  return {
    issues, byNumber, byMarker,
    milestones: request("GET", root + "/milestones?state=all&per_page=100"),
    labels: request("GET", root + "/labels?per_page=100"),
  };
}

function milestoneTitle(m) {
  return m[0] + " — " + m[1];
}

function parentBody(parent, tracker) {
  const id = parent[0];
  const steps = parent[4].map((s, i) =>
    String(i + 1) + ". **" + id + "." + String(i + 1) + "** — " + s
  ).join("\n");
  return marker(id) + "\n\n## Outcome\n\n" + parent[3] +
    "\n\n## Acceptance steps\n\n" + (steps || parent[3]) +
    "\n\n## Definition of done\n\nComplete or explicitly dismiss each native child, " +
    "record synthetic fixtures and local/CI test results, then squash-merge " +
    "one PR and close the parent issue. After M6, update OKF and log.md." +
    "\n\nTracking: #" + (tracker?.number ?? "<PLAN>") +
    ". Source: .github/plan/bootstrap.json.";
}

function childBody(id, text, parent) {
  return marker(id) + "\n\nParent: #" + (parent?.number ?? "<future>") +
    "\n\n## Deliverable and acceptance\n\n" + text +
    "\n\n## Completion evidence\n\nRecord the scoped commit and observed checks " +
    "on the parent issue before closing this task as completed.";
}

function trackerBody() {
  return marker("PLAN") +
    "\n\n# gh-plan v0.1 → v0.2\n\nThe authoritative Phase A plan is " +
    "[bootstrap.json](https://github.com/" + spec.repository +
    "/blob/main/.github/plan/bootstrap.json).\n\n" +
    "M1 correctness → M2 discovery → M3 planner → M4 issue metadata → " +
    "M5 packaging → M6 OKF docs → M7 extensions. " +
    "M8 is a deferred could-have, not authorized for Phase B.\n\n" +
    "Phase B requires explicit owner confirmation. Never delete unrelated issues.";
}

function plan(live, only = null) {
  const ops = [];
  const include = (stage) => only === null || stage === only;
  const add = (stage, name, method, path, body) => {
    if (include(stage)) ops.push({ stage, name, method, path, body });
  };
  const by = (id) => live.byMarker.get(id);
  const tracker = by("PLAN");
  const parents = new Map(spec.issues.map((x) =>
    [x[0], by(x[0]) || (x[7] ? live.byNumber.get(x[7]) : undefined)]
  ));
  const tasks = spec.issues.flatMap((x) =>
    x[4].map((description, i) => ({
      id: x[0] + "." + String(i + 1), parentId: x[0], description,
      milestone: Number(x[0][1]),
    }))
  );
  const all = new Map(parents);
  for (const task of tasks) all.set(task.id, by(task.id));

  if (include("labels") && !live.labels.some((label) => label.name === "could-have")) {
    add("labels", "label could-have", "POST", root + "/labels", {
      name: "could-have", color: "d4c5f9",
      description: "Optional unscheduled work not authorized for current execution phase",
    });
  }
  if (include("milestones")) for (const milestone of spec.milestones) {
    if (live.milestones.some((x) => x.title === milestoneTitle(milestone))) continue;
    add("milestones", milestone[0], "POST", root + "/milestones", {
      title: milestoneTitle(milestone), description: milestone[2], state: "open",
    });
  }
  if (include("tracker") && !tracker) {
    add("tracker", "PLAN", "POST", root + "/issues", {
      title: "Plan: gh-plan v0.1 → v0.2", body: trackerBody(), type: "Epic",
    });
  }

  if (include("parents")) for (const parent of spec.issues) {
    const id = parent[0];
    const existing = parents.get(id);
    const milestone = live.milestones.find((m) => m.title === milestoneTitle(
      spec.milestones.find((m) => m[0] === id.slice(0, 2))
    ));
    if (!existing) {
      add("parents", id, "POST", root + "/issues", {
        title: id + " — " + parent[1],
        body: parentBody(parent, tracker),
        type: parent[2],
        milestone: milestone?.number ?? Number(id[1]),
        ...(id === "M8.1" ? { labels: ["could-have"], assignees: [] } : {}),
      });
    } else if (parent[7] && !(existing.body ?? "").includes(marker(id))) {
      add("parents", id + " legacy adoption", "PATCH",
        root + "/issues/" + existing.number, {
          title: id + " — " + parent[1],
          body: marker(id) + "\n\nPhase A: legacy issue preserved.\n\n" + (existing.body ?? ""),
          milestone: milestone?.number ?? Number(id[1]),
          type: parent[2],
        });
    }
  }
  if (include("children")) for (const task of tasks) {
    if (by(task.id)) continue;
    add("children", task.id, "POST", root + "/issues", {
      title: task.id + " — " + task.description.slice(0, 115),
      body: childBody(task.id, task.description, parents.get(task.parentId)),
      type: "Task",
      milestone: task.milestone,
      ...(task.id.startsWith("M8.") ? { labels: ["could-have"], assignees: [] } : {}),
    });
  }
  if (include("parent-links")) for (const parent of spec.issues) {
    const issue = parents.get(parent[0]);
    const current = issue?.parent_issue_url?.match(/\/issues\/(\d+)$/)?.[1];
    if (current && tracker && Number(current) === tracker.number) continue;
    if (current && parent[0] !== "M3.0") {
      throw new Error(parent[0] + " has an unexpected parent; refusing to overwrite");
    }
    add("parent-links", parent[0], "POST",
      root + "/issues/" + (tracker?.number ?? "<PLAN>") + "/sub_issues", {
        sub_issue_id: issue?.id ?? "<" + parent[0] + ".id>",
        ...(current ? { replace_parent: true } : {}),
      });
  }
  if (include("child-links")) for (const task of tasks) {
    const child = by(task.id), parent = parents.get(task.parentId);
    const current = child?.parent_issue_url?.match(/\/issues\/(\d+)$/)?.[1];
    if (current && parent && Number(current) === parent.number) continue;
    if (current) throw new Error(task.id + " has an unexpected parent");
    add("child-links", task.id, "POST",
      root + "/issues/" + (parent?.number ?? "<" + task.parentId + ">") + "/sub_issues", {
        sub_issue_id: child?.id ?? "<" + task.id + ".id>",
      });
  }

  const pairs = [...new Set([
    ...spec.issues.flatMap((x) =>
      (x[5] ?? []).map((blocker) => x[0] + "|" + blocker)),
    ...spec.extras.blocking.map((x) => x.join("|")),
  ])].map((x) => x.split("|"));
  if (include("dependencies")) {
    const seen = new Map();
    for (const [blocked, blocker] of pairs) {
      const issue = parents.get(blocked), prerequisite = parents.get(blocker);
      if (issue && !seen.has(issue.number)) {
        seen.set(issue.number, request("GET",
          root + "/issues/" + issue.number + "/dependencies/blocked_by?per_page=100"));
      }
      if (issue && prerequisite && seen.get(issue.number).some((x) => x.id === prerequisite.id)) {
        continue;
      }
      add("dependencies", blocked + " <- " + blocker, "POST",
        root + "/issues/" + (issue?.number ?? "<" + blocked + ">") +
        "/dependencies/blocked_by", {
          issue_id: prerequisite?.id ?? "<" + blocker + ".id>",
        });
    }
  }
  if (include("relations")) for (const [left, right] of spec.extras.relates) {
    const first = parents.get(left), second = parents.get(right);
    if (first && second && request("GET",
      root + "/issues/" + first.number + "/relates_to?per_page=100"
    ).some((x) => x.id === second.id)) continue;
    add("relations", left + " <-> " + right, "POST",
      root + "/issues/" + (first?.number ?? "<" + left + ">") + "/relates_to", {
        issue_id: second?.id ?? "<" + right + ".id>",
      });
  }
  if (include("pin")) {
    let pinned = false;
    if (tracker) pinned = graphql(
      "query($id:ID!){node(id:$id){... on Issue{isPinned}}}",
      { id: tracker.node_id }
    ).node?.isPinned === true;
    if (!pinned) add("pin", "pin PLAN", "GRAPHQL", "pinIssue", {
      issueId: tracker?.node_id ?? "<PLAN.nodeId>",
    });
  }
  return ops;
}

function show(actions) {
  for (const action of actions) {
    process.stdout.write(action.method + " " + action.path + " " +
      action.name + " " + JSON.stringify(action.body) + "\n");
  }
  process.stdout.write("Mutations required: " + actions.length + "\n");
}

const preview = plan(snapshot());
show(preview);
if (!apply) process.exit(0);

for (const stage of stages) {
  const actions = plan(snapshot(), stage);
  for (const action of actions) {
    if (action.method === "GRAPHQL") {
      graphql("mutation($id:ID!){pinIssue(input:{issueId:$id}){issue{isPinned}}}",
        { id: action.body.issueId });
    } else {
      request(action.method, action.path, action.body);
    }
    process.stdout.write("Applied " + action.stage + " " + action.name + "\n");
  }
}

const remaining = plan(snapshot());
if (remaining.length) {
  process.stderr.write("Bootstrap incomplete; rerun --apply after resolving the blocker.\n");
  show(remaining);
  process.exitCode = 1;
} else {
  process.stdout.write("Verification: zero remaining mutations; idempotent.\n");
}
