import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const relativeTsSpecifier = /(\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])(\.\.?\/[^"'\r\n]+)\.ts\2/g;
let rewritten = 0;

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filename);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      const source = readFileSync(filename, "utf8");
      const updated = source.replace(relativeTsSpecifier, (_match, prefix, quote, stem) => {
        rewritten++;
        return prefix + quote + stem + ".js" + quote;
      });
      if (updated !== source) writeFileSync(filename, updated);
    }
  }
}

visit(dist);
console.log("Rewrote " + rewritten + " TypeScript declaration import specifiers to .js.");
