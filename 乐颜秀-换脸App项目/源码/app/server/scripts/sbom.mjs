import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.SBOM_OUTPUT || path.join(serverRoot, "sbom.cdx.json");
const lockFile = path.join(serverRoot, "package-lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const rootPackage = lock.packages?.[""] || {};
const components = [];
const seen = new Set();
for (const [location, dependency] of Object.entries(lock.packages || {})) {
  if (!location || dependency.dev === true || !dependency.version) continue;
  const name = dependency.name || location.split("node_modules/").pop();
  const key = `${name}@${dependency.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  components.push({
    type: "library",
    name,
    version: dependency.version,
    scope: "required",
    purl: `pkg:npm/${name}@${dependency.version}`,
    ...(dependency.integrity ? { hashes: [{ alg: "SHA-512", content: dependency.integrity.replace(/^sha512-/, "") }] } : {}),
  });
}
components.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const document = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: lock.name || rootPackage.name || "leyanxiu-server", version: lock.version || rootPackage.version || "unknown" } },
  components,
};
fs.writeFileSync(output, JSON.stringify(document, null, 2), { mode: 0o600 });
console.log(`SBOM written: ${output}`);
