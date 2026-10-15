import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set(["node_modules", "data", "private-objects", "web"]);

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}

const files = walk(serverRoot);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`server syntax check passed: ${files.length} files`);
