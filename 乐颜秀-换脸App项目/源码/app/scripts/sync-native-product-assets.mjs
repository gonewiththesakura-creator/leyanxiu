import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Build derived native assets from the authoritative product catalog. Originals
// remain untouched. Preview movies live in a subpackage to keep the main small.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'miniprogram');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const icons = require('lucide-react');
const sharp = process.env.NATIVE_NODE_MODULES
  ? require(path.join(process.env.NATIVE_NODE_MODULES, 'sharp')) : require('sharp');
fs.mkdirSync(path.join(native, 'catalog'), { recursive: true });
for (const name of ['templates', 'effects']) {
  const source = fs.readFileSync(path.join(root, 'src/data', `${name}.ts`), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
  fs.writeFileSync(path.join(native, 'catalog', `${name}.js`), '// Generated from src/data; run scripts/sync-native-product-assets.mjs.\n' + output);
}
const { TEMPLATES, SAMPLE_AVATARS } = require(path.join(native, 'catalog/templates.js'));
const { PHOTO_EFFECT_CATEGORIES, PHOTO_EFFECTS } = require(path.join(native, 'catalog/effects.js'));
const songs = fs.readFileSync(path.join(root, 'src/views/Songs.tsx'), 'utf8');
const banners = [...songs.matchAll(/["'](\/banners\/[^"']+)["']/g)].map(match => match[1]);
const pictures = new Set([...TEMPLATES.map(item => item.cover), ...SAMPLE_AVATARS,
  ...PHOTO_EFFECT_CATEGORIES.map(item => item.cover), ...PHOTO_EFFECTS.map(item => item.preview), ...banners]);
const copy = (asset, base) => {
  if (!/^\/(templates|avatars|effects|banners)\/[a-z0-9/_.-]+$/.test(asset) || asset.includes('..')) throw new Error('Unexpected catalog asset');
  const dest = path.join(native, base, asset);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, 'public', asset), dest);
};
for (const asset of pictures) copy(asset, 'assets');
for (const template of TEMPLATES.filter(item => item.previewVideo)) copy(template.previewVideo, 'preview-media');
const tabIcons = ['Trophy', 'Music2', 'ThumbsUp', 'WandSparkles', 'UserRound'];
fs.mkdirSync(path.join(native, 'assets/nav'), { recursive: true });
for (const [index, name] of tabIcons.entries()) {
  for (const [state, color] of [['normal', '#929295'], ['active', '#f23bd1']]) {
    const svg = renderToStaticMarkup(React.createElement(icons[name], { size: 48, color, strokeWidth: 1.7 }));
    await sharp(Buffer.from(svg)).png().toFile(path.join(native, 'assets/nav', `${index}-${state}.png`));
  }
}
const sum = directory => fs.readdirSync(directory, { withFileTypes: true }).reduce((total, item) => {
  const file = path.join(directory, item.name);
  return total + (item.isDirectory() ? sum(file) : fs.statSync(file).size);
}, 0);
console.log(JSON.stringify({ pictures: pictures.size, assetBytes: sum(path.join(native, 'assets')), previewBytes: sum(path.join(native, 'preview-media')) }));
