import assert from "node:assert/strict";
import test from "node:test";
import { catalogMediaUrl } from "../src/data/catalogMedia.ts";

test("native catalogs resolve uploaded media on the API host while web keeps same-origin paths", () => {
  const uploaded = "/effects/uploads/11111111-1111-4111-8111-111111111111.mp4";
  assert.equal(catalogMediaUrl(uploaded, "https://stage.example.test"), `https://stage.example.test${uploaded}`);
  assert.equal(catalogMediaUrl(uploaded, ""), uploaded);
  assert.equal(catalogMediaUrl(undefined, "https://stage.example.test"), undefined);
});
