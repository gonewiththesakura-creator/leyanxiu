import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lyx-admin-media-"));
process.env.ADMIN_ASSET_DIR = directory;
process.env.ADMIN_ALLOW_INSECURE_LOCAL = "true";
process.env.ADMIN_PASSWORD = "test-admin-password-only";
const { saveAdminMedia, registerAdminMediaRoutes } = await import("../admin-media.js");
const { createAdminSession } = await import("../admin-auth.js");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const input = { name: "原创效果", dataUrl: png, rightsConfirmed: true, rightsReference: "测试自有素材" };
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("admin media validates bytes/rights/path and saves unique immutable decodable images", async () => {
  await assert.rejects(saveAdminMedia({ ...input, name: "../escape" }, "admin"));
  await assert.rejects(saveAdminMedia({ ...input, rightsConfirmed: false }, "admin"));
  await assert.rejects(saveAdminMedia({ ...input, dataUrl: png.replace("image/png", "image/jpeg") }, "admin"));
  const one = await saveAdminMedia(input, "admin");
  const two = await saveAdminMedia(input, "admin");
  assert.notEqual(one.url, two.url);
  assert.equal(one.sha256, two.sha256);
  assert.equal(one.width, 1);
  const app = new Hono();
  let published = false;
  registerAdminMediaRoutes(app, { catalogStore: { verifyPublishedAsset: () => ({ valid: true, managed: published }) }, audit: () => {} });
  assert.equal((await app.request(one.url)).status, 401);
  const session = createAdminSession({ username: "admin", role: "owner", displayName: "Test" });
  const cookie = session.cookie.split(";")[0];
  assert.equal((await app.request("/api/admin/media")).status, 401);
  assert.equal((await app.request("/api/admin/media", { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await app.request(one.url, { headers: { cookie } })).status, 200);
  const uploaded = await app.request("/api/admin/media", { method: "POST", headers: { cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(uploaded.status, 201);
  const listed = await (await app.request("/api/admin/media", { headers: { cookie } })).json();
  assert.equal(listed.data.items.length, 3);
  published = true;
  const response = await app.request(one.url, { headers: { range: "bytes=0-7" } });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 8);
});

test("admin media accepts a real bounded MP4 and records dimensions/duration", async () => {
  const source = path.join(directory, "sample.mp4");
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x96:r=10", "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { timeout: 15000 });
  const record = await saveAdminMedia({ ...input, dataUrl: `data:video/mp4;base64,${fs.readFileSync(source).toString("base64")}` }, "admin");
  assert.equal(record.kind, "video");
  assert.equal(record.width, 64);
  assert.equal(record.height, 96);
  assert.ok(record.duration > 0 && record.duration < 1);
});

test("admin media rejects forged video headers through actual decoder", async () => {
  const ftyp = Buffer.alloc(16); ftyp.writeUInt32BE(16); ftyp.write("ftyp", 4); ftyp.write("isom", 8);
  const mdat = Buffer.alloc(8); mdat.writeUInt32BE(8); mdat.write("mdat", 4);
  const dataUrl = `data:video/mp4;base64,${Buffer.concat([ftyp, mdat]).toString("base64")}`;
  await assert.rejects(saveAdminMedia({ ...input, dataUrl }, "admin"), /无法解码/);
});
