import assert from "node:assert/strict";
import test from "node:test";
import { decodeImageDataUrl, decodeVideoDataUrl } from "../media-validation.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("image upload validation checks actual type and dimensions", () => {
  const valid = decodeImageDataUrl(`data:image/png;base64,${PNG_BASE64}`);
  assert.equal(valid.mime, "image/png");
  assert.equal(valid.width, 1);
  assert.equal(valid.height, 1);
  assert.throws(() => decodeImageDataUrl(`data:image/jpeg;base64,${PNG_BASE64}`), (error) => error.code === "MEDIA_TYPE_MISMATCH");
  assert.throws(() => decodeImageDataUrl("data:image/png;base64,aGVsbG8="), (error) => error.code === "MEDIA_TYPE_MISMATCH");

  const oversizedHeader = Buffer.from(PNG_BASE64, "base64");
  oversizedHeader.writeUInt32BE(20_000, 16);
  oversizedHeader.writeUInt32BE(20_000, 20);
  assert.throws(() => decodeImageDataUrl(`data:image/png;base64,${oversizedHeader.toString("base64")}`), (error) => error.code === "IMAGE_DIMENSIONS_TOO_LARGE");
});

test("video upload validation rejects extension-only spoofing", () => {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write("ftyp", 4, "ascii");
  ftyp.write("isom", 8, "ascii");
  const mdat = Buffer.alloc(8);
  mdat.writeUInt32BE(8, 0);
  mdat.write("mdat", 4, "ascii");
  const mp4 = Buffer.concat([ftyp, mdat]);
  const valid = decodeVideoDataUrl(`data:video/mp4;base64,${mp4.toString("base64")}`);
  assert.equal(valid.mime, "video/mp4");
  assert.equal(valid.container, "iso-bmff");
  assert.throws(() => decodeVideoDataUrl(`data:video/webm;base64,${mp4.toString("base64")}`), (error) => error.code === "MEDIA_TYPE_MISMATCH");
  assert.throws(() => decodeVideoDataUrl("data:video/mp4;base64,aGVsbG8="), (error) => ["INVALID_VIDEO", "MEDIA_TYPE_MISMATCH"].includes(error.code));
});
