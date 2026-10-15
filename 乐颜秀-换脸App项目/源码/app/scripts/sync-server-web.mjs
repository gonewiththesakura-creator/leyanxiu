import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist");
const target = path.join(root, "server", "web");

if (!fs.existsSync(path.join(source, "index.html"))) {
  throw new Error("dist/index.html does not exist; run npm run build first");
}
if (path.relative(root, target).startsWith("..")) {
  throw new Error("server web target escaped the repository root");
}

for (const name of ["assets", "avatars", "banners", "effects", "plays", "templates", "index.html"]) {
  fs.rmSync(path.join(target, name), { recursive: true, force: true });
}

function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (!stat.isDirectory()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    copyTree(path.join(from, entry.name), path.join(to, entry.name));
  }
}

copyTree(source, target);

console.log(`Synced ${source} -> ${target}`);
