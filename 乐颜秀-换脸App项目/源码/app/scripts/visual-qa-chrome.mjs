import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const targetUrl = process.env.QA_URL || "http://127.0.0.1:3000/";
const outputDir = path.resolve(process.env.QA_OUTPUT_DIR || "output/visual-qa");
const port = Number(process.env.QA_CDP_PORT || 9339);
const profileDir = path.join("C:\\CodexBuildCaches", `leyanxiu-chrome-qa-${process.pid}`);

if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`);
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--disable-background-networking",
  "--no-first-run",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { windowsHide: true, stdio: "ignore" });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error("Chrome DevTools endpoint unavailable");
}

let socket;
const pending = new Map();
let sequence = 0;

function command(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

async function screenshot(name) {
  const result = await command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const file = path.join(outputDir, name);
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
  return file;
}

async function waitForApp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await evaluate("Boolean(document.querySelector('#root')?.children.length)");
    if (ready) return;
    await delay(100);
  }
  throw new Error("App did not render");
}

async function setViewport(width, height) {
  await command("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: width,
    screenHeight: height,
  });
}

async function layoutSnapshot(name) {
  return evaluate(`(() => {
    const rect = (element) => element ? (() => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
    })() : null;
    const visible = (element) => element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0;
    const insideHorizontalScroller = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (['auto', 'scroll'].includes(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return true;
      }
      return false;
    };
    const overflowing = [...document.querySelectorAll('main,section,article,header,nav,button,p,h1,h2,h3')]
      .filter(visible)
      .filter((element) => !insideHorizontalScroller(element))
      .filter((element) => element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1)
      .slice(0, 20)
      .map((element) => ({ tag: element.tagName, text: (element.textContent || '').trim().slice(0, 60), rect: rect(element) }));
    const activeVideo = [...document.querySelectorAll('video')].find(visible);
    return {
      name: ${JSON.stringify(name)},
      viewport: { width: innerWidth, height: innerHeight },
      document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
      body: rect(document.body),
      dialog: rect(document.querySelector('[role="dialog"]')),
      tabBar: rect(document.querySelector('.tab-bar')),
      overflowing,
      video: activeVideo ? {
        paused: activeVideo.paused,
        muted: activeVideo.muted,
        readyState: activeVideo.readyState,
        currentTime: activeVideo.currentTime,
        error: activeVideo.error?.code || null,
      } : null,
    };
  })()`);
}

try {
  const page = (await fetchJson(`http://127.0.0.1:${port}/json/list`)).find((item) => item.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("No Chrome page target");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  await command("Page.enable");
  await command("Runtime.enable");
  await setViewport(360, 800);
  await command("Page.navigate", { url: targetUrl });
  await waitForApp();
  await delay(500);

  const report = [];
  report.push(await layoutSnapshot("privacy-360x800"));
  await screenshot("privacy-360x800.png");

  await setViewport(390, 844);
  await delay(300);
  report.push(await layoutSnapshot("privacy-390x844"));
  await screenshot("privacy-390x844.png");

  await evaluate(`localStorage.setItem('lyx_privacy_acceptance_v1', JSON.stringify({ version: '2026-09-05', acceptedAt: new Date().toISOString(), adultAttested: true })); location.reload(); true`);
  await waitForApp();
  await delay(2200);
  report.push(await layoutSnapshot("featured-390x844"));
  await screenshot("featured-390x844.png");

  const feedInteraction = await evaluate(`(async () => {
    const feed = document.querySelector('.featured-feed');
    if (!feed) throw new Error('Featured feed not found');
    const before = feed.getAttribute('aria-label');
    feed.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    feed.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 750));
    return { before, after: feed.getAttribute('aria-label') };
  })()`);
  report.push({ name: "featured-single-step", ...feedInteraction });

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.featured-card button')].find((item) => /让照片/.test(item.textContent || ''));
    if (!button) throw new Error('Featured creation button not found');
    button.click();
    return true;
  })()`);
  await delay(1600);
  report.push(await layoutSnapshot("video-create-390x844"));
  await screenshot("video-create-390x844.png");

  await evaluate(`(() => {
    const back = document.querySelector('button[aria-label="返回"]');
    if (!back) throw new Error('Back button not found');
    back.click();
    return true;
  })()`);
  await delay(500);

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('百变图片'));
    if (!button) throw new Error('Photo tab not found');
    button.click();
    return true;
  })()`);
  await delay(1400);
  report.push(await layoutSnapshot("photos-390x844"));
  await screenshot("photos-390x844.png");

  await setViewport(430, 932);
  await delay(400);
  report.push(await layoutSnapshot("photos-430x932"));
  await screenshot("photos-430x932.png");

  fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  const layoutEntries = report.filter((entry) => entry.document && entry.viewport);
  const failed = layoutEntries.filter((entry) => entry.document.scrollWidth > entry.viewport.width + 1 || entry.overflowing.length > 0);
  console.log(JSON.stringify({ screenshots: layoutEntries.length, failedLayouts: failed.map((entry) => entry.name), report }, null, 2));
  if (failed.length) process.exitCode = 2;
} finally {
  for (const waiter of pending.values()) waiter.reject(new Error("Chrome connection closed"));
  socket?.close();
  chrome.kill();
}
