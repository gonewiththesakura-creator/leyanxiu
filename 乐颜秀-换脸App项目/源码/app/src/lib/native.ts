import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { FileTransfer } from "@capacitor/file-transfer";
import { Share } from "@capacitor/share";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Browser } from "@capacitor/browser";

export const IS_NATIVE_APP = Capacitor.isNativePlatform();
export const APP_CHANNEL = IS_NATIVE_APP ? "app" : "h5";

interface GalleryMediaStorePlugin {
  save(options: {
    sourceUri: string;
    displayName: string;
    mimeType: string;
    kind: MediaKind;
  }): Promise<{ uri: string; path: string; displayName: string }>;
}

const GalleryMediaStore = registerPlugin<GalleryMediaStorePlugin>("MediaStore");

interface DeviceIdentityPlugin {
  getPublicKey(): Promise<{
    algorithm: "ES256";
    keyId: string;
    publicKeySpki: string;
  }>;
  signChallenge(options: { challenge: string }): Promise<{
    algorithm: "ES256";
    keyId: string;
    signature: string;
    encoding: "base64url-der";
  }>;
}

const NativeDeviceIdentity = registerPlugin<DeviceIdentityPlugin>("DeviceIdentity");

export async function getNativeDevicePublicKey() {
  if (!IS_NATIVE_APP) throw new Error("设备身份仅在 Android App 内可用");
  return NativeDeviceIdentity.getPublicKey();
}

export async function signNativeDeviceChallenge(challenge: string) {
  if (!IS_NATIVE_APP) throw new Error("设备身份仅在 Android App 内可用");
  return NativeDeviceIdentity.signChallenge({ challenge });
}

function validatedExternalHttpsUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("只能打开安全的 HTTPS 链接");
  }
  return parsed.toString();
}

export async function initializeNativeUi() {
  if (!IS_NATIVE_APP) return;
  await Promise.allSettled([
    StatusBar.setOverlaysWebView({ overlay: false }),
    StatusBar.setStyle({ style: Style.Light }),
    StatusBar.setBackgroundColor({ color: "#000000" }),
    Keyboard.setResizeMode({ mode: KeyboardResize.Native }),
  ]);
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[target='_blank']") : null;
    const href = anchor instanceof HTMLAnchorElement ? anchor.href : "";
    if (!anchor) return;
    event.preventDefault();
    if (!href) return;
    try {
      void Browser.open({ url: validatedExternalHttpsUrl(href) });
    } catch (error) {
      console.warn("Blocked unsafe external link", error);
    }
  });
}

export async function openExternalUrl(url: string) {
  const safeUrl = validatedExternalHttpsUrl(url);
  if (IS_NATIVE_APP) {
    await Browser.open({ url: safeUrl });
    return;
  }
  window.open(safeUrl, "_blank", "noopener,noreferrer");
}

export function isNativeCancellation(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /cancel|cancelled|canceled|用户取消/i.test(message);
}

export async function selectNativePhoto(source: "gallery" | "camera") {
  if (!IS_NATIVE_APP) return null;
  const photo = await Camera.getPhoto({
    source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
    resultType: CameraResultType.DataUrl,
    quality: 92,
    width: 2000,
    height: 2000,
    correctOrientation: true,
    allowEditing: false,
    saveToGallery: false,
    promptLabelHeader: "选择照片",
    promptLabelPhoto: "从相册选择",
    promptLabelPicture: "拍一张照片",
    promptLabelCancel: "取消",
  });
  if (!photo.dataUrl) throw new Error("照片读取失败，请重试");
  return photo.dataUrl;
}

type MediaKind = "video" | "image";

const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);

function extensionMatchesKind(extension: string, kind: MediaKind) {
  return kind === "image" ? IMAGE_EXTENSIONS.has(extension) : VIDEO_EXTENSIONS.has(extension);
}

function extensionFromMime(mime: string | undefined, kind: MediaKind) {
  const normalized = String(mime || "").split(";", 1)[0].trim().toLowerCase();
  const extension = MEDIA_EXTENSIONS[normalized];
  return extension && extensionMatchesKind(extension, kind) ? extension : null;
}

function mimeFromExtension(extension: string, kind: MediaKind) {
  const entry = Object.entries(MEDIA_EXTENSIONS).find(([, candidate]) => candidate === extension);
  return entry?.[0] || (kind === "video" ? "video/mp4" : "image/jpeg");
}

function extensionFromSource(url: string, kind: MediaKind) {
  const dataMime = /^data:([^;,]+)/i.exec(url)?.[1];
  const dataExtension = extensionFromMime(dataMime, kind);
  if (dataExtension) return dataExtension;

  try {
    const pathname = new URL(url, "https://localhost").pathname;
    const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
    if (extension && extensionMatchesKind(extension, kind)) return extension === "jpeg" ? "jpg" : extension;
  } catch {
    // A malformed remote URL will fail when the actual download starts.
  }
  return null;
}

