import { compileIssueLabelSteps } from "./issue-label-compiler.ts";
import { compileIssueAssigneeSteps } from "./issue-assignee-compiler.ts";
import type {
  DesiredPullRequestResource, GithubDiagnostic, GithubDiffResult, GithubStateSnapshot,
  JsonValue, NormalizedDesiredStateGraph, ObservedIssue, ObservedPullRequest,
  PlanJsonValue, PlanPath, PlanStep, PlanStringTemplate, PlanValueRef,
  ResourceResolution,
} from "./types.ts";

/** Deterministic, pure PR steps and resolution decisions; never calls the network. */
export interface PullRequestCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  blockers: GithubDiagnostic[];
  unsupported: GithubDiagnostic[];
  resolutions: ResourceResolution[];
}

const CLOSE_BEGIN = "<!-- gh-plan:closes:begin -->";
const CLOSE_END = "<!-- gh-plan:closes:end -->";
const fold = (value: string): string => value.toLowerCase();
function diagnostic(id: string, code: GithubDiagnostic["code"], message: string): GithubDiagnostic {
  return { code, severity: "error", blocking: true, logicalId: id,
    schemaPath: "pullRequests." + id, message };
}
function step(id: string, kind: PlanStep["kind"], current: JsonValue | null,
  target: JsonValue | null, reason: string, request?: PlanStep["request"],
  dependencies: string[] = [], reversible: boolean | "partial" = true): PlanStep {
  return {
    id: kind + ":" + id, kind, logicalId: id, status: request ? "planned" : "noop",
    current, desired: target, reason, dependsOn: [...new Set(dependencies)].sort(),
    ...(request ? { request } : {}),
    preconditions: ["Discovered PR identities, branch refs and review requests remain current"],
    expectedPostconditions: request ? ["Specified PR properties have been reconciled"] : [],
    destructive: false, reversible,
  };
}
function ref(id: string, prop: "number" | "id" = "number"): PlanValueRef {
  return { $ref: (id + "." + prop) as PlanValueRef["$ref"] };
}
function planPath(repo: string, id: string, number?: number): PlanPath {
  const prefix = "/repos/" + repo.split("/").map(encodeURIComponent).join("/") + "/pulls/";
  return number === undefined ? [prefix, ref(id)] : prefix + number;
}
function cleanBlock(body: string): string | undefined {
  const start = body.indexOf(CLOSE_BEGIN), end = body.indexOf(CLOSE_END);
  if ((start < 0) !== (end < 0)) return undefined;
  if (start < 0) return body;
  if (end < start || body.indexOf(CLOSE_BEGIN, start + 1) >= 0 ||
      body.indexOf(CLOSE_END, end + 1) >= 0) return undefined;
  return (body.slice(0, start).trimEnd() + body.slice(end + CLOSE_END.length)).trim();
}

type TextBody = { rendered: PlanJsonValue; preview: string; dependencies: string[] };
function managedBody(
  initial: string, refs: string[] | undefined,
  resolutions: Map<string, ResourceResolution>,
): TextBody | undefined {
  if (refs === undefined) return { rendered: initial, preview: initial, dependencies: [] };
  const human = cleanBlock(initial);
  if (human === undefined) return undefined;
  const prefix = (human ? human + "\n\n" : "") + CLOSE_BEGIN + "\n";
  const parts: Array<string | PlanValueRef> = [prefix];
  const dependencies: string[] = [], previews: string[] = [];
  for (const id of refs) {
    const resolution = resolutions.get(id);
    if (!resolution || resolution.kind !== "issue" ||
        (resolution.status !== "new" && resolution.status !== "existing")) return undefined;
    if (resolution.status === "new") {
      parts.push("Closes #", ref(id), "\n");
      dependencies.push("issue.create:" + id);
      previews.push("Closes #<" + id + ".number>");
    } else {
      if (resolution.identity?.number === undefined) return undefined;
      parts.push("Closes #" + resolution.identity.number + "\n");
      previews.push("Closes #" + resolution.identity.number);
    }
  }
  parts.push(CLOSE_END);
  return {
    rendered: parts.some((x) => typeof x !== "string") ?
      { $template: parts } satisfies PlanStringTemplate : parts.join(""),
    preview: prefix + (previews.length ? previews.join("\n") + "\n" : "") + CLOSE_END,
    dependencies,
  };
}
function canonicalState(operation: { op: "set"; value: "open" | "closed" } | undefined,
  current: "open" | "closed"): "open" | "closed" {
  return operation?.value ?? current;
}
function identMatches(pr: DesiredPullRequestResource, current: ObservedPullRequest): boolean {
  const h = pr.identity;
  return (!h || (h.number === undefined || h.number === current.number) &&
    (h.id === undefined || h.id === current.id) &&
    (h.nodeId === undefined || h.nodeId === current.nodeId));
}

