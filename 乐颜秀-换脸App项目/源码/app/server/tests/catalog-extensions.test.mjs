import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyx-catalog-ext-"));
process.env.ADMIN_STORE_FILE = path.join(root, "admin-console.json");
process.env.ADMIN_ASSET_DIR = path.join(root, "assets");
process.env.DEPLOY_ENV = "test";
const { adminStore, validateCatalog } = await import("../admin-store.js");
const { resolveVideoTemplate } = await import("../video-template-config.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("new catalog entries are validated, reviewed, published and bound to executable capabilities", () => {
  const catalog = adminStore.workspace().draft.catalog;
  const id = "11111111-1111-4111-8111-111111111111";
  const videoPath = `/effects/uploads/${id}.mp4`;
  fs.mkdirSync(path.join(process.env.ADMIN_ASSET_DIR, "effects", "uploads"), { recursive: true });
  // This fixture enters at the already-validated media-library boundary; media
  // codec/rights validation has its own actual-byte tests in admin-media.test.
  fs.writeFileSync(path.join(process.env.ADMIN_ASSET_DIR, videoPath), "sealed-library-video-fixture");
  const video = { ...catalog.templates[0], id: `custom-video-${id}`, previewVideo: videoPath, enabled: true, rightsReference: "原创视频授权记录-001" };
  const category = { ...catalog.photoCategories[0], id: `custom-category-${id}`, name: "自然肖像", enabled: true };
  const effect = { ...catalog.photoEffects[1], id: `custom-effect-${id}`, categoryId: category.id, title: "自然光肖像", prompt: "把背景改为柔和自然光摄影棚，保持原人物身份。", enabled: true };
  catalog.templates.push(video);
  catalog.photoCategories.push(category);
  catalog.photoEffects.push(effect);
  catalog.photoEffects[1].categoryId = category.id;
  const validated = validateCatalog(catalog);
  assert.equal(validated.photoEffects[1].categoryId, category.id);
  assert.equal(adminStore.executionPhotoEffect(effect.id), null, "draft does not affect execution");
  const saved = adminStore.updateDraft({ catalog, expectedRevision: 1, actor: "operator", note: "新模板及提示词验收" });
  adminStore.publish({ expectedRevision: saved.draft.revision, actor: "reviewer", note: "审核视频授权与效果说明" });
  const resolved = resolveVideoTemplate(video.id, adminStore.publicCatalog(), {}, "https://stage.example.test");
  assert.equal(resolved.videoUrl, `https://stage.example.test${videoPath}`);
  const executable = adminStore.executionPhotoEffect(effect.id);
  assert.equal(executable.type, "generative");
  assert.match(executable.prompt, /保持原人物身份/);
  assert.match(executable.prompt, /严格保留同一个人的身份/);
  for (const mutate of [
    (value) => { value.templates.at(-1).previewVideo = "https://other.test/clip.mp4"; },
    (value) => { value.templates.at(-1).rightsReference = ""; },
    (value) => { value.photoEffects.at(-1).prompt = ""; },
    (value) => { value.photoEffects.at(-1).categoryId = "missing"; },
    (value) => { value.photoEffects.find((item) => item.id === "face-enhance").prompt = "改变固定模型绕过受控参数"; },
    (value) => { value.templates.pop(); value.templates.pop(); },
  ]) {
    const invalid = structuredClone(catalog); mutate(invalid);
    assert.throws(() => validateCatalog(invalid), { code: "INVALID_CATALOG" });
  }
});
