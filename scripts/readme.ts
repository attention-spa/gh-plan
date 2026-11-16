import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export type ConceptSummary = {
  slug: string;
  title: string;
  description: string;
  summary: string;
};

const BEGIN = "<!-- okf:begin -->";
const END = "<!-- okf:end -->";

/** Parse the declared order rather than relying on filesystem enumeration. */
export function readOrderedConcepts(knowledgeRoot: string): ConceptSummary[] {
  const conceptsDir = join(knowledgeRoot, "concepts");
  const index = readFileSync(join(conceptsDir, "index.md"), "utf8");
  const rows = [...index.matchAll(/^- \[([^\]]+)\]\(\/concepts\/([a-z0-9-]+)\.md\) — (.+)$/gm)];
  const bullets = index.split(/\r?\n/).filter((line) => line.startsWith("- "));
  if (rows.length === 0 || bullets.length !== rows.length) {
    throw new Error("Concept index must contain ordered, parseable title/link/description entries.");
  }
  const slugs = rows.map((row) => row[2]);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error("Concept index contains duplicate entries.");
  }
  const onDisk = readdirSync(conceptsDir).filter((name) =>
    name.endsWith(".md") && name !== "index.md").sort();
  if (JSON.stringify([...slugs].sort().map((slug) => slug + ".md")) !== JSON.stringify(onDisk)) {
    throw new Error("Concept index is missing a page, or references a nonexistent concept.");
  }
  return rows.map(([, linkedTitle, slug, linkedDescription]) => {
    const text = readFileSync(join(conceptsDir, slug + ".md"), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!match) throw new Error("Missing YAML frontmatter: " + slug);
    const yaml = YAML.parseDocument(match[1], { version: "1.2", uniqueKeys: true });
    if (yaml.errors.length) throw new Error("Malformed frontmatter: " + slug);
    const meta = yaml.toJS();
    if (meta?.type !== "Concept" || typeof meta.title !== "string" ||
        typeof meta.description !== "string" || !meta.title.trim() ||
        !meta.description.trim()) {
      throw new Error("Concept is missing type, title or description: " + slug);
    }
    if (meta.title !== linkedTitle || meta.description !== linkedDescription) {
      throw new Error("Concept index title/description out of sync: " + slug);
    }
    const body = text.slice(match[0].length);
    const lines = body.split(/\r?\n/);
    const summaryStart = lines.findIndex((line) => line.trim() === "## Summary");
    if (summaryStart < 0 || lines.findIndex((line, i) =>
      i > summaryStart && line.trim() === "## Summary") >= 0) {
      throw new Error("Concept must have exactly one ## Summary heading: " + slug);
    }
    const nextHeading = lines.findIndex((line, i) =>
      i > summaryStart && /^#{1,6}\s+/.test(line));
    const summary = lines.slice(summaryStart + 1,
      nextHeading < 0 ? undefined : nextHeading).join("\n").trim();
    if (!summary) throw new Error("Concept Summary cannot be empty: " + slug);
    // Bundle-root links are correct in knowledge/, but the README lives one level higher.
    const readmeLinks = summary.replace(/\]\(\/(?!\/)/g, "](knowledge/");
    return { slug, title: meta.title, description: meta.description, summary: readmeLinks };
  });
}

/** Deterministic Markdown generated solely from ordered OKF source contents. */
export function renderConceptSection(knowledgeRoot: string): string {
  const concepts = readOrderedConcepts(knowledgeRoot);
  return [
    "<!-- Generated from knowledge/concepts/index.md; run npm run docs:readme. -->",
    "## Core concepts",
    ...concepts.map((concept) =>
      "### [" + concept.title + "](knowledge/concepts/" + concept.slug + ".md)\n\n" +
      concept.description + "\n\n" + concept.summary),
  ].join("\n\n");
}

/** Strictly replace marker *contents*, preserving every byte outside the block. */
export function replaceOkfBlock(readme: string, content: string): string {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start < 0 || end < start + BEGIN.length ||
      readme.indexOf(BEGIN, start + BEGIN.length) !== -1 ||
      readme.indexOf(END, end + END.length) !== -1 ||
      (start !== 0 && readme[start - 1] !== "\n") ||
      (end + END.length !== readme.length &&
        !/^\r?\n/.test(readme.slice(end + END.length)))) {
    throw new Error("README requires exactly one ordered pair of standalone OKF markers.");
  }
  if (!/^\r?\n/.test(readme.slice(start + BEGIN.length)) ||
      !/\n$/.test(readme.slice(0, end))) {
    throw new Error("README OKF markers must be on their own lines.");
  }
  const newline = readme.includes("\r\n") ? "\r\n" : "\n";
  return readme.slice(0, start + BEGIN.length) + newline +
    content.replace(/\r?\n/g, newline) + newline + readme.slice(end);
}

function main(): void {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    throw new Error("Usage: node --experimental-strip-types scripts/readme.ts --write|--check");
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const readmePath = join(repositoryRoot, "README.md");
  const current = readFileSync(readmePath, "utf8");
  const expected = replaceOkfBlock(current, renderConceptSection(
    join(repositoryRoot, "knowledge")));
  if (current === expected) {
    console.log("README OKF section matches the knowledge bundle.");
  } else if (mode === "--write") {
    writeFileSync(readmePath, expected, "utf8");
    console.log("Updated only the README OKF generated section.");
  } else {
    console.error("README OKF section is stale; run npm run docs:readme.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
