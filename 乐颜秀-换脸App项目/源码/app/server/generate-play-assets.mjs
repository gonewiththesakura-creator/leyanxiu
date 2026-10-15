import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./providers/bailian.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../public/plays");
fs.mkdirSync(outDir, { recursive: true });

const shared = [
  "Use case: stylized-concept",
  "Asset type: premium vertical mobile app feature card",
  "Style/medium: cinematic editorial still life, realistic materials, refined Apple-like product photography",
  "Composition/framing: vertical 3:4 composition, clear central subject, safe margins for UI overlays",
  "Lighting/mood: soft controlled studio light, elegant and optimistic",
  "Constraints: no text, no letters, no numbers, no logos, no trademarks, no watermark",
  "Avoid: fortune-teller stereotypes, horror, clutter, gaudy neon, excessive gold decoration",
].join("\n");

const assets = [
  {
    file: "future-wife.png",
    prompt: `${shared}\nPrimary request: a delicate red silk thread connecting two elegant blank name seals, subtle pair of human silhouettes softly out of focus in the background\nColor palette: deep red, porcelain white, charcoal, restrained gold accents\nMaterials/textures: silk thread, embossed paper, frosted glass`,
  },
  {
    file: "wealth.png",
    prompt: `${shared}\nPrimary request: a refined arrangement suggesting steady prosperity: one warm brass coin, a green jade pebble and a closed dark leather savings book on a clean table\nColor palette: charcoal, jade green, warm brass, white\nMaterials/textures: brushed brass, natural jade, fine leather, matte stone`,
  },
  {
    file: "wuxing.png",
    prompt: `${shared}\nPrimary request: five natural materials arranged in a balanced circular composition representing wood, fire, earth, metal and water without symbols or labels\nColor palette: natural green, ember red, clay, silver, deep blue\nMaterials/textures: leaf and wood grain, small controlled flame, clay, brushed metal, clear water`,
  },
  {
    file: "daily-fortune.png",
    prompt: `${shared}\nPrimary request: calm morning sunlight crossing a traditional Chinese wooden window onto a clean desk with an unopened almanac-style book and a porcelain tea cup\nColor palette: daylight white, ink black, muted vermilion, natural wood\nMaterials/textures: paper, porcelain, wood grain, soft linen`,
  },
  {
    file: "character.png",
    prompt: `${shared}\nPrimary request: an ink brush hovering above pristine rice paper with one abstract fresh ink stroke, a small ink stone beside it\nColor palette: ink black, paper white, muted cinnabar accent\nMaterials/textures: wet ink, rice paper fibers, dark stone, bamboo brush`,
  },
];

for (const asset of assets) {
  const outPath = path.join(outDir, asset.file);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
    console.log(`skip ${asset.file}`);
    continue;
  }
  console.log(`generate ${asset.file}`);
  const result = await generate({
    images: [],
    text: asset.prompt,
    model: "qwen-image-3.0-pro",
    size: "1024*1536",
  });
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`download ${asset.file} failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  console.log(`saved ${asset.file} ${buffer.length} bytes request=${result.requestId}`);
}
