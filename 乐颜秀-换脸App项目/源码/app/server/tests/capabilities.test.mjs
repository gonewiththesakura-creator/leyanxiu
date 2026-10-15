import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-capabilities-"));
process.env.DEPLOY_ENV = "production";
process.env.NODE_ENV = "production";
process.env.CAPABILITY_EVIDENCE_DIR = evidenceRoot;
process.env.ALIYUN_ACCESS_KEY_ID = "placeholder-id";
process.env.ALIYUN_ACCESS_KEY_SECRET = "placeholder-secret";
process.env.TENCENT_SECRET_ID = "placeholder-id";
process.env.TENCENT_SECRET_KEY = "placeholder-secret";
process.env.VOLC_API_KEY = "placeholder-key";
process.env.DASHSCOPE_API_KEY = "placeholder-key";

const evidenceFiles = [
  "video-fusion.json",
  "photo-restore.json",
  "photo-fusion.json",
  "idphoto.json",
  "photo-age.json",
  "photo-effects.json",
  "content-safety.json",
];

function samples(count) {
  return Array.from({ length: count }, (_, index) => ({ sampleId: `sample-${index}`, status: "success", identityMismatch: false, severeDistortion: false }));
}

for (const file of evidenceFiles) fs.writeFileSync(path.join(evidenceRoot, file), JSON.stringify({ samples: samples(30) }));
const { capabilityReadiness } = await import("../provider-registry.js");

test("capabilities require configured providers, templates and 30 passing unique samples", () => {
  const ready = capabilityReadiness({ videoTemplates: 1, photoTemplates: 1 });
  assert.equal(ready.ready, false);
  assert.ok(ready.entries.filter((entry) => entry.id !== "content-safety").every((entry) => entry.ready && entry.sampleCount === 30 && entry.passingSampleCount === 30));
  assert.equal(ready.entries.find((entry) => entry.id === "content-safety")?.ready, false);

  fs.writeFileSync(path.join(evidenceRoot, "photo-restore.json"), JSON.stringify({ samples: samples(29) }));
  const blocked = capabilityReadiness({ videoTemplates: 1, photoTemplates: 1 });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.some((item) => item.startsWith("photo-restore:")));

  const forgedAggregate = samples(30);
  forgedAggregate[29] = { ...forgedAggregate[29], status: "failure" };
  fs.writeFileSync(path.join(evidenceRoot, "photo-restore.json"), JSON.stringify({
    samples: forgedAggregate,
    successRate: 100,
    identityMismatchCount: 0,
    severeDistortionCount: 0,
  }));
  const aggregateCannotOverrideSamples = capabilityReadiness({ videoTemplates: 1, photoTemplates: 1 });
  const restore = aggregateCannotOverrideSamples.entries.find((entry) => entry.id === "photo-restore");
  assert.equal(restore.ready, false);
  assert.equal(restore.passingSampleCount, 29);

  const missingTemplate = capabilityReadiness({ videoTemplates: 0, photoTemplates: 1 });
  assert.equal(missingTemplate.ready, false);
  assert.ok(missingTemplate.entries.find((entry) => entry.id === "video-fusion")?.ready === false);
});

test.after(() => {
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});
