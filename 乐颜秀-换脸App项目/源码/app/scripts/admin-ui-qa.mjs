import fs from "node:fs";
import path from "node:path";

const debuggerPort = Number(process.env.CHROME_DEBUG_PORT || 9223);
const appUrl = process.env.ADMIN_QA_URL || "http://127.0.0.1:8790/admin";
const username = process.env.ADMIN_QA_USERNAME || "admin";
const password = process.env.ADMIN_QA_PASSWORD || "";
const outputDirectory = path.resolve(process.env.ADMIN_QA_OUTPUT || "output/qa");
fs.mkdirSync(outputDirectory, { recursive: true });

const targetResponse = await fetch(`http://127.0.0.1:${debuggerPort}/json/new?about:blank`, { method: "PUT" });
if (!targetResponse.ok) throw new Error(`Unable to open Chrome target: ${targetResponse.status}`);
const target = await targetResponse.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const consoleErrors = [];
let commandId = 0;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
    return;
  }
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

async function waitFor(expression, label, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickByText(text) {
  const clicked = await evaluate(`(() => {
    const target = [...document.querySelectorAll("button")].find((item) => item.textContent.trim().includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Button not found: ${text}`);
  await delay(250);
}

async function screenshot(name) {
  const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const file = path.join(outputDirectory, name);
  fs.writeFileSync(file, Buffer.from(capture.data, "base64"));
  return file;
}

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Log.enable")]);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: appUrl });
  await waitFor(`document.readyState === "complete"`, "admin page load");
  await waitFor(`Boolean(document.querySelector(".admin-login-shell, .admin-app"))`, "admin shell");

  if (await evaluate(`Boolean(document.querySelector(".admin-login-shell"))`)) {
    if (!password) throw new Error("ADMIN_QA_PASSWORD is required for login QA");
    await evaluate(`(() => {
      const fields = [...document.querySelectorAll("input")];
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(fields[0], ${JSON.stringify(username)});
      fields[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(fields[1], ${JSON.stringify(password)});
      fields[1].dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("form").requestSubmit();
    })()`);
    await waitFor(`Boolean(document.querySelector(".admin-app"))`, "authenticated admin console");
  }
  // The initial anonymous /api/admin/me 401 and browser CSP meta warning are expected.
  consoleErrors.length = 0;

  const desktop = await evaluate(`({
    title: document.title,
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    nav: [...document.querySelectorAll(".admin-sidebar nav button")].map((item) => item.textContent.trim()),
    heading: document.querySelector(".admin-topbar h1")?.textContent || ""
  })`);
  if (desktop.scrollWidth > desktop.width) throw new Error(`Desktop horizontal overflow: ${desktop.scrollWidth}/${desktop.width}`);

  await clickByText("视频模板");
  await waitFor(`Boolean(document.querySelector('[data-qa="live-preview"]'))`, "live preview dock");
  const suspendedList = await evaluate(`({ videos: document.querySelectorAll('.admin-template-thumb video').length, images: document.querySelectorAll('.admin-template-thumb img').length })`);
  if (suspendedList.videos !== 0 || suspendedList.images === 0) throw new Error(`Video list was not suspended while live preview is active: ${JSON.stringify(suspendedList)}`);
  await evaluate(`document.querySelector('button[aria-label="关闭实时预览"]')?.click()`);
  await waitFor(`!document.querySelector('[data-qa="live-preview"]')`, "live preview close");
  await waitFor(`document.querySelectorAll(".admin-template-thumb video").length > 0`, "video template previews");
  const initialTimes = await evaluate(`[...document.querySelectorAll(".admin-template-thumb video")].map((video) => video.currentTime)`);
  await delay(900);
  const videoState = await evaluate(`(() => {
    const videos = [...document.querySelectorAll(".admin-template-thumb video")];
    return videos.map((video, index) => ({ readyState: video.readyState, muted: video.muted, paused: video.paused, advanced: video.currentTime > ${JSON.stringify(initialTimes)}[index] }));
  })()`);
  if (videoState.some((video) => video.readyState < 2 || !video.muted || video.paused || !video.advanced)) throw new Error(`Video preview QA failed: ${JSON.stringify(videoState)}`);

  await clickByText("图片效果");
  await waitFor(`Boolean(document.querySelector('[data-qa="live-preview"]'))`, "photo live preview");
  await waitFor(`document.querySelectorAll(".admin-effect-card img").length > 0`, "photo effect cards");
  const photoAssets = await evaluate(`[...document.querySelectorAll(".admin-effect-card img")].map((image) => ({ src: image.getAttribute("src"), loaded: image.complete && image.naturalWidth > 0 }))`);
  if (photoAssets.some((asset) => !asset.loaded)) throw new Error(`Photo preview asset failed: ${JSON.stringify(photoAssets.filter((asset) => !asset.loaded))}`);
  const categoryEditorOpened = await evaluate(`(() => { const button = document.querySelector('.admin-category-actions button[aria-label^="编辑"]'); if (!button) return false; button.click(); return true; })()`);
  if (!categoryEditorOpened) throw new Error("Category editor button is missing");
  await waitFor(`Boolean(document.querySelector("#category-editor-title"))`, "category editor");
  await waitFor(`document.querySelector('[data-qa="live-preview"]')?.dataset.assetState === 'ready'`, "category preview asset");
  const categoryImageLoaded = await evaluate(`document.querySelector('[data-qa="live-preview"]')?.dataset.assetState === 'ready'`);
  if (!categoryImageLoaded) throw new Error("Category preview image did not load");
  await evaluate(`document.querySelector('button[aria-label="关闭图片分类编辑"]').click()`);
  await evaluate(`document.querySelector('button[aria-label="关闭实时预览"]')?.click()`);

  await clickByText("数据趋势");
  await waitFor(`document.body.textContent.includes("各功能调用表现")`, "analytics page");
  await screenshot("admin-analytics-desktop.png");

  await clickByText("服务监控");
  await waitFor(`document.body.textContent.includes("请求量与 5xx 曲线")`, "monitoring page");
  const monitoring = await evaluate(`({ incidents: document.body.textContent.includes("活跃事件"), overflow: document.documentElement.scrollWidth > innerWidth })`);
  if (!monitoring.incidents || monitoring.overflow) throw new Error(`Monitoring page QA failed: ${JSON.stringify(monitoring)}`);

  await clickByText("风险应对");
  await waitFor(`document.body.textContent.includes("固定应急预案")`, "risk page");
  const riskCopy = await evaluate(`({ impact: document.body.textContent.includes("影响"), solution: document.body.textContent.includes("解决办法"), prevention: document.body.textContent.includes("预防") })`);
  if (!riskCopy.impact || !riskCopy.solution || !riskCopy.prevention) throw new Error(`Risk copy QA failed: ${JSON.stringify(riskCopy)}`);

  await clickByText("能力接入");
  await waitFor(`document.body.textContent.includes("新建接入需求") || document.body.textContent.includes("暂无接入需求")`, "workflow page");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await delay(300);
  const mobile = await evaluate(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, menu: Boolean(document.querySelector(".admin-mobile-menu")) })`);
  if (mobile.scrollWidth > mobile.width || !mobile.menu) throw new Error(`Mobile layout QA failed: ${JSON.stringify(mobile)}`);
  await screenshot("admin-workflow-mobile.png");

  const report = {
    ok: true,
    url: appUrl,
    desktop,
    videoPreviews: videoState.length,
    photoPreviews: photoAssets.length,
    monitoring,
    riskCopy,
    mobile,
    screenshots: [path.join(outputDirectory, "admin-analytics-desktop.png"), path.join(outputDirectory, "admin-workflow-mobile.png")],
    consoleErrors,
  };
  fs.writeFileSync(path.join(outputDirectory, "admin-ui-qa.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (consoleErrors.length) process.exitCode = 1;
} finally {
  try { await send("Page.close"); } catch { /* best effort */ }
  socket.close();
}
