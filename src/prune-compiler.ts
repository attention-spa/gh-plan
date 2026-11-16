import type {
  GithubDiagnostic, GithubPlannerMode, GithubStateSnapshot, NormalizedDesiredStateGraph,
  ObservedIssue, PlanStep, ResourceResolution,
} from "./types.ts";

/** Pure orphan and duplicate detection and conditional mutation proposals. */
export interface PruneCompilationResult {
  steps: PlanStep[];
  noops: PlanStep[];
  warnings: GithubDiagnostic[];
  blockers: GithubDiagnostic[];
  unsupported: GithubDiagnostic[];
}

const MARKER = /^<!-- gh-plan:([A-Za-z0-9][A-Za-z0-9._:/-]*) -->$/gm;
const markerIds = (body: string | null | undefined): string[] =>
  typeof body === "string" ? [...body.matchAll(MARKER)].map((m) => m[1]!) : [];

function diagnostic(
  code: GithubDiagnostic["code"], message: string, logicalId: string,
  blocking = false, details?: GithubDiagnostic["details"],
): GithubDiagnostic {
  return { code, message, logicalId, blocking,
    severity: blocking ? "error" : "info", schemaPath: "$.prune",
    ...(details === undefined ? {} : { details }) };
}
function step(
  kind: PlanStep["kind"], logicalId: string, suffix: string,
  current: PlanStep["current"], desired: PlanStep["desired"],
  reason: string, request: PlanStep["request"], dependsOn: string[],
  destructive = false, reversible: PlanStep["reversible"] = true,
): PlanStep {
  return {
    id: kind + ":" + suffix, kind, logicalId, status: "planned",
    current, desired, reason, dependsOn: [...new Set(dependsOn)].sort(), request,
    preconditions: ["Issue identity, marker provenance and canonical selection remain unchanged"],
    expectedPostconditions: ["The opt-in issue lifecycle action has been recorded"],
    destructive, reversible,
  };
}
const sortDiagnostics = (items: GithubDiagnostic[]): GithubDiagnostic[] =>
  items.sort((a, b) => (a.logicalId ?? "").localeCompare(b.logicalId ?? "") ||
    a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
const normalizeTitle = (value: string): string => value.trim().toLowerCase();

/**
 * The normal path is report-only and never invents ownership. Only an entire
 * canonical marker comment on its own line counts, never title similarity.
 * Close is reversible and explicit. Permanent GraphQL deleteIssue is produced
 * only in the pure GraphQL compilation path with both opt-ins and a known nodeId.
 * The full planGithub() entrypoint still intentionally blocks GraphQL mode.
 */
export function compilePruneSteps(
  desired: NormalizedDesiredStateGraph, observed: GithubStateSnapshot,
  resolutions: ResourceResolution[], mode: GithubPlannerMode = "rest",
): PruneCompilationResult {
  const steps: PlanStep[] = [], noops: PlanStep[] = [];
  const warnings: GithubDiagnostic[] = [], blockers: GithubDiagnostic[] = [];
  const unsupported: GithubDiagnostic[] = [];
  const policy = desired.prune ?? "report", deleteDuplicates = desired.deleteDuplicates === true;
  const issues = [...observed.issues].sort((a, b) => a.number - b.number);
  const groups = new Map<string, ObservedIssue[]>();
  const desiredIssues = desired.resources.filter((r) => r.kind === "issue");
  const authored = new Map(desiredIssues.map((r) => [r.logicalId, r]));
  const resolved = new Map(resolutions.filter((r) => r.kind === "issue")
    .map((r) => [r.logicalId, r]));
  const protectedNumbers = new Set<number>();
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  for (const r of desiredIssues) {
    if (r.identity?.number !== undefined) protectedNumbers.add(r.identity.number);
    for (const issue of issues) {
      if ((r.identity?.id !== undefined && issue.id === r.identity.id) ||
          (r.identity?.nodeId !== undefined && issue.nodeId === r.identity.nodeId))
        protectedNumbers.add(issue.number);
    }
    const res = resolved.get(r.logicalId);
    if (res?.status === "existing" && res.identity?.number !== undefined)
      protectedNumbers.add(res.identity.number);
  }

  for (const issue of issues) {
    const ids = markerIds(issue.body);
    if (ids.length > 1) {
      warnings.push(diagnostic("DUPLICATE_ISSUE_MARKER",
        "Issue #" + issue.number + " has multiple markers; cannot safely prune.",
        ids[0] ?? "unknown", false, { number: issue.number, markers: ids }));
    } else if (ids.length === 1) {
      const list = groups.get(ids[0]!) ?? [];
      list.push(issue); groups.set(ids[0]!, list);
    }
  }
  const repoPath = "/repos/" + desired.repository.fullName.split("/").map(encodeURIComponent).join("/");
  const issueUrl = (number: number): string => "https://github.com/" +
    desired.repository.fullName.split("/").map(encodeURIComponent).join("/") + "/issues/" + number;

  for (const [logicalId, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const r = authored.get(logicalId);
    if (!r) {
      for (const issue of group) warnings.push(diagnostic("ORPHAN_ISSUE",
        "Marked issue #" + issue.number + " is absent from authored issue resources.",
        logicalId, false, { number: issue.number }));
      if (policy !== "close") continue;
      if (group.length !== 1) {
        blockers.push(diagnostic("DUPLICATE_ISSUE_MARKER",
          "Orphan marker has multiple owners; closing is unsafe.",
          logicalId, true, { numbers: group.map((x) => x.number) }));
        continue;
      }
      const issue = group[0]!;
      if (protectedNumbers.has(issue.number)) {
        blockers.push(diagnostic("AMBIGUOUS_IDENTITY",
          "Orphan #" + issue.number + " has an independently authored identity.",
          logicalId, true, { number: issue.number }));
        continue;
      }
      if (issue.state === "open") steps.push(step("issue.orphan.close", logicalId,
        logicalId + ":" + issue.number, "open", "closed",
        "Uniquely marked orphan: explicit reversible close, not deletion.",
        { protocol: "rest", method: "PATCH",
          path: repoPath + "/issues/" + issue.number,
          body: { state: "closed", state_reason: "not_planned" } }, []));
      continue;
    }
    if (group.length < 2) continue;
    warnings.push(diagnostic("DUPLICATE_ISSUE_MARKER",
      "Multiple issues carry the same canonical gh-plan marker.",
      logicalId, false, { numbers: group.map((x) => x.number) }));
    if (policy !== "close") continue;
    const res = resolved.get(logicalId);
    const hint = r.identity;
    const explicit = hint?.number !== undefined || hint?.id !== undefined ||
      hint?.nodeId !== undefined;
    const canonical = res?.status === "existing" && res.identity?.number !== undefined
      ? byNumber.get(res.identity.number) : undefined;
    if (r.management !== "managed" || !explicit || !canonical ||
      !group.some((x) => x.number === canonical.number) ||
      canonical.id === undefined) {
      blockers.push(diagnostic("AMBIGUOUS_IDENTITY",
        "A duplicate may be closed only against an explicitly identified managed canonical issue.",
        logicalId, true, { numbers: group.map((x) => x.number) }));
      continue;
    }
    const duplicateIssues = group.filter((x) => x.number !== canonical.number);
    if (deleteDuplicates && mode === "rest") {
      const failure = diagnostic("DUPLICATE_DELETION_UNSUPPORTED",
        "Permanent deletion is unavailable through REST; GraphQL deleteIssue requires explicit opt-in.",
        logicalId, true, { canonical: canonical.number,
          numbers: duplicateIssues.map((x) => x.number) });
      blockers.push(failure); unsupported.push(failure);
      continue;
    }
    for (const issue of duplicateIssues) {
      if (protectedNumbers.has(issue.number)) {
        blockers.push(diagnostic("AMBIGUOUS_IDENTITY",
          "Duplicate #" + issue.number + " is independently declared; it is protected.",
          logicalId, true, { number: issue.number }));
        continue;
      }
      const suffix = logicalId + ":" + issue.number;
      const explanation = "Issue #" + issue.number + " duplicates canonical [" +
        "#" + canonical.number + "](" + issueUrl(canonical.number) +
        "); shared verified gh-plan marker " + logicalId + ".";
      if (deleteDuplicates) {
        if (!issue.nodeId) {
          blockers.push(diagnostic("UNRESOLVED_IDENTITY",
            "Deleting a duplicate requires its observed GraphQL node ID.",
            logicalId, true, { number: issue.number }));
          continue;
        }
        const note = step("issue.duplicate.comment", logicalId, suffix,
          null, explanation,
          "Record deletion justification on the surviving canonical issue.",
          { protocol: "rest", method: "POST",
            path: repoPath + "/issues/" + canonical.number + "/comments",
            body: { body: explanation + " Pending irreversible duplicate deletion." } },
          [], false, "partial");
        steps.push(note);
        steps.push(step("issue.duplicate.delete", logicalId, suffix,
          { number: issue.number, nodeId: issue.nodeId }, null,
          "Irreversible deletion of a marked and explicitly canonicalized duplicate.",
          { protocol: "graphql", operationName: "DeleteDuplicateIssue",
            document: "mutation DeleteDuplicateIssue($issueId: ID!) { deleteIssue(input: {issueId: $issueId}) { repository { id } } }",
            variables: { issueId: issue.nodeId } },
          [note.id], true, false));
      } else if (issue.state === "open") {
        const note = step("issue.duplicate.comment", logicalId, suffix,
          null, explanation,
          "Record the canonical link and duplicate reason before closing.",
          { protocol: "rest", method: "POST",
            path: repoPath + "/issues/" + issue.number + "/comments",
            body: { body: explanation } }, [], false, "partial");
        steps.push(note);
        steps.push(step("issue.duplicate.close", logicalId, suffix,
          "open", "closed", "Reversible duplicate closure with canonical link.",
          { protocol: "rest", method: "PATCH",
            path: repoPath + "/issues/" + issue.number,
            body: { state: "closed", state_reason: "duplicate",
              duplicate_issue_id: canonical.id } }, [note.id]));
      }
    }
  }

  const wantedTitles = new Set(desiredIssues.flatMap((r) =>
    r.kind === "issue" && r.management === "managed" && r.desired.title?.op === "set"
      ? [normalizeTitle(r.desired.title.value)] : []));
  for (const title of [...wantedTitles].sort()) {
    const matches = issues.filter((issue) => normalizeTitle(issue.title) === title);
    if (matches.length > 1) warnings.push(diagnostic("DUPLICATE_ISSUE_TITLE",
      "Title collision reported only: title alone is never proof of managed ownership.",
      title, false, { title, numbers: matches.map((issue) => issue.number) }));
  }
  steps.sort((a, b) => a.id.localeCompare(b.id));
  return { steps, noops, warnings: sortDiagnostics(warnings),
    blockers: sortDiagnostics(blockers), unsupported: sortDiagnostics(unsupported) };
}
