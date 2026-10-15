const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function strictBase64(value, maxBytes) {
  const payload = String(value || "");
  if (!payload || payload.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    fail("INVALID_BASE64", "Base64 数据无效");
  }
  const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
  const buffer = Buffer.from(padded, "base64");
  if (!buffer.length || buffer.length > maxBytes || buffer.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) {
    fail(buffer.length > maxBytes ? "MEDIA_TOO_LARGE" : "INVALID_BASE64", buffer.length > maxBytes ? "媒体文件超过大小限制" : "Base64 数据无效");
  }
  return buffer;
}

function pngInfo(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR" || buffer.toString("ascii", buffer.length - 8, buffer.length - 4) !== "IEND") return null;
  return { mime: "image/png", ext: ".png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegInfo(buffer) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sof.has(marker) && length >= 7) {
      return { mime: "image/jpeg", ext: ".jpg", width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpInfo(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const kind = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + length > buffer.length) return null;
    if (kind === "VP8X" && length >= 10) {
      const width = 1 + buffer.readUIntLE(data + 4, 3);
      const height = 1 + buffer.readUIntLE(data + 7, 3);
      return { mime: "image/webp", ext: ".webp", width, height };
    }
    if (kind === "VP8L" && length >= 5 && buffer[data] === 0x2f) {
      const bits = buffer.readUInt32LE(data + 1);
      return { mime: "image/webp", ext: ".webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 " && length >= 10 && buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a) {
      return { mime: "image/webp", ext: ".webp", width: buffer.readUInt16LE(data + 6) & 0x3fff, height: buffer.readUInt16LE(data + 8) & 0x3fff };
    }
    offset = data + length + (length % 2);
  }
  return null;
}

function inspectImage(buffer) {
  return pngInfo(buffer) || jpegInfo(buffer) || webpInfo(buffer);
}

function inspectVideo(buffer, declaredMime) {
  if (buffer.length >= 24 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const ftypSize = buffer.readUInt32BE(0);
    if (ftypSize < 16 || ftypSize > buffer.length || (!buffer.includes(Buffer.from("mdat")) && !buffer.includes(Buffer.from("moov")) && !buffer.includes(Buffer.from("moof")))) return null;
    const brand = buffer.toString("ascii", 8, 12);
    const quicktime = brand === "qt  ";
    if (declaredMime === "video/webm") return null;
    if (declaredMime === "video/mp4" && quicktime) return null;
    return { mime: quicktime ? "video/quicktime" : declaredMime, ext: quicktime ? ".mov" : ".mp4", container: "iso-bmff", brand };
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return declaredMime === "video/webm" ? { mime: "video/webm", ext: ".webm", container: "webm" } : null;
  }
  return null;
}

function validateDimensions(info, { maxSide, maxPixels }) {
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1) fail("INVALID_IMAGE", "图片尺寸无效");
  if (info.width > maxSide || info.height > maxSide || info.width * info.height > maxPixels) fail("IMAGE_DIMENSIONS_TOO_LARGE", "图片像素尺寸超过限制");
}

export function decodeImageDataUrl(value, {
  maxBytes = boundedNumber(process.env.MAX_IMAGE_BYTES, 10 * 1024 * 1024, 1024, 32 * 1024 * 1024),
  maxSide = boundedNumber(process.env.MAX_IMAGE_SIDE, 8192, 64, 16_384),
  maxPixels = boundedNumber(process.env.MAX_IMAGE_PIXELS, 40_000_000, 4096, 100_000_000),
} = {}) {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(value || ""));
  if (!match) fail("INVALID_IMAGE", "仅支持 JPEG、PNG 或 WebP 图片");
  const declaredMime = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  if (!IMAGE_TYPES.has(declaredMime)) fail("INVALID_IMAGE", "图片类型不受支持");
  const buffer = strictBase64(match[2], maxBytes);
  const info = inspectImage(buffer);
  if (!info || info.mime !== declaredMime) fail("MEDIA_TYPE_MISMATCH", "图片内容与声明类型不一致");
  validateDimensions(info, { maxSide, maxPixels });
  return { buffer, ...info };
}

export function decodeVideoDataUrl(value, { maxBytes = boundedNumber(process.env.MAX_VIDEO_BYTES, 100 * 1024 * 1024, 1024, 150 * 1024 * 1024) } = {}) {
  const match = /^data:(video\/(?:mp4|quicktime|webm));base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(value || ""));
  if (!match || !VIDEO_TYPES.has(match?.[1])) fail("INVALID_VIDEO", "仅支持 MP4、MOV 或 WebM 视频");
  const buffer = strictBase64(match[2], maxBytes);
  if (buffer.length < 24) fail("INVALID_VIDEO", "视频容器不完整");
  const info = inspectVideo(buffer, match[1]);
  if (!info) fail("MEDIA_TYPE_MISMATCH", "视频内容与声明类型不一致");
  return { buffer, ...info };
}
