import assert from "node:assert/strict";
import test from "node:test";
import { resolveVideoTemplate } from "../video-template-config.js";

const template = { id: "custom-video-11111111-1111-4111-8111-111111111111", name: "新舞蹈", media: "video", mode: "video-fusion", enabled: true, previewVideo: "/effects/uploads/11111111-1111-4111-8111-111111111111.mp4", rightsReference: "company-license-001" };
test("published managed videos use the immutable preview as the actual fusion source", () => {
  const resolved = resolveVideoTemplate(template.id, { templates: [template] }, {}, "https://stage.example.test");
  assert.equal(resolved.videoUrl, `https://stage.example.test${template.previewVideo}`);
  assert.equal(resolved.managed, true);
  assert.equal(resolved.maskKey, "");
});
test("replacing an existing preview with an uploaded video also replaces the actual fusion source", () => {
  const item = { ...template, id: "jinqu" };
  const resolved = resolveVideoTemplate("jinqu", { templates: [item] }, { jinqu: { videoUrl: "https://oss.example.test/old.mp4", aliyunTemplateId: "old-model", maskKey: "old-mask" } }, "https://stage.example.test");
  assert.equal(resolved.videoUrl, `https://stage.example.test${template.previewVideo}`);
  assert.equal(resolved.aliyunTemplateId, "");
  assert.equal(resolved.maskKey, "");
});
test("unpublished, disabled, unlicensed or external template sources cannot reach a provider", () => {
  for (const item of [{ ...template, enabled: false }, { ...template, rightsReference: "" }, { ...template, previewVideo: "https://evil.test/video.mp4" }, { ...template, previewVideo: "/effects/uploads/../secret.mp4" }]) {
    assert.equal(resolveVideoTemplate(template.id, { templates: [item] }, {}, "https://stage.example.test"), null);
  }
  assert.equal(resolveVideoTemplate(template.id, { templates: [] }, {}, "https://stage.example.test"), null);
});
