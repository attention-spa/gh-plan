import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = fileURLToPath(new URL("../knowledge/", import.meta.url));
const paths = new Map();
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const id = relative(root, absolute).split(sep).join("/");
      paths.set(id, readFileSync(absolute, "utf8"));
    }
  }
}
visit(root);

const concepts = [
  "desired-state-graph", "logical-id", "management-modes", "identity-resolution",
  "relationships", "plan-and-steps", "late-binding-refs", "diagnostics",
];
const decisions = [
  "markers-in-body", "deterministic-output", "no-secrets-in-plans",
  "relationship-reconciliation", "issue-deletion-policy", "title-adoption-opt-in",
];
const required = [
  "index.md", "log.md", "overview.md", "concepts/index.md", "decisions/index.md",
  ...concepts.map((x) => "concepts/" + x + ".md"),
  ...decisions.map((x) => "decisions/" + x + ".md"),
];
assert.deepEqual([...paths.keys()].sort(), required.sort(),
  "M6.1 must include all requested OKF pages and no unexpected markdown assets.");

function frontmatter(id, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert(match, id + " must begin with valid YAML frontmatter.");
  const document = YAML.parseDocument(match[1], { version: "1.2", uniqueKeys: true });
  assert.equal(document.errors.length, 0,
    id + " has invalid YAML frontmatter: " + document.errors.join(", "));
  const value = document.toJS();
  assert(value && typeof value === "object" && !Array.isArray(value),
    id + " frontmatter must be a YAML object.");
  return { meta: value, body: text.slice(match[0].length) };
}
const actor = /^(?:[a-z0-9._-]+\/[a-z0-9._-]+|human:[a-z0-9._-]+|process:[a-z0-9._-]+)$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const reserved = new Set(["index.md", "log.md"]);
const pages = new Map();
for (const [id, text] of paths) {
  if (id === "index.md") {
    const { meta } = frontmatter(id, text);
    assert.deepEqual(Object.keys(meta), ["okf_version"],
      "Bundle-root index may contain only the okf_version frontmatter key.");
    assert.equal(meta.okf_version, "0.2");
  } else if (id.endsWith("/index.md") || id === "log.md") {
    assert(!text.startsWith("---"), "Non-root index and log must have no frontmatter: " + id);
  } else {
    const { meta, body } = frontmatter(id, text);
    assert.equal(meta.type, id === "overview.md" ? "Overview" :
      id.startsWith("concepts/") ? "Concept" : "Decision", "Invalid OKF type: " + id);
    assert(typeof meta.title === "string" && meta.title.trim(), "Missing title in " + id);
    assert(typeof meta.description === "string" && meta.description.trim(),
      "Missing description in " + id);
    assert(["draft", "stable", "deprecated"].includes(meta.status),
      "Invalid OKF lifecycle status in " + id);
    assert.equal(meta.status, "draft", "Initial M6.1 knowledge remains draft: " + id);
    assert(meta.generated && actor.test(meta.generated.by),
      "generated.by must use agent/version, human:<id> or process:<id> in " + id);
    assert(typeof meta.generated.at === "string" && timestamp.test(meta.generated.at) &&
      Number.isFinite(Date.parse(meta.generated.at)),
      "generated.at must be an ISO 8601 datetime with explicit offset in " + id);
    assert(!Object.hasOwn(meta, "verified"),
      "Unreviewed agent-generated M6.1 content must not claim human verification.");
    assert(Array.isArray(meta.sources) && meta.sources.length,
      "Include provenance source materials in " + id);
    for (const source of meta.sources) {
      assert(typeof source.resource === "string" && source.resource.startsWith("https://"),
        "Each provenance source needs a resolvable absolute URI in " + id);
    }
    assert(/^## Summary\n/m.test(body), "M6.3-compatible Summary heading required in " + id);
    pages.set(id, meta);
  }
  // Bundle-root paths are relative to knowledge/, never to the Git repository root.
  const links = [...text.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)];
  for (const [, uri] of links) {
    if (/^https?:\/\//.test(uri)) continue;
    assert(uri.startsWith("/") && !uri.startsWith("//"),
      "Internal OKF links must begin at bundle root in " + id + ": " + uri);
    assert(!uri.includes(".."), "Bundle root links cannot escape knowledge/: " + uri);
    const target = uri.slice(1).split("#")[0];
    assert(paths.has(target), "Broken bundle link " + uri + " in " + id);
  }
}

for (const [dir, slugs] of [["concepts", concepts], ["decisions", decisions]]) {
  const index = paths.get(dir + "/index.md");
  assert(index && /^#\s+.+/m.test(index), dir + " index must contain a heading.");
  for (const slug of slugs) {
    const id = dir + "/" + slug + ".md";
    assert(index.includes("](/" + id + ")"),
      dir + " index must link to every listed page: " + id);
    assert(index.includes(pages.get(id).description),
      dir + " index descriptions should match page frontmatter for " + id);
  }
  const refs = [...index.matchAll(/\]\(\/(concepts|decisions)\/([^/]+)\.md\)/g)];
  assert.equal(refs.length, slugs.length, dir + " index must not omit/duplicate entries.");
}
for (const id of ["overview.md", "concepts/index.md", "decisions/index.md", "log.md"]) {
  assert(paths.get("index.md").includes("](/" + id + ")"),
    "Root index must reveal " + id);
}
const log = paths.get("log.md");
assert(/^#\s+.+/m.test(log), "Log needs a descriptive heading.");
const groups = [...log.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})$/gm)].map((x) => x[1]);
assert(groups.length >= 2 && groups[0] === "2026-11-16",
  "Log must begin with the current M6.1 date and retain historical groups.");
assert(groups.every((x, i) => Number.isFinite(Date.parse(x + "T00:00:00Z")) &&
  (i === 0 || x < groups[i - 1])), "Log dates must be valid, unique and newest first.");
for (let n = 2; n <= 9; n++) {
  assert(new RegExp("issues/" + n + "(?!\\d)").test(log), "Legacy issue #" + n + " missing from history.");
}
for (let m = 1; m <= 5; m++) {
  assert(new RegExp("\\bM" + m + "\\b").test(log), "Milestone M" + m + " missing from history.");
}
assert(log.includes("M6.1") && log.includes("issues/30"),
  "Log needs a creation entry for M6.1.");
console.log("OKF v0.2 structure, YAML metadata, provenance, offsets, links, indexes and history passed.");
