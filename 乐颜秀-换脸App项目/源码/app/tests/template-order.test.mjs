import assert from "node:assert/strict";
import test from "node:test";

const templates = await import("../src/data/templates.ts");

test("video templates are ordered by newest publication before manual sort order", () => {
  assert.equal(typeof templates.sortVideoTemplatesNewestFirst, "function");
  const ordered = templates.sortVideoTemplatesNewestFirst([
    { id: "older-manual-first", publishedAt: "2026-08-01T00:00:00Z", sortOrder: 1 },
    { id: "newest", publishedAt: "2026-09-01T00:00:00Z", sortOrder: 999 },
    { id: "undated", sortOrder: 0 },
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ["newest", "older-manual-first", "undated"]);
});
