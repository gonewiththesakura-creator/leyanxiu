import fs from "node:fs";
import path from "node:path";

const debuggerPort = Number(process.env.CHROME_DEBUG_PORT || 9223);
const appUrl = process.env.ADMIN_QA_URL || "http://127.0.0.1:8790/admin";
const username = process.env.ADMIN_QA_USERNAME || "admin";
const password = process.env.ADMIN_QA_PASSWORD || "";
const outputDirectory = path.resolve(process.env.ADMIN_QA_OUTPUT || "output/admin-live-preview-qa");
fs.mkdirSync(outputDirectory, { recursive: true });

const targetResponse = await fetch(`http://127.0.0.1:${debuggerPort}/json/new?about:blank`, { method: "PUT" });
if (!targetResponse.ok) throw new Error(`Unable to open Chrome target: ${targetResponse.status}`);
const target = await targetResponse.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const consoleErrors = [];
const requests = [];
let commandId = 0;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result || {});
    return;
  }
  if (message.method === "Network.requestWillBeSent") requests.push({ url: message.params.request.url, method: message.params.request.method });
  if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params?.exceptionDetails?.text || "Runtime exception");
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") consoleErrors.push(message.params.entry.text);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

function send(method, params = {}) {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

async function waitFor(expression, label, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickByText(text, selector = "button") {
  const clicked = await evaluate(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.trim().includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Control not found: ${text}`);
}

async function setField(label, value) {
  return evaluate(`(async () => {
    const fieldLabel = [...document.querySelectorAll('.admin-modal label')].find((item) => item.querySelector(':scope > span')?.textContent.trim() === ${JSON.stringify(label)});
    const field = fieldLabel?.querySelector('input,textarea,select');
    if (!field) throw new Error('Field not found: ' + ${JSON.stringify(label)});
    const original = field.value;
    const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    const started = performance.now();
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (document.querySelector('.live-preview-dock')?.textContent.includes(${JSON.stringify(value)})) return { original, latencyMs: performance.now() - started };
    }
    return { original, latencyMs: null };
  })()`);
}

async function screenshot(name) {
  const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const file = path.join(outputDirectory, name);
  fs.writeFileSync(file, Buffer.from(capture.data, "base64"));
  return file;
}

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Log.enable"), send("Network.enable")]);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: appUrl });
  await waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('.admin-login-shell,.admin-app'))`, "admin shell");

  if (await evaluate(`Boolean(document.querySelector('.admin-login-shell'))`)) {
    if (!password) throw new Error("ADMIN_QA_PASSWORD is required");
    await evaluate(`(() => {
      const fields = [...document.querySelectorAll('input')];
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(fields[0], ${JSON.stringify(username)});
      fields[0].dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(fields[1], ${JSON.stringify(password)});
      fields[1].dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('form').requestSubmit();
    })()`);
    await waitFor(`Boolean(document.querySelector('.admin-app'))`, "authenticated console");
  }
  consoleErrors.length = 0;
  requests.length = 0;

  await clickByText("视频模板");
  await waitFor(`Boolean(document.querySelector('[data-qa="live-preview"]'))`, "live preview dock");
  const listPlayback = await evaluate(`({ videos: document.querySelectorAll('.admin-template-thumb video').length, images: document.querySelectorAll('.admin-template-thumb img').length })`);
  if (listPlayback.videos !== 0 || listPlayback.images === 0) throw new Error(`Template list should suspend video while preview is open: ${JSON.stringify(listPlayback)}`);

  const editorOpened = await evaluate(`(() => { const button = document.querySelector('.admin-table-row button[aria-label^="编辑"]'); button?.click(); return Boolean(button); })()`);
  if (!editorOpened) throw new Error("Template editor trigger is missing");
  await waitFor(`Boolean(document.querySelector('#template-editor-title')) && Boolean(document.querySelector('[data-qa="live-preview"]'))`, "template editor and preview");
  await waitFor(`(() => { const video = document.querySelector('.live-preview-client video'); return Boolean(video && video.muted && !video.paused && video.readyState >= 2); })()`, "muted preview video playback", 20_000);
  const playbackBefore = await evaluate(`(() => { const video = document.querySelector('.live-preview-client video'); return video ? { currentTime: video.currentTime, played: [...Array(video.played.length)].reduce((total, _, index) => total + video.played.end(index) - video.played.start(index), 0) } : null; })()`);
  await delay(700);
  const previewMedia = await evaluate(`(() => { const video = document.querySelector('.live-preview-client video'); return video ? { muted: video.muted, paused: video.paused, readyState: video.readyState, currentTime: video.currentTime, played: [...Array(video.played.length)].reduce((total, _, index) => total + video.played.end(index) - video.played.start(index), 0) } : null; })()`);
  if (!previewMedia?.muted) throw new Error(`Admin preview media must start muted: ${JSON.stringify(previewMedia)}`);
  if (previewMedia.paused || previewMedia.readyState < 2 || previewMedia.played <= Math.max(0.05, playbackBefore?.played || 0)) {
    throw new Error(`Admin preview video did not make playback progress: ${JSON.stringify({ playbackBefore, previewMedia })}`);
  }
  const originalName = await evaluate(`document.querySelector('.admin-modal label input')?.value`);
  const changedName = `${originalName}预览`;
  const nameEdit = await setField("名称", changedName);
  if (nameEdit.latencyMs === null || nameEdit.latencyMs > 150) throw new Error(`Preview latency exceeded 150ms: ${JSON.stringify(nameEdit)}`);
  await waitFor(`document.querySelector('[data-qa="live-preview"]')?.dataset.previewState === 'editing'`, "editing state");
  await waitFor(`document.querySelector('.live-preview-validation')?.classList.contains('is-valid')`, "valid transient catalog");

  const sideEffectRequestIndex = requests.length;
  const blockedAction = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.live-preview-client button')].find((item) => /用我的照片|让照片/.test(item.textContent || ''));
    button?.click();
    return Boolean(button);
  })()`);
  if (!blockedAction) throw new Error("Preview action button is missing");
  await waitFor(`Boolean(document.querySelector('.live-preview-safety-toast'))`, "side-effect block notice");

  const externalMarker = "https://example.com/admin-preview-tracker.webp";
  const coverEdit = await setField("封面路径", externalMarker);
  await waitFor(`document.querySelector('[data-qa="live-preview"]')?.dataset.assetState === 'error'`, "unsafe asset state");
  await waitFor(`document.querySelector('.live-preview-validation')?.classList.contains('is-invalid')`, "unsafe asset validation");
  if (requests.some((item) => item.url.startsWith(externalMarker))) throw new Error("Unsafe external preview URL was requested");
  await setField("封面路径", coverEdit.original);
  await setField("名称", originalName);
  await waitFor(`document.querySelector('.live-preview-validation')?.classList.contains('is-valid')`, "restored valid catalog");
  // Chrome logs the intentionally rejected validation request as a generic 400 resource error.
  consoleErrors.length = 0;

  await clickByText("iPhone 模拟", ".live-preview-dock button");
  await waitFor(`document.querySelector('[data-qa="live-preview"]')?.dataset.platform === 'iphone'`, "iPhone layout simulation");
  await clickByText("线上 v", ".live-preview-dock button");
  await waitFor(`document.querySelector('[data-qa="live-preview"]')?.dataset.previewState === 'published'`, "published source preview");
  const desktopScreenshot = await screenshot("admin-live-preview-desktop.png");

  await clickByText("当前草稿", ".live-preview-dock button");
  await evaluate(`window.confirm = () => true; document.querySelector('button[aria-label="关闭模板编辑"]')?.click()`);
  await waitFor(`!document.querySelector('#template-editor-title')`, "template editor close");

  await clickByText("图片效果");
  await waitFor(`document.querySelectorAll('.admin-effect-card img').length > 0`, "photo cards");
  const photoEditorOpened = await evaluate(`(() => { const button = document.querySelector('.admin-effect-card'); button?.click(); return Boolean(button); })()`);
  if (!photoEditorOpened) throw new Error("Photo effect editor trigger is missing");
  await waitFor(`Boolean(document.querySelector('#effect-editor-title')) && document.querySelector('.live-preview-dock')?.textContent.includes('百变图片')`, "photo effect live preview");
  const photoOriginal = await evaluate(`document.querySelector('.admin-modal label input')?.value`);
  const photoEdit = await setField("名称", `${photoOriginal}验收`);
  if (photoEdit.latencyMs === null || photoEdit.latencyMs > 150) throw new Error(`Photo preview latency exceeded 150ms: ${JSON.stringify(photoEdit)}`);
  await setField("名称", photoOriginal);
  await evaluate(`window.confirm = () => true; document.querySelector('button[aria-label="关闭图片效果编辑"]')?.click()`);

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await delay(300);
  const mobile = await evaluate(`(() => {
    const dock = document.querySelector('.live-preview-dock')?.getBoundingClientRect();
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, dock: dock && { left: dock.left, right: dock.right, width: dock.width }, platform: document.querySelector('[data-qa="live-preview"]')?.dataset.platform };
  })()`);
  if (mobile.scrollWidth > mobile.width || !mobile.dock || mobile.dock.left < -1 || mobile.dock.right > mobile.width + 1) throw new Error(`Mobile preview layout failed: ${JSON.stringify(mobile)}`);
  const mobileScreenshot = await screenshot("admin-live-preview-mobile.png");

  const appOrigin = new URL(appUrl).origin;
  const allowedAssetPrefixes = ["/assets/", "/templates/", "/effects/", "/banners/", "/plays/", "/avatars/"];
  const unexpectedRequests = requests.slice(sideEffectRequestIndex).filter((item) => {
    let parsed;
    try { parsed = new URL(item.url); } catch { return true; }
    if (parsed.origin !== appOrigin) return true;
    if (item.method === "POST" && parsed.pathname === "/api/admin/catalog/validate") return false;
    if ((item.method === "GET" || item.method === "HEAD") && allowedAssetPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) return false;
    return true;
  });
  if (unexpectedRequests.length) throw new Error(`Preview caused a request outside the strict allowlist: ${JSON.stringify(unexpectedRequests)}`);
  if (consoleErrors.length) throw new Error(`Browser console errors: ${JSON.stringify(consoleErrors)}`);

  const report = {
    ok: true,
    url: appUrl,
    templatePreviewLatencyMs: Math.round(nameEdit.latencyMs),
    photoPreviewLatencyMs: Math.round(photoEdit.latencyMs),
    validationRequests: requests.filter((item) => item.url.includes("/api/admin/catalog/validate")).length,
    allowedRequestPolicy: { post: ["/api/admin/catalog/validate"], getPrefixes: allowedAssetPrefixes },
    unexpectedRequests,
    externalPreviewRequests: requests.filter((item) => item.url.startsWith("https://example.com/admin-preview-tracker")),
    listPlayback,
    previewMedia,
    mobile,
    screenshots: [desktopScreenshot, mobileScreenshot],
    consoleErrors,
  };
  fs.writeFileSync(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  try { await send("Page.close"); } catch { /* best effort */ }
  socket.close();
}