function contentTypeHeader(headers: Record<string, string | string[]>) {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  return Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
}

export async function mediaFileExtension(url: string, kind: MediaKind, mimeType?: string, extensionHint?: string) {
  const hintedExtension = String(extensionHint || "").replace(/^\./, "").toLowerCase();
  if (hintedExtension && extensionMatchesKind(hintedExtension, kind)) {
    return hintedExtension === "jpeg" ? "jpg" : hintedExtension;
  }
  const suppliedExtension = extensionFromMime(mimeType, kind);
  if (suppliedExtension) return suppliedExtension;

  const sourceExtension = extensionFromSource(url, kind);
  if (sourceExtension) return sourceExtension;

  if (/^https?:\/\//i.test(url)) {
    try {
      const response = IS_NATIVE_APP
        ? await CapacitorHttp.request({
            url,
            method: "HEAD",
            connectTimeout: 10_000,
            readTimeout: 10_000,
            responseType: "text",
          })
        : await fetch(url, { method: "HEAD" }).then((result) => ({
            status: result.status,
            headers: Object.fromEntries(result.headers.entries()),
          }));
      if (response.status >= 200 && response.status < 400) {
        const headerExtension = extensionFromMime(contentTypeHeader(response.headers), kind);
        if (headerExtension) return headerExtension;
      }
    } catch {
      // Preserve save/share availability when a storage provider rejects HEAD.
    }
  }

  return kind === "video" ? "mp4" : "jpg";
}

export async function mediaFileName(
  name: string,
  kind: MediaKind,
  url: string,
  { mimeType, extensionHint, timestamp = false }: { mimeType?: string; extensionHint?: string; timestamp?: boolean } = {},
) {
  const stem = name.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 48) || "作品";
  const extension = await mediaFileExtension(url, kind, mimeType, extensionHint);
  return `${timestamp ? `${Date.now()}-` : ""}${stem}.${extension}`;
}

async function writeOrDownload(url: string, directory: Directory, path: string) {
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parentPath) {
    try {
      await Filesystem.mkdir({ directory, path: parentPath, recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (!/exist|已存在/i.test(message)) throw error;
    }
  }
  const target = await Filesystem.getUri({ directory, path });
  if (url.startsWith("data:")) {
    const marker = url.indexOf(",");
    if (marker < 0) throw new Error("作品数据格式无效");
    await Filesystem.writeFile({ directory, path, data: url.slice(marker + 1), recursive: true });
  } else {
    await FileTransfer.downloadFile({
      url,
      path: target.uri,
      connectTimeout: 30_000,
      readTimeout: 180_000,
    });
  }
  return (await Filesystem.getUri({ directory, path })).uri;
}

export async function saveNativeMedia(url: string, templateName: string, kind: MediaKind, mimeType?: string, extensionHint?: string) {
  if (!IS_NATIVE_APP) return null;
  const displayName = await mediaFileName(templateName, kind, url, { mimeType, extensionHint, timestamp: true });
  const extension = displayName.slice(displayName.lastIndexOf(".") + 1).toLowerCase();
  const normalizedMimeType = String(mimeType || "").split(";", 1)[0].trim().toLowerCase();
  const mediaMimeType = normalizedMimeType.startsWith(`${kind}/`)
    ? normalizedMimeType
    : mimeFromExtension(extension, kind);
  const temporaryPath = `save/${displayName}`;
  try {
    const sourceUri = await writeOrDownload(url, Directory.Cache, temporaryPath);
    return await GalleryMediaStore.save({
      sourceUri,
      displayName,
      mimeType: mediaMimeType,
      kind,
    });
  } finally {
    await Filesystem.deleteFile({ directory: Directory.Cache, path: temporaryPath }).catch(() => undefined);
  }
}

export async function shareNativeMedia({
  url,
  templateName,
  kind,
  mimeType,
  extensionHint,
  text,
}: {
  url: string;
  templateName: string;
  kind: MediaKind;
  mimeType?: string;
  extensionHint?: string;
  text: string;
}) {
  if (!IS_NATIVE_APP) return false;
  const path = `share/${await mediaFileName(templateName, kind, url, { mimeType, extensionHint, timestamp: true })}`;
  const uri = await writeOrDownload(url, Directory.Cache, path);
  await Share.share({
    title: `乐颜秀 · ${templateName}`,
    text,
    files: [uri],
    dialogTitle: "分享作品",
  });
  return true;
}
