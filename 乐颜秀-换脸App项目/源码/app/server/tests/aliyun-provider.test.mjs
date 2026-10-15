import assert from "node:assert/strict";
import test from "node:test";

import * as aliyun from "../providers/aliyun.js";

const { parseAsyncJobResultResponse } = aliyun;

test("selects the auditable Aliyun video fusion model for each request mode", () => {
  assert.equal(typeof aliyun.videoFusionModel, "function");
  assert.equal(aliyun.videoFusionModel({ templateId: "template-1" }), "MergeVideoModelFace");
  assert.equal(aliyun.videoFusionModel({ videoUrl: "https://example.test/template.mp4" }), "MergeVideoFace");
});

test("parses the documented VIAPI Result JSON string and VideoUrl field", () => {
  const videoUrl = "https://example.aliyuncs.com/result.mp4?signature=REDACTED_SECRET";
  const result = parseAsyncJobResultResponse({
    RequestId: "request-1",
    Data: {
      Status: "PROCESS_SUCCESS",
      Result: JSON.stringify({
        VideoCoverUrl: "https://example.aliyuncs.com/result.jpg",
        VideoUrl: videoUrl,
      }),
    },
  });

  assert.deepEqual(result, { status: "SUCCESS", videoUrl });
});

test("accepts object Result and historical URL key variants", () => {
  assert.equal(
    parseAsyncJobResultResponse({ Data: { Status: "PROCESS_SUCCESS", Result: { VideoURL: "https://example.test/a.mp4" } } }).videoUrl,
    "https://example.test/a.mp4",
  );
  assert.equal(
    parseAsyncJobResultResponse({ Data: { Status: "PROCESS_SUCCESS", Result: { videoUrl: "https://example.test/b.mp4" } } }).videoUrl,
    "https://example.test/b.mp4",
  );
});

test("retains supplier failure code and message", () => {
  assert.deepEqual(
    parseAsyncJobResultResponse({
      Data: {
        Status: "PROCESS_FAILED",
        Code: "InvalidFace",
        Message: "未检测到清晰人脸",
      },
    }),
    {
      status: "FAILED",
      providerCode: "InvalidFace",
      providerMessage: "未检测到清晰人脸",
    },
  );
});

test("fails explicitly when a successful result is malformed or has no video URL", () => {
  assert.throws(
    () => parseAsyncJobResultResponse({ Data: { Status: "PROCESS_SUCCESS", Result: "not-json" } }),
    (error) => error.code === "ALIYUN_RESULT_INVALID_JSON",
  );
  assert.throws(
    () => parseAsyncJobResultResponse({ Data: { Status: "PROCESS_SUCCESS", Result: { VideoCoverUrl: "https://example.test/a.jpg" } } }),
    (error) => error.code === "ALIYUN_RESULT_VIDEO_URL_MISSING",
  );
});
