import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readOrderedConcepts, renderConceptSection, replaceOkfBlock,
} from "../scripts/readme.ts";

const temp = mkdtempSync(join(tmpdir(), "gh-plan-okf-readme-"));
try {
  const root = join(temp, "knowledge");
  const concepts = join(root, "concepts");
  mkdirSync(concepts, { recursive: true });
  const index = "# Concepts\n\n" +
    "- [Beta](/concepts/beta.md) — Beta description.\n" +
    "- [Alpha](/concepts/alpha.md) — Alpha description.\n";
  writeFileSync(join(concepts, "index.md"), index);
  const page = (title, description, summary) =>
    "---\ntype: Concept\ntitle: " + JSON.stringify(title) +
    "\ndescription: " + JSON.stringify(description) + "\n---\n\n" +
    "## Summary\n\n" + summary + "\n\n## Details\n\nNot in the Summary.\n";
  writeFileSync(join(concepts, "beta.md"),
    page("Beta", "Beta description.", "A [cross-link](/concepts/alpha.md) and another sentence."));
  writeFileSync(join(concepts, "alpha.md"),
    page("Alpha", "Alpha description.", "Plain alpha summary."));
  const parsed = readOrderedConcepts(root);
  assert.deepEqual(parsed.map((x) => x.slug), ["beta", "alpha"],
    "README order must follow index order, not filesystem sorting.");
  const rendered = renderConceptSection(root);
  assert(rendered.indexOf("### [Beta]") < rendered.indexOf("### [Alpha]"));
  assert(rendered.includes("Beta description."));
  assert(rendered.includes("](knowledge/concepts/alpha.md)"),
    "Bundle-root links must render relative to root README.");
  assert(!rendered.includes("Not in the Summary."), "No non-Summary sections.");
  const prefix = "# Manual title\r\n\r\n## Install\r\nHandwritten install remains.\r\n";
  const suffix = "\r\n## Quickstart\r\nHandwritten quickstart remains.\r\n";
  const original = prefix + "<!-- okf:begin -->\r\nstale\r\n<!-- okf:end -->" + suffix;
  const updated = replaceOkfBlock(original, rendered);
  assert(updated.startsWith(prefix) && updated.endsWith(suffix),
    "Generated update must preserve manual text byte-for-byte.");
  assert(!updated.includes("\r\nstale\r\n"));
  assert(updated.includes("\r\n### [Beta]"), "Preserve README CRLF style.");
  assert.equal(replaceOkfBlock(updated, rendered), updated,
    "Regeneration must be idempotent.");
  for (const bad of [
    "# no markers", "<!-- okf:begin -->\nmissing end",
    "<!-- okf:end -->\n<!-- okf:begin -->",
    "<!-- okf:begin -->\n<!-- okf:end -->\n<!-- okf:end -->",
  ]) {
    assert.throws(() => replaceOkfBlock(bad, rendered),
      /exactly one ordered pair|markers/, "Malformed markers must reject: " + bad);
  }
  writeFileSync(join(concepts, "index.md"), index.replace(
    "Beta description.", "Incorrect description."));
  assert.throws(() => readOrderedConcepts(root), /out of sync/,
    "Index and frontmatter divergence must fail.");
  writeFileSync(join(concepts, "index.md"), index);
  writeFileSync(join(concepts, "alpha.md"),
    page("Alpha", "Alpha description.", ""));
  assert.throws(() => renderConceptSection(root), /Summary cannot be empty/,
    "Empty concept summaries must fail.");
  console.log("OKF README ordering, summaries, links, manual preservation, idempotence and failures passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
