import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeRoot = "C:/Users/REDACTED_USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const artifactToolUrl = pathToFileURL(
  path.join(runtimeRoot, "@oai/artifact-tool/dist/artifact_tool.mjs"),
).href;
const canvasUrl = pathToFileURL(
  path.join(runtimeRoot, "@oai/artifact-tool/node_modules/skia-canvas/lib/index.js"),
).href;

const { DocumentFile, drawDocumentToCtx } = await import(artifactToolUrl);
const { Canvas } = await import(canvasUrl);

const [docxPath, outputDir] = process.argv.slice(2);
if (!docxPath || !outputDir) {
  throw new Error("Usage: node _render_docx_artifact_tool.mjs <docx> <output-dir>");
}

fs.mkdirSync(outputDir, { recursive: true });
for (const name of fs.readdirSync(outputDir)) {
  if (/^page-\d+\.png$/.test(name)) {
    fs.unlinkSync(path.join(outputDir, name));
  }
}
const documentModel = await DocumentFile.importDocx(fs.readFileSync(docxPath));

const probe = new Canvas(816, 1056);
const probeResult = drawDocumentToCtx(documentModel, probe.getContext("2d"), {
  pageIndex: 0,
  drawPageOutline: false,
});

for (let pageIndex = 0; pageIndex < probeResult.pages.length; pageIndex += 1) {
  const page = probeResult.pages[pageIndex];
  const width = Math.ceil(page.width ?? 816);
  const height = Math.ceil(page.height ?? 1056);
  const canvas = new Canvas(width, height);
  drawDocumentToCtx(documentModel, canvas.getContext("2d"), {
    pageIndex,
    drawPageOutline: false,
  });
  const outputPath = path.join(outputDir, `page-${String(pageIndex + 1).padStart(2, "0")}.png`);
  await canvas.saveAs(outputPath);
}

console.log(JSON.stringify({ pages: probeResult.pages.length, outputDir }, null, 2));
