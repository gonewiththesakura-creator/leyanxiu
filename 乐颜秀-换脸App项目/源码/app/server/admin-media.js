import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeImageDataUrl, decodeVideoDataUrl } from "./media-validation.js";
import { requireAdmin } from "./admin-auth.js";
import { ADMIN_MEDIA_DIR, ADMIN_MEDIA_PREFIX } from "./admin-media-paths.js";
import { adminSnapshot } from "./admin-snapshot.js";

const run = promisify(execFile);
export const ADMIN_MEDIA_MAX_BYTES = 12 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 512 * 1024 * 1024;
const FILE_PATTERN = /^[0-9a-f-]{36}\.(png|jpg|webp|mp4|webm)$/;
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
export function listAdminMedia(directory = ADMIN_MEDIA_DIR) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => FILE_PATTERN.test(name.replace(/\.json$/, "")) && name.endsWith(".json")).flatMap((name) => {
    try { return [JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))]; } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveAdminMedia(input, actor, directory = ADMIN_MEDIA_DIR) {
  if (input.rightsConfirmed !== true || typeof input.rightsReference !== "string" || !input.rightsReference.trim() || input.rightsReference.length > 500) fail("请确认素材使用权并填写授权记录或自有素材说明");
  const name = String(input.name || "素材").trim();
  if (!name || name.length > 120 || /[\\/\x00-\x1f]/.test(name)) fail("素材名称无效（不可含路径）");
  const dataUrl = String(input.dataUrl || "");
  if (dataUrl.length > Math.ceil(ADMIN_MEDIA_MAX_BYTES / 3) * 4 + 100) fail("素材不能超过 12 MiB", 413);
  const kind = dataUrl.startsWith("data:image/") ? "image" : "video";
  const decoded = kind === "image" ? decodeImageDataUrl(dataUrl, { maxBytes: ADMIN_MEDIA_MAX_BYTES }) : decodeVideoDataUrl(dataUrl, { maxBytes: ADMIN_MEDIA_MAX_BYTES });
  if (decoded.ext === ".mov") fail("视频请使用 MP4 或 WebM");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const total = fs.readdirSync(directory).reduce((sum, entry) => sum + fs.statSync(path.join(directory, entry)).size, 0);
  if (total + decoded.buffer.length > MAX_LIBRARY_BYTES) fail("素材库已达到 512 MiB 容量，请联系管理员扩容", 507);
  const id = crypto.randomUUID();
  const filename = `${id}${decoded.ext}`;
  const destination = path.join(directory, filename);
  const temporary = `${destination}.pending`;
  fs.writeFileSync(temporary, decoded.buffer, { flag: "wx", mode: 0o600 });
  try {
    let probe;
    try {
      const result = await run(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", temporary], { timeout: 15_000, maxBuffer: 512 * 1024 });
      probe = JSON.parse(result.stdout);
      await run(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", temporary, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { timeout: 20_000, maxBuffer: 512 * 1024 });
    } catch { fail("媒体无法解码，或校验工具暂不可用，请换用完整图片/视频文件"); }
    const stream = probe.streams?.find((value) => value.codec_type === "video");
    const codecs = kind === "image" ? ["png", "mjpeg", "webp"] : ["h264", "vp8", "vp9", "av1"];
    if (!stream || !codecs.includes(stream.codec_name) || !stream.width || !stream.height || stream.width > 8192 || stream.height > 8192 || stream.width * stream.height > 40_000_000) fail("媒体编码或画面尺寸不受支持");
    const duration = Number(probe.format?.duration || 0);
    if (kind === "video" && (!Number.isFinite(duration) || duration <= 0 || duration > 180)) fail("模板视频时长须在 0–180 秒之间");
    const record = { id, url: `${ADMIN_MEDIA_PREFIX}${filename}`, name, kind, mime: decoded.mime, size: decoded.buffer.length, width: stream.width, height: stream.height, duration: kind === "video" ? duration : null, sha256: crypto.createHash("sha256").update(decoded.buffer).digest("hex"), createdAt: new Date().toISOString(), createdBy: actor, rightsConfirmed: true, rightsReference: input.rightsReference.trim() };
    // Exclusive copy preserves every previously published filename; no overwrite API exists.
    fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
    try { fs.writeFileSync(`${destination}.json`, JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
    catch (error) { fs.rmSync(destination, { force: true }); throw error; }
    return record;
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function registerAdminMediaRoutes(app, { catalogStore, audit }) {
  app.get("/api/admin/media", (c) => {
    const auth = requireAdmin(c); if (auth.response) return auth.response;
    const snapshot = adminSnapshot();
    return c.json({ code: 0, data: { items: listAdminMedia(), maxBytes: ADMIN_MEDIA_MAX_BYTES, storage: { persistent: Boolean(snapshot && !snapshot.failed), note: snapshot ? "闭测单实例 OSS 快照：成功修改已同步，容器启动恢复；正式生产仍需事务数据库和多实例存储" : "素材独立于构建目录；部署环境仍须配置持久卷和备份，不能跨容器保证持久化" } } });
  });
  let uploading = false;
  app.post("/api/admin/media", async (c) => {
    const auth = requireAdmin(c, { roles: ["owner", "operator"], csrf: true }); if (auth.response) return auth.response;
    if (uploading) return c.json({ code: "MEDIA_BUSY", message: "正在校验其他素材，请稍后重试" }, 429);
    uploading = true;
    try {
      const record = await saveAdminMedia(await c.req.json(), auth.session.username);
      audit({ userId: auth.session.username, action: "admin.media_uploaded", resourceType: "admin-media", resourceId: record.id, details: { sha256: record.sha256, size: record.size, rightsReference: record.rightsReference } });
      return c.json({ code: 0, data: record }, 201);
    } catch (error) { return c.json({ code: "MEDIA_UPLOAD_REJECTED", message: error.status || error.code ? error.message : "素材上传失败，请检查文件后重试" }, error.status || 400); }
    finally { uploading = false; }
  });
  app.get(`${ADMIN_MEDIA_PREFIX}:filename`, (c) => {
    const filename = c.req.param("filename");
    if (!FILE_PATTERN.test(filename)) return c.notFound();
    const integrity = catalogStore.verifyPublishedAsset(`${ADMIN_MEDIA_PREFIX}${filename}`);
    if (!integrity.valid) return c.json({ code: "PUBLISHED_ASSET_INTEGRITY_FAILED" }, 503);
    if (!integrity.managed) { const auth = requireAdmin(c); if (auth.response) return auth.response; }
    const file = path.join(ADMIN_MEDIA_DIR, filename);
    if (!fs.existsSync(file) || !fs.existsSync(`${file}.json`)) return c.notFound();
    const record = JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
    const data = fs.readFileSync(file);
    c.header("Content-Type", record.mime); c.header("Cache-Control", "private, no-store"); c.header("Accept-Ranges", "bytes");
    const range = c.req.header("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : -1;
      const end = match?.[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      if (start < 0 || start >= data.length || end < start) { c.header("Content-Range", `bytes */${data.length}`); return c.body(null, 416); }
      c.header("Content-Range", `bytes ${start}-${end}/${data.length}`);
      return c.body(data.subarray(start, end + 1), 206);
    }
    return c.body(data);
  });
}
