import assert from "node:assert/strict";
import test from "node:test";

process.env.DEPLOY_ENV = "test";
process.env.OBJECT_STORAGE_BACKEND = "file";
process.env.FFMPEG_PATH = process.execPath;

const [{ occlusionTraceMetadata }, { mattingTraceMetadata }, viapi] = await Promise.all([
  import("../repair.js"),
  import("../matting.js"),
  import("../providers/viapi.js"),
]);

test("occlusion repair preserves the supplier model and records post-processing separately", () => {
  assert.equal(typeof occlusionTraceMetadata, "function");
  const metadata = occlusionTraceMetadata({
    contentId: "content-1",
    provider: "aliyun",
    providerModel: "MergeVideoFace",
    taskId: "task-1",
  });
  assert.equal(metadata.model, "MergeVideoFace");
  assert.equal(metadata.postProcessingModel, "occlusion-mask-merge");
});

test("video matting preserves SegmentVideoBody and records maskedmerge separately", () => {
  assert.equal(viapi.VIDEO_MATTING_MODEL, "SegmentVideoBody");
  assert.equal(typeof mattingTraceMetadata, "function");
  const metadata = mattingTraceMetadata({
    contentId: "content-2",
    provider: "aliyun-viapi",
    providerModel: viapi.VIDEO_MATTING_MODEL,
    taskId: "task-2",
  });
  assert.equal(metadata.model, "SegmentVideoBody");
  assert.equal(metadata.postProcessingModel, "maskedmerge");
});
