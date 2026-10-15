import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'output/native-product-20261014');
const require = createRequire(import.meta.url);
const sharp = process.env.NATIVE_NODE_MODULES ? require(path.join(process.env.NATIVE_NODE_MODULES, 'sharp')) : require('sharp');
const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-check.json')));
const build = JSON.parse(fs.readFileSync(path.join(directory, 'build-check.json')));
if (!runtime.ok || !build.ok) throw new Error('Only verified build/runtime screenshots can be packaged for review');
const pages = [['home','推荐'],['songs','视频玩法'],['featured','精选'],['photos','百变图片'],['mine','我的']];
const overlays = [];
const width = 1880;
for (const [index, [name, label]] of pages.entries()) {
  overlays.push({ input: await sharp(path.join(directory, `${name}.png`)).resize({ width: 350 }).png().toBuffer(), left: 25 + index * 370, top: 160 });
  overlays.push({ input: Buffer.from(`<svg width="350" height="42"><text x="175" y="30" text-anchor="middle" fill="white" font-size="26" font-family="Microsoft YaHei">${label}</text></svg>`), left: 25 + index * 370, top: 111 });
}
const heading = Buffer.from(`<svg width="${width}" height="110"><text x="28" y="43" fill="#f23bd1" font-size="32" font-family="Microsoft YaHei">乐颜秀 · 原版五栏目原生适配</text><text x="28" y="82" fill="#babac1" font-size="21" font-family="Microsoft YaHei">微信开发者工具实际截图 · 本地候选，尚未提审发布 · 2026-10-14</text></svg>`);
await sharp({ create: { width, height: 965, channels: 3, background: '#101014' } }).composite([{ input: heading, top: 0, left: 0 }, ...overlays]).png().toFile(path.join(directory, 'original-product-review.png'));
const cards = pages.map(([name,label])=>`<figure><figcaption>${label}</figcaption><a href="${name}.png"><img src="${name}.png" alt="${label}：微信开发者工具实际截图"></a></figure>`).join('');
fs.writeFileSync(path.join(directory, 'review.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>乐颜秀原版五栏目验收</title><style>body{margin:0;padding:32px;background:#101014;color:#eee;font:16px/1.7 system-ui}h1{color:#f23bd1;font-size:30px;margin:0}p{color:#babac1;max-width:1000px}main{display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:20px}figure{margin:0}figcaption{text-align:center;font-size:20px;margin:15px 0}img{width:100%;height:auto;border-radius:22px}a{color:#79e2cf}@media(max-width:900px){main{grid-template-columns:repeat(2,minmax(140px,1fr))}}</style><h1>乐颜秀 · 原版五栏目原生适配</h1><p>微信开发者工具实际截图。原版黑粉配色、37张图片、17个图片效果目录、4个视频模板均保留；4段预览已验证实际播放。当前为本地候选，尚未上传、提审或正式发布。目录恢复不代表全部制作能力已接通。</p><main>${cards}</main><p>点击图片查看原尺寸。<a href="runtime-check.json">模拟器验收记录</a> · <a href="build-check.json">原生编译结果</a></p></html>`, 'utf8');
console.log(JSON.stringify({ review: path.join(directory, 'review.html'), contactSheet: path.join(directory, 'original-product-review.png') }));