/**
 * Pure PR compiler. PR identities use a unique open head/base pair, except
 * explicit number identity permits a base change. Branch comparison is performed
 * upstream by read-only discovery. Existing PRs are never merged; REST permits
 * draft on create but not draft toggles after creation. M4 issue-label and
 * assignee compilers are reused against a strictly scoped synthetic issue view.
 */
export function compilePullRequestSteps(
  desired: NormalizedDesiredStateGraph,
  observed: GithubStateSnapshot,
  issueResolutions: ResourceResolution[],
): PullRequestCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [], blockers: GithubDiagnostic[] = [];
  const unsupported: GithubDiagnostic[] = [], resolutions: ResourceResolution[] = [];
  const issues = new Map(issueResolutions.map((x) => [x.logicalId, x]));
  const repo = desired.repository.fullName;
  const all = [...(desired.pullRequests ?? [])].sort((a, b) =>
    a.logicalId.localeCompare(b.logicalId));

  for (const pr of all) {
    const id = pr.logicalId, desiredState = pr.desired;
    const observedPulls = observed.pullRequests ?? [];
    const matches = observedPulls.filter((candidate) =>
      pr.identity?.number !== undefined ? candidate.number === pr.identity.number :
      candidate.state === "open" && candidate.head === pr.head && candidate.base === pr.base);
    if (matches.length > 1) {
      blockers.push(diagnostic(id, "PR_PAIR_CONFLICT", "Multiple PRs matched the requested open head/base pair."));
      resolutions.push({ logicalId: id, kind: "pull_request", status: "ambiguous",
        candidates: matches.map((x) => ({ number: x.number, id: x.id })) });
      continue;
    }
    const current = matches[0];
    if (current && (!identMatches(pr, current) || current.head !== pr.head)) {
      blockers.push(diagnostic(id, "PR_PAIR_CONFLICT", "Explicit PR identity or head ref does not match the discovered PR."));
      resolutions.push({ logicalId: id, kind: "pull_request", status: "ambiguous" });
      continue;
    }
    if (pr.identity?.number !== undefined && !current) {
      blockers.push(diagnostic(id, "UNRESOLVED_IDENTITY", "Explicit PR number not found among repository PRs."));
      resolutions.push({ logicalId: id, kind: "pull_request", status: "unresolved" });
      continue;
    }
    if (current?.merged) {
      blockers.push(diagnostic(id, "PR_MERGED", "Merged PR cannot be reopened or mutated; merging is not planned."));
      resolutions.push({ logicalId: id, kind: "pull_request", status: "unresolved" });
      continue;
    }
    const isNew = !current;
    resolutions.push({
      logicalId: id, kind: "pull_request", status: isNew ? "new" : "existing",
      ...(current ? { identity: { number: current.number, id: current.id,
        ...(current.nodeId === undefined ? {} : { nodeId: current.nodeId }) } } : {}),
    });
    if (isNew) {
      const check = observed.pullRequestBranchChecks?.[id];
      if (!check || !check.headExists || !check.baseExists || !check.differs ||
          pr.head === pr.base) {
        blockers.push(diagnostic(id, "PR_BRANCH_INVALID",
          "Cannot create PR: head/base refs must both exist and head must have commits ahead of base."));
        continue;
      }
      if (!desiredState.title?.value?.trim()) {
        blockers.push(diagnostic(id, "INVALID_SCHEMA", "Creating a PR requires a nonempty title."));
        continue;
      }
    }
    if (!isNew && desiredState.draft !== undefined &&
        desiredState.draft.value !== current.draft) {
      const d = diagnostic(id, "PR_DRAFT_UNSUPPORTED",
        "REST cannot toggle draft status on an existing PR; GraphQL is required.");
      blockers.push(d); unsupported.push(d);
      continue;
    }
    const originalBody = desiredState.body?.op === "set" ? desiredState.body.value :
      desiredState.body?.op === "remove" ? "" : current?.body ?? "";
    const body = managedBody(originalBody, desiredState.closes?.map((x) => x.logicalId), issues);
    if (!body) {
      blockers.push(diagnostic(id, "UNRESOLVED_REFERENCE",
        "PR Closes block is malformed or a logical issue reference is not safely resolved."));
      continue;
    }
    const bodyControlled = desiredState.body !== undefined || desiredState.closes !== undefined;
    const prefix = planPath(repo, id, current?.number);
    const producers = isNew ? ["pull_request.create:" + id] : [];
    if (isNew) {
      const data: Record<string, PlanJsonValue> = {
        head: pr.head, base: pr.base, title: desiredState.title!.value,
        ...(bodyControlled ? { body: body.rendered } : {}),
        ...(desiredState.draft === undefined ? {} : { draft: desiredState.draft.value }),
      };
      steps.push(step(id, "pull_request.create", null, data as JsonValue,
        "Create open PR with verified branch refs and managed closure metadata.",
        { protocol: "rest", method: "POST",
          path: "/repos/" + repo.split("/").map(encodeURIComponent).join("/") + "/pulls",
          body: data }, body.dependencies, "partial"));
      if (desiredState.state?.value === "closed") {
        steps.push(step(id, "pull_request.update", "open", "closed",
          "Close new PR after creation; do not merge.",
          { protocol: "rest", method: "PATCH", path: planPath(repo, id), body: { state: "closed" } },
          producers));
      }
    } else {
      const changed: Record<string, PlanJsonValue> = {};
      const currentValues: Record<string, JsonValue> = {}, newValues: Record<string, JsonValue> = {};
      const set = (key: string, old: JsonValue, next: JsonValue, request: PlanJsonValue): void => {
        if (JSON.stringify(old) === JSON.stringify(next)) return;
        changed[key] = request; currentValues[key] = old; newValues[key] = next;
      };
      if (desiredState.title) set("title", current.title, desiredState.title.value, desiredState.title.value);
      if (pr.base !== current.base) {
        if (pr.identity?.number === undefined) {
          blockers.push(diagnostic(id, "PR_PAIR_CONFLICT",
            "Updating an existing PR base requires explicit identity.number."));
          continue;
        }
        set("base", current.base, pr.base, pr.base);
      }
      if (bodyControlled) set("body", current.body ?? "", body.preview, body.rendered);
      if (desiredState.state) set("state", current.state,
        canonicalState(desiredState.state, current.state), desiredState.state.value);
      if (Object.keys(changed).length) {
        steps.push(step(id, "pull_request.update", currentValues, newValues,
          "PATCH only explicitly changed PR title, body, base or state.",
          { protocol: "rest", method: "PATCH", path: prefix, body: changed }, body.dependencies));
      } else noops.push(step(id, "pull_request.update", null, null,
        "Existing PR core state already matches all managed properties."));
    }
    // Reuse the existing M4 compilers for PR issue labels/assignees. PRs are
    // ordinary issues for these *endpoints*, but never for issue core/field writes.
    if (desiredState.labels || desiredState.assignees) {
      const fake = {
        logicalId: id, kind: "issue" as const, management: "managed" as const,
        desired: {
          ...(desiredState.labels ? { labels: desiredState.labels } : {}),
          ...(desiredState.assignees ? { assignees: desiredState.assignees } : {}),
        },
      };
      const currentIssue: ObservedIssue | undefined = current ? {
        kind: "issue", number: current.number, id: current.id,
        ...(current.nodeId === undefined ? {} : { nodeId: current.nodeId }),
        title: current.title, state: current.state,
        labels: current.labels, assignees: current.assignees,
      } : undefined;
      const snapshot: GithubStateSnapshot = {
        ...observed, issues: currentIssue ? [currentIssue] : [],
      };
      const resolution: ResourceResolution = {
        logicalId: id, kind: "issue", status: isNew ? "new" : "existing",
        ...(current ? { identity: { number: current.number, id: current.id,
          ...(current.nodeId === undefined ? {} : { nodeId: current.nodeId }) } } : {}),
      };
      const diffs: GithubDiffResult = { diffs: [
        ...(isNew ? [{ id: "issue.create:" + id, logicalId: id, kind: "issue",
          status: "create" as const, reason: "New PR issue endpoint." }] : []),
        ...(!isNew && desiredState.labels ? [{ id: "issue.labels:" + id, logicalId: id,
          kind: "issue", status: "update" as const, reason: "Managed PR labels." }] : []),
        ...(!isNew && desiredState.assignees ? [{ id: "issue.assignees:" + id, logicalId: id,
          kind: "issue", status: "update" as const, reason: "Managed PR assignees." }] : []),
      ], blockers: [], warnings: [], unsupported: [] };
      const graph: NormalizedDesiredStateGraph = {
        ...desired, resources: [fake], relationships: [],
      };
      const results = [
        ...(desiredState.labels ? [compileIssueLabelSteps(graph, diffs, snapshot, [resolution])] : []),
        ...(desiredState.assignees ? [compileIssueAssigneeSteps(graph, diffs, snapshot, [resolution])] : []),
      ];
      for (const result of results) {
        blockers.push(...result.blockers);
        noops.push(...result.noops);
        for (const item of result.steps) {
          steps.push({ ...item, dependsOn: item.dependsOn.map((dep) =>
            dep === "issue.create:" + id ? "pull_request.create:" + id : dep) });
        }
      }
    }
    if (desiredState.reviewers) {
      const operation = desiredState.reviewers;
      const previous = new Map((current?.requestedReviewers ?? []).map((x) => [fold(x), x]));
      const target = operation.op === "set"
        ? new Map(operation.value.map((x) => [fold(x), x])) : new Map(previous);
      if (operation.op === "modify") {
        for (const x of operation.remove) target.delete(fold(x));
        for (const x of operation.add) target.set(fold(x), x);
      }
      const removed = [...previous].filter(([x]) => !target.has(x)).map(([, x]) => x).sort();
      const added = [...target].filter(([x]) => !previous.has(x)).map(([, x]) => x).sort();
      const path: PlanPath = isNew ?
        [...(prefix as Array<string | PlanValueRef>), "/requested_reviewers"] :
        (prefix as string) + "/requested_reviewers";
      if (removed.length) steps.push(step(id, "pull_request.reviewer.remove",
        [...previous.values()], [...target.values()], "Remove only managed review requests.",
        { protocol: "rest", method: "DELETE", path, body: { reviewers: removed } }, producers));
      if (added.length) steps.push(step(id, "pull_request.reviewer.add",
        [...previous.values()], [...target.values()], "Request review from named GitHub logins.",
        { protocol: "rest", method: "POST", path, body: { reviewers: added } },
        [...producers, ...(removed.length ? ["pull_request.reviewer.remove:" + id] : [])]));
      if (!removed.length && !added.length) noops.push(step(id,
        "pull_request.reviewer.add", null, null, "Reviewer requests already match."));
    }
    if (!isNew && desiredState.draft !== undefined && desiredState.draft.value === current.draft) {
      noops.push(step(id, "pull_request.update", current.draft, current.draft,
        "PR draft status already matches; no transition needed."));
    }
  }
  steps.sort((a, b) => a.id.localeCompare(b.id));
  noops.sort((a, b) => a.id.localeCompare(b.id));
  blockers.sort((a, b) => (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    a.code.localeCompare(b.code));
  return { steps, noops, blockers, unsupported, resolutions };
}
