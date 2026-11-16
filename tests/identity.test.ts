import {
  resolveResourceIdentities,
  type GithubStateSnapshot,
  type NormalizedDesiredStateGraph,
  type ResourceResolution,
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

function graph(resources: NormalizedDesiredStateGraph["resources"]): NormalizedDesiredStateGraph {
  return {
    repository: { fullName: "acme/widgets", id: 100 },
    resources,
    relationships: [],
  };
}

function snapshot(overrides: Partial<GithubStateSnapshot> = {}): GithubStateSnapshot {
  return {
    repository: { fullName: "acme/widgets", id: 100, nodeId: "R_100" },
    issues: [
      {
        kind: "issue",
        number: 1,
        id: 101,
        nodeId: "I_101",
        title: "Alpha",
        body: "<!-- gh-plan:alpha -->\nAlpha body",
        state: "open",
      },
      {
        kind: "issue",
        number: 2,
        id: 102,
        nodeId: "I_102",
        title: "Beta",
        body: "<!-- custom:beta -->\nBeta body",
        state: "open",
      },
    ],
    milestones: [
      {
        kind: "milestone",
        number: 7,
        id: 707,
        nodeId: "M_707",
        title: "Foundation",
        state: "open",
      },
    ],
    issueTypes: [],
    issueFields: [],
    ...overrides,
  };
}

function resolution(result: ReturnType<typeof resolveResourceIdentities>, logicalId: string): ResourceResolution {
  const found = result.resolutions.find((item) => item.logicalId === logicalId);
  assert(found, `missing resolution for ${logicalId}`);
  return found;
}

function managedIssue(
  logicalId: string,
  title: string,
  identity?: { id?: number; nodeId?: string; number?: number; marker?: string },
): NormalizedDesiredStateGraph["resources"][number] {
  return {
    logicalId,
    kind: "issue",
    management: "managed",
    ...(identity ? { identity } : {}),
    desired: { title: { op: "set", value: title } },
  };
}

function referencedIssue(
  logicalId: string,
  identity?: { id?: number; nodeId?: string; number?: number; marker?: string },
): NormalizedDesiredStateGraph["resources"][number] {
  return {
    logicalId,
    kind: "issue",
    management: "reference",
    ...(identity ? { identity } : {}),
  };
}

function managedMilestone(
  logicalId: string,
  title: string,
  identity?: { id?: number; nodeId?: string; number?: number; marker?: string },
): NormalizedDesiredStateGraph["resources"][number] {
  return {
    logicalId,
    kind: "milestone",
    management: "managed",
    ...(identity ? { identity } : {}),
    desired: { title: { op: "set", value: title } },
  };
}

// Explicit IDs/numbers and agreeing hints.
for (const [logicalId, identity] of [
  ["by-rest-id", { id: 101 }],
  ["by-node-id", { nodeId: "I_101" }],
  ["by-number", { number: 1 }],
  ["all-hints", { id: 101, nodeId: "I_101", number: 1 }],
] as const) {
  const result = resolveResourceIdentities(graph([managedIssue(logicalId, "Alpha", identity)]), snapshot());
  const item = resolution(result, logicalId);
  equal(item.status, "existing", `${logicalId} should resolve existing`);
  equal(item.identity?.number, 1, `${logicalId} issue number`);
  equal(item.identity?.id, 101, `${logicalId} REST id`);
  equal(item.identity?.nodeId, "I_101", `${logicalId} node id`);
  equal(result.blockers, [], `${logicalId} should not block`);
}

const milestoneByNumber = resolveResourceIdentities(
  graph([managedMilestone("foundation", "Foundation", { number: 7 })]),
  snapshot(),
);
equal(resolution(milestoneByNumber, "foundation").status, "existing", "milestone number should resolve");

// Conflicting explicit hints block.
const conflict = resolveResourceIdentities(
  graph([managedIssue("conflict", "Alpha", { id: 101, number: 2 })]),
  snapshot(),
);
equal(resolution(conflict, "conflict").status, "ambiguous", "conflicting hints should be ambiguous");
assert(conflict.blockers.some((item) => item.code === "AMBIGUOUS_IDENTITY"), "conflicting hints should emit blocker");

// Missing explicit immutable identity must not fall through to title.
const missingExplicit = resolveResourceIdentities(
  graph([managedIssue("missing-explicit", "Alpha", { id: 999 })]),
  snapshot(),
);
equal(resolution(missingExplicit, "missing-explicit").status, "unresolved", "missing explicit id should remain unresolved");
assert(missingExplicit.blockers.length === 1, "missing explicit id should block");

// Canonical marker recovers identity despite title edits.
const markerSnapshot = snapshot({
  issues: [{
    kind: "issue",
    number: 10,
    id: 110,
    nodeId: "I_110",
    title: "Human changed this title",
    body: "notes\n<!-- gh-plan:marker-case -->\nmore notes",
    state: "open",
  }],
});
const markerResult = resolveResourceIdentities(
  graph([managedIssue("marker-case", "Original desired title")]),
  markerSnapshot,
);
equal(resolution(markerResult, "marker-case").status, "existing", "canonical marker should survive title edit");
equal(resolution(markerResult, "marker-case").identity?.marker, "<!-- gh-plan:marker-case -->", "effective marker should be preserved");

// Explicit custom marker outranks canonical marker/title.
const customResult = resolveResourceIdentities(
  graph([managedIssue("custom-case", "Something else", { marker: "<!-- custom:beta -->" })]),
  snapshot(),
);
equal(resolution(customResult, "custom-case").identity?.number, 2, "custom marker should identify beta");

// Duplicate markers are ambiguous with deterministic candidates.
const duplicateMarkerSnapshot = snapshot({
  issues: [
    { kind: "issue", number: 4, id: 104, title: "A", body: "<!-- gh-plan:dupe -->", state: "open" },
    { kind: "issue", number: 3, id: 103, title: "B", body: "<!-- gh-plan:dupe -->", state: "open" },
  ],
});
const duplicateMarker = resolveResourceIdentities(graph([managedIssue("dupe", "No title match")]), duplicateMarkerSnapshot);
equal(resolution(duplicateMarker, "dupe").status, "ambiguous", "duplicate marker should be ambiguous");
equal(resolution(duplicateMarker, "dupe").candidates?.map((item) => item.number), [3, 4], "candidates should be ordered by number");

// Marker conflicting with an explicit number blocks rather than overriding it.
const markerConflictSnapshot = snapshot({
  issues: [
    { kind: "issue", number: 1, id: 101, title: "Explicit", body: null, state: "open" },
    { kind: "issue", number: 2, id: 102, title: "Marker", body: "<!-- gh-plan:marker-conflict -->", state: "open" },
  ],
});
const markerConflict = resolveResourceIdentities(
  graph([managedIssue("marker-conflict", "Explicit", { number: 1 })]),
  markerConflictSnapshot,
);
equal(resolution(markerConflict, "marker-conflict").status, "ambiguous", "marker/number conflict should block");

// Unique exact title bootstrap, and duplicate exact title ambiguity.
const titleBootstrap = resolveResourceIdentities(graph([managedIssue("title-only", "Alpha")]), snapshot());
equal(resolution(titleBootstrap, "title-only").identity?.number, 1, "unique exact issue title should bootstrap identity");

const duplicateTitle = resolveResourceIdentities(
  graph([managedIssue("duplicate-title", "Same")]),
  snapshot({
    issues: [
      { kind: "issue", number: 8, id: 108, title: "Same", state: "open" },
      { kind: "issue", number: 9, id: 109, title: "Same", state: "closed" },
    ],
  }),
);
equal(resolution(duplicateTitle, "duplicate-title").status, "ambiguous", "duplicate exact issue titles should be ambiguous");

const milestoneTitle = resolveResourceIdentities(graph([managedMilestone("milestone-title", "Foundation")]), snapshot());
equal(resolution(milestoneTitle, "milestone-title").identity?.number, 7, "unique milestone title should bootstrap identity");

const duplicateMilestoneTitle = resolveResourceIdentities(
  graph([managedMilestone("milestone-dupe", "Same milestone")]),
  snapshot({
    milestones: [
      { kind: "milestone", number: 2, id: 702, title: "Same milestone", state: "open" },
      { kind: "milestone", number: 1, id: 701, title: "Same milestone", state: "closed" },
    ],
  }),
);
equal(resolution(duplicateMilestoneTitle, "milestone-dupe").status, "ambiguous", "duplicate milestone titles should be ambiguous");

// Managed resources become new; issues retain future marker, milestones fabricate no GitHub identity.
const newResult = resolveResourceIdentities(
  graph([
    managedIssue("new-issue", "Brand new"),
    managedMilestone("new-milestone", "Brand new milestone"),
  ]),
  snapshot(),
);
equal(resolution(newResult, "new-issue"), {
  logicalId: "new-issue",
  kind: "issue",
  status: "new",
  identity: { marker: "<!-- gh-plan:new-issue -->" },
}, "new issue should carry future marker only");
equal(resolution(newResult, "new-milestone"), {
  logicalId: "new-milestone",
  kind: "milestone",
  status: "new",
}, "new milestone should not fabricate identity");

// Reference-only resources never become creates.
const unresolvedRefs = resolveResourceIdentities(
  graph([
    referencedIssue("missing-reference", { number: 99 }),
    { logicalId: "bare-milestone-ref", kind: "milestone", management: "reference" },
  ]),
  snapshot(),
);
equal(resolution(unresolvedRefs, "missing-reference").status, "unresolved", "missing reference should be unresolved");
equal(resolution(unresolvedRefs, "bare-milestone-ref").status, "unresolved", "bare milestone reference should be unresolved");
assert(unresolvedRefs.resolutions.every((item) => item.status !== "new"), "references must never become new");
assert(unresolvedRefs.blockers.every((item) => item.code === "UNRESOLVED_REFERENCE"), "unresolved references should use dedicated blocker");

// Wrong-kind IDs never cross-match.
const wrongKind = resolveResourceIdentities(
  graph([managedMilestone("wrong-kind", "Other", { id: 101 })]),
  snapshot(),
);
equal(resolution(wrongKind, "wrong-kind").status, "unresolved", "issue id must not satisfy milestone identity");

// Repository mismatch blocks the whole result deterministically.
const repoMismatch = resolveResourceIdentities(
  graph([managedIssue("repo-mismatch", "Alpha")]),
  snapshot({ repository: { fullName: "other/widgets", id: 200 } }),
);
assert(repoMismatch.blockers.some((item) => item.code === "INVALID_SCHEMA"), "repository mismatch should block");
equal(resolution(repoMismatch, "repo-mismatch").status, "unresolved", "repository mismatch should not resolve resources");

// Stable ordering of resolutions and diagnostics.
const ordered = resolveResourceIdentities(
  graph([
    referencedIssue("z-last", { number: 99 }),
    referencedIssue("a-first", { number: 98 }),
  ]),
  snapshot(),
);
equal(ordered.resolutions.map((item) => item.logicalId), ["a-first", "z-last"], "resolutions should sort by logical id");
equal(ordered.blockers.map((item) => item.logicalId), ["a-first", "z-last"], "diagnostics should sort by logical id");

// Create -> synthetic replan recovers the same issue from its canonical marker despite title drift.
const firstPass = resolveResourceIdentities(graph([managedIssue("replan", "Initial title")]), snapshot({ issues: [] }));
const futureMarker = resolution(firstPass, "replan").identity?.marker;
equal(futureMarker, "<!-- gh-plan:replan -->", "first pass should expose future marker");
const secondPass = resolveResourceIdentities(
  graph([managedIssue("replan", "Initial title")]),
  snapshot({
    issues: [{
      kind: "issue",
      number: 44,
      id: 144,
      nodeId: "I_144",
      title: "Editor renamed it",
      body: `body\n${futureMarker}`,
      state: "open",
    }],
  }),
);
equal(resolution(secondPass, "replan").status, "existing", "second pass should recover created issue");
equal(resolution(secondPass, "replan").identity?.number, 44, "replan should recover concrete issue number");


// M1.2: canonical markers must match the complete comment, not a longer logical ID.
const prefixSnapshot = snapshot({
  issues: [
    { kind: "issue", number: 10, id: 110, title: "AB", body: "<!-- gh-plan:AB -->", state: "open" },
    { kind: "issue", number: 11, id: 111, title: "A", body: "<!-- gh-plan:A -->", state: "open" },
  ],
});
equal(
  resolution(resolveResourceIdentities(
    graph([managedIssue("A", "No matching title")]), prefixSnapshot), "A").identity?.number,
  11,
  "canonical marker A must identify only the exact A HTML comment",
);
equal(
  resolution(resolveResourceIdentities(
    graph([managedIssue("AB", "No matching title")]), prefixSnapshot), "AB").identity?.number,
  10,
  "canonical marker AB must identify the exact AB HTML comment",
);
const longCanonicalOnly = resolveResourceIdentities(
  graph([managedIssue("A", "No matching title")]),
  snapshot({ issues: [prefixSnapshot.issues[0]!] }),
);
equal(resolution(longCanonicalOnly, "A").status, "new",
  "canonical A must never adopt an issue with only the AB marker");

// M1.2: custom markers are literal regex-escaped strings, matched on BOTH token edges.
const customMarkers = snapshot({
  issues: [
    { kind: "issue", number: 12, id: 112, title: "Long", body: "gh-plan:AB", state: "open" },
    { kind: "issue", number: 13, id: 113, title: "Left", body: "prefixgh-plan:A", state: "open" },
    { kind: "issue", number: 14, id: 114, title: "Right", body: "gh-plan:A-suffix", state: "open" },
    { kind: "issue", number: 15, id: 115, title: "Exact", body: "notes (gh-plan:A) more", state: "open" },
  ],
});
const shortCustom = managedIssue("A", "No matching title", { marker: "gh-plan:A" });
equal(
  resolution(resolveResourceIdentities(graph([shortCustom]), customMarkers), "A").identity?.number,
  15,
  "custom marker should ignore longer prefixes/suffixes and match whole tokens",
);
for (const body of ["gh-plan:AB", "prefixgh-plan:A", "gh-plan:A-suffix", "x:gh-plan:A"]) {
  const result = resolveResourceIdentities(graph([shortCustom]), snapshot({
    issues: [{ kind: "issue", number: 20, id: 120, title: "Other", body, state: "open" }],
  }));
  equal(resolution(result, "A").status, "new", "custom marker must not match embedded token: " + body);
}
const punctuatedMarker = "ticket.[A]+(v2)*?";
const punctuationSnapshot = snapshot({
  issues: [
    { kind: "issue", number: 21, id: 121, title: "Wrong", body: "ticket0A+v2xx", state: "open" },
    { kind: "issue", number: 22, id: 122, title: "Correct", body: "before " + punctuatedMarker + " after", state: "open" },
  ],
});
equal(
  resolution(resolveResourceIdentities(
    graph([managedIssue("literal", "No matching title", { marker: punctuatedMarker })]),
    punctuationSnapshot,
  ), "literal").identity?.number,
  22,
  "custom markers containing regex syntax must be matched literally",
);
const punctuationNegative = resolveResourceIdentities(
  graph([managedIssue("literal", "No matching title", { marker: punctuatedMarker })]),
  snapshot({ issues: [punctuationSnapshot.issues[0]!] }),
);
equal(resolution(punctuationNegative, "literal").status, "new",
  "custom markers must not interpret regex metacharacters as patterns");

// Explicit identity must not become ambiguous due to a different issue's longer custom marker.
const customExplicit = resolveResourceIdentities(
  graph([managedIssue("A", "No matching title", { number: 1, marker: "gh-plan:A" })]),
  snapshot({
    issues: [
      { kind: "issue", number: 1, id: 101, title: "Selected", body: null, state: "open" },
      { kind: "issue", number: 2, id: 102, title: "Unrelated", body: "gh-plan:AB", state: "open" },
    ],
  }),
);
equal(resolution(customExplicit, "A").identity?.number, 1,
  "a longer custom marker must not conflict with explicit numeric identity");
equal(customExplicit.blockers, [], "no marker collision should produce an ambiguity blocker");
