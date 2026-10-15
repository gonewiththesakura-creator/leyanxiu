import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-marking-"));
const reportPath = path.join(tempRoot, "conformance.json");

function status(report, pinOverride) {
  const bytes = Buffer.from(JSON.stringify(report));
  fs.writeFileSync(reportPath, bytes);
  const pin = pinOverride ?? crypto.createHash("sha256").update(bytes).digest("hex");
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import { markingConformanceStatus } from './ai-marking.js'; console.log(JSON.stringify(markingConformanceStatus()));",
  ], {
    cwd: serverRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AI_MARKING_CONFORMANCE_REPORT: reportPath,
      AI_MARKING_CONFORMANCE_REPORT_SHA256: pin,
    },
  });
  return JSON.parse(output.trim());
}

function validReport() {
  return {
    standard: "GB 45438-2025",
    result: "pass",
    tool: "independent-test-tool",
    testedAt: "2026-01-01T00:00:00.000Z",
    testedArtifactSha256: "a".repeat(64),
    checks: {
      visibleLabel: true,
      implicitIdentifier: true,
      serviceProvider: true,
      contentId: true,
    },
  };
}

test("AI marking status is verified only by a pinned complete conformance report", () => {
  const verified = status(validReport());
  assert.equal(verified.verified, true);
  assert.equal(verified.standard, "GB 45438-2025");

  const wrongPin = status(validReport(), "b".repeat(64));
  assert.equal(wrongPin.verified, false);
  assert.match(wrongPin.reason, /hash mismatch/);

  const incomplete = validReport();
  incomplete.checks.implicitIdentifier = false;
  const rejected = status(incomplete);
  assert.equal(rejected.verified, false);
  assert.match(rejected.reason, /required passing checks/);
});

test("video marking uses the supplied Chinese-visible label instead of a hard-coded English claim", () => {
  const sourceFiles = ["ai-marking.js", "index.js", "matting.js", "repair.js", path.join("providers", "viapi.js")];
  const source = sourceFiles.map((file) => fs.readFileSync(path.join(serverRoot, file), "utf8")).join("\n");
  assert.ok(/const escapedLabel = String\(label \|\| "AI生成"\)/.test(source), 'video marking must retain its Chinese default and accept a supplied label');
  assert.doesNotMatch(source, /AI GENERATED|explicit-visible-and-implicit-metadata/);
});

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
