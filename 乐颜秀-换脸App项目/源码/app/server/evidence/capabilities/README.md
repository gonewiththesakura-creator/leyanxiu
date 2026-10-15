# 能力验收证据目录

每个能力使用同名 JSON 文件，例如 `video-fusion.json`。文件必须来自真实测试流水线，不能手工把环境变量改成通过。

```json
{
  "capability": "photo-restore",
  "provider": "aliyun-viapi",
  "model": "EnhanceFace+ColorizeImage",
  "samples": [
    {
      "sampleId": "unique-real-sample-id",
      "inputDigest": "sha256:...",
      "outputDigest": "sha256:...",
      "status": "success",
      "latencyMs": 1234,
      "costFen": 0,
      "identityMismatch": false,
      "moderationDecision": "allow",
      "testedAt": "2026-08-29T00:00:00Z"
    }
  ]
}
```

发布闸门只统计去重后的 `sampleId`，每个核心能力至少 30 条；供应商凭据、素材授权、人工审核和真实设备结果仍需单独留档。
