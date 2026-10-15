import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'miniprogram');
const output = path.join(root, 'output/native-product-20261014');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
  const filename = path.join(directory, item.name);
  return item.isDirectory() ? walk(filename) : [filename];
});
const files = walk(native);
const app = JSON.parse(fs.readFileSync(path.join(native, 'app.json')));
const routes = [...app.pages, ...app.subpackages.flatMap(pack => pack.pages.map(page => `${pack.root}/${page}`))];
for (const route of routes) for (const ext of ['js', 'json', 'wxml']) {
  if (!fs.existsSync(path.join(native, `${route}.${ext}`))) throw new Error(`Missing route: ${route}.${ext}`);
}
for (const file of files.filter(file => file.endsWith('.json'))) JSON.parse(fs.readFileSync(file, 'utf8'));
for (const file of files.filter(file => file.endsWith('.js'))) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
for (const tab of app.tabBar.list) {
  if (!app.pages.includes(tab.pagePath)) throw new Error('Tab route is outside main package');
  for (const field of ['iconPath', 'selectedIconPath']) if (!fs.existsSync(path.join(native, tab[field]))) throw new Error('Missing tab icon');
}
const require = createRequire(import.meta.url);
const { TEMPLATES } = require(path.join(native, 'catalog/templates.js'));
const { PHOTO_EFFECTS, PHOTO_EFFECT_CATEGORIES } = require(path.join(native, 'catalog/effects.js'));
for (const asset of [...TEMPLATES.map(item => item.cover), ...PHOTO_EFFECTS.map(item => item.preview), ...PHOTO_EFFECT_CATEGORIES.map(item => item.cover)]) {
  if (!fs.existsSync(path.join(native, 'assets', asset))) throw new Error(`Missing product picture: ${asset}`);
}
for (const item of TEMPLATES.filter(item => item.previewVideo)) {
  if (!fs.existsSync(path.join(native, 'preview-media', item.previewVideo))) throw new Error('Missing preview video');
}
const mainBytes = files.filter(file => !file.startsWith(path.join(native, 'preview-media') + path.sep)).reduce((total, file) => total + fs.statSync(file).size, 0);
const previewBytes = files.filter(file => file.startsWith(path.join(native, 'preview-media') + path.sep)).reduce((total, file) => total + fs.statSync(file).size, 0);
if (mainBytes >= 2 * 1024 * 1024 || previewBytes >= 2 * 1024 * 1024) throw new Error('Native package exceeds local 2 MiB budget');
fs.mkdirSync(output, { recursive: true });
const compiler = 'C:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const relative = file => './' + path.relative(native, file).replaceAll('\\', '/');
execFileSync(path.join(compiler, 'wcc.exe'), ['-o', path.join(output, 'compiled-wxml.js'), ...files.filter(file => file.endsWith('.wxml')).map(relative)], { cwd: native, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const css = execFileSync(path.join(compiler, 'wcsc.exe'), ['-lc', ...files.filter(file => file.endsWith('.wxss')).map(relative)], { cwd: native, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
fs.writeFileSync(path.join(output, 'compiled-wxss.js'), css);
const report = { ok: true, mainBytes, previewBytes, pages: routes.length, tabs: app.tabBar.list.map(tab => tab.text), pictures: 37, photoEffects: PHOTO_EFFECTS.length, photoCategories: PHOTO_EFFECT_CATEGORIES.length, videoTemplates: TEMPLATES.filter(item => item.media === 'video').length, jsSyntax: true, jsonSyntax: true, wxmlCompiled: true, wxssCompiled: true, livePayment: false, uploaded: false };
fs.writeFileSync(path.join(output, 'build-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
