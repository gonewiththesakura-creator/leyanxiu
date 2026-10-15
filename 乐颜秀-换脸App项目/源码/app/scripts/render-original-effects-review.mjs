import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { originalEffectIds, originalEffectsInput, getOriginalEffectProfile } from '../server/photo-jobs/original-effect-batch.js';
import { photoAcceptanceDigest } from '../server/photo-jobs/generation-acceptance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '../../..');
const directory = path.join(root, 'output/original-effects-20261015');
const evidence = path.join(root, 'server/evidence');
const reviewPath = path.join(evidence, 'mini-photo-original-effects-visual-review-2026-10-15.json');
const require = createRequire(import.meta.url);
const sharp = process.env.NATIVE_NODE_MODULES ? require(path.join(process.env.NATIVE_NODE_MODULES, 'sharp')) : require('sharp');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw Error('ORIGINAL_EFFECT_REVIEW_EVIDENCE_MISMATCH'); };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const regular = filename => { const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink()) fail(); return fs.readFileSync(filename); };
const review = JSON.parse(regular(reviewPath));
if (review.mode !== 'agent-visual' || review.deployed !== false || review.originalTechnicalReportsModified !== false
  || !review.reviewers.includes('root') || !review.reviewers.includes('probe_independent_review')
  || review.effects.length !== 4 || review.attemptedGenerationCalls !== 4 || review.attemptedGreenCalls !== 8) fail();
const sourcePath = path.join(workspace, originalEffectsInput.workspaceRelativePath), sourceBytes = regular(sourcePath);
if (sha(sourceBytes) !== originalEffectsInput.rawSha256 || sha(sourceBytes) !== review.sourceRawSha256) fail();
const sourceMeta = await sharp(sourceBytes).metadata();
if (sourceMeta.width !== originalEffectsInput.width || sourceMeta.height !== originalEffectsInput.height) fail();
const titles = { 'classic-black-white': '经典黑白照', 'new-chinese': '新中式肖像', 'modern-comic': '现代漫画像', 'gentle-watercolor': '温润水彩像' };
const items = [{ id: 'source', title: '唯一固定输入', label: 'AI 生成的虚构成人头像', decision: null,
  color: '#adc6ff', bytes: sourceBytes, meta: sourceMeta, sha256: sha(sourceBytes),
  description: '768 × 1024，未经本工具改写。四项使用相同归一化输入；原图不是现实用户或身份保真证明。' }];
for (const id of originalEffectIds) {
  const row = review.effects.find(item => item.effectId === id), profile = getOriginalEffectProfile(id);
  if (!row || row.effectVersion !== profile.effectVersion || row.technicalPassed !== true
    || !['accepted', 'rejected'].includes(row.decision) || row.output !== `mini-photo-${profile.effectVersion}.png`
    || row.report !== `mini-photo-${profile.effectVersion}.json`) fail();
  const outputBytes = regular(path.join(evidence, row.output)), report = JSON.parse(regular(path.join(evidence, row.report)));
  if (sha(outputBytes) !== row.outputSha256 || photoAcceptanceDigest(report) !== row.reportSha256
    || report.outputSha256 !== row.outputSha256 || report.passed !== true || report.cleanupPending !== false
    || report.effectId !== id || report.specSha256 !== profile.specSha256 || report.qualityAccepted !== false) fail();
  const meta = await sharp(outputBytes).metadata();
  items.push({ id, title: titles[id], label: row.decision === 'accepted' ? 'ACCEPTED · 本固定样本接受' : 'REJECTED · 当前版本拒绝',
    decision: row.decision, color: row.decision === 'accepted' ? '#77e4b0' : '#ff9a9e',
    bytes: outputBytes, meta, sha256: row.outputSha256, description: row.observations });
}

// Images are decoded from the existing evidence only. The HTML embeds their
// exact bytes; the sheet uses contain and never crops or paints over a watermark.
const columnWidth = 360, imageWidth = 336, gap = 18, side = 22, top = 211, imageHeight = 448;
const width = side * 2 + columnWidth * 5 + gap * 4, height = 1020;
const overlays = [];
const text = (value, x, y, size, color = '#e8e8ee', weight = 'normal') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="Microsoft YaHei, sans-serif" font-weight="${weight}">${escape(value)}</text>`;
const lines = (value, maximum = 19) => { const chars = [...value], result = []; for (let i = 0; i < chars.length; i += maximum) result.push(chars.slice(i, i + maximum).join('')); return result; };
let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
svg += text('乐颜秀 · 原版四效果固定样本对照', 24, 45, 32, '#f6b7df', 'bold');
svg += text('原图 + 4 张既有结果｜技术管线 4/4 通过｜root + probe_independent_review 独立视觉复审', 24, 85, 23);
svg += text('漫画 / 水彩：接受此固定样本；黑白 / 新中式：因新增斑点、皱纹和明显加龄拒绝当前参数版本。', 24, 119, 22, '#c7c7d3');
svg += text('仅本地候选，未部署；不是人类审批，也不是全人群评测、真实年龄保真、Android 交付或公开开售证明。', 24, 151, 21, '#c7c7d3');
for (const [i, item] of items.entries()) {
  const left = side + i * (columnWidth + gap);
  svg += text(item.title, left, 190, 25, item.color, 'bold');
  const thumbnail = await sharp(item.bytes).resize({ width: imageWidth, height: imageHeight, fit: 'contain', background: '#1b1d26' }).png().toBuffer();
  overlays.push({ input: thumbnail, left, top });
  svg += text(item.label, left, 690, 19, item.color, 'bold');
  svg += text(`${item.meta.width} × ${item.meta.height} · 完整画面 / 全部水印`, left, 721, 17, '#bdbdcb');
  for (const [j, line] of lines(item.description).entries()) svg += text(line, left, 752 + j * 26, 17);
  svg += text(`SHA-256 ${item.sha256.slice(0, 20)}…`, left, 958, 15, '#a5a5b5');
}
svg += text('技术报告保留 qualityAccepted:false；样本视觉结论单列。未发起新生成、下载或修改原始图像证据。', 24, 1000, 19, '#bdbdcb') + '</svg>';
fs.mkdirSync(directory, { recursive: true });
const contact = path.join(directory, 'review.png'), html = path.join(directory, 'review.html');
await sharp({ create: { width, height, channels: 3, background: '#101218' } })
  .composite([...overlays, { input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(contact);
const cards = items.map(item => {
  const data = `data:${item.id === 'source' ? 'image/jpeg' : 'image/png'};base64,${item.bytes.toString('base64')}`;
  return `<figure class="${item.decision || 'source'}"><figcaption><h2>${escape(item.title)}</h2><strong>${escape(item.label)}</strong></figcaption><a href="${data}" target="_blank" rel="noreferrer"><img src="${data}" alt="${escape(item.title)}完整图像，保留全部水印"></a><p>${escape(item.description)}</p><small>${item.meta.width} × ${item.meta.height} · 原文件 SHA-256</small><code>${item.sha256}</code></figure>`;
}).join('');
fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>乐颜秀四效果固定样本对照</title><style>body{margin:0;background:#101218;color:#eee;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif;padding:28px}h1{margin:0;color:#f6b7df;font-size:30px}header p{margin:8px 0;color:#c7c7d3}main{display:grid;grid-template-columns:repeat(5,minmax(230px,1fr));gap:18px;margin:26px 0}figure{margin:0;background:#1b1d26;padding:14px;border-radius:12px}h2{font-size:22px;margin:0 0 5px}strong{font-size:15px}.accepted strong{color:#77e4b0}.rejected strong{color:#ff9a9e}.source strong{color:#adc6ff}img{width:100%;height:420px;object-fit:contain;background:#11131b}a{color:#9ccaff}code{display:block;font-size:11px;word-break:break-all;color:#aaa}small{color:#bbb}@media(max-width:1300px){main{grid-template-columns:repeat(2,minmax(230px,1fr))}}@media(max-width:560px){main{grid-template-columns:1fr}}</style><header><h1>乐颜秀 · 原版四效果固定样本对照</h1><p>同一张 AI 生成的虚构成人头像 + 四张既有结果，保留完整画面及全部水印。技术管线全部通过：4 次生成、8 次审核，本工具未调用外网或新增生成。</p><p>root 与 probe_independent_review 已分别进行 agent-visual 复审。现代漫画、温润水彩接受此固定样本；经典黑白、新中式因新增斑点、皱纹和明显加龄拒绝当前参数版本。技术报告仍保留 qualityAccepted:false。</p><p>仅本地候选，未部署；不是人类审批或全人群评测，不保证真实年龄或身份保真。Android 交付和正式商测交易未由此对照证明。</p><p><a href="review.png">打开完整拼图</a> · 复审时间 ${escape(review.reviewedAt)}</p></header><main>${cards}</main><footer>HTML 内嵌既有图像原始字节；点击图片查看完整原图。拼图仅等比缩放且不裁切，不修改证据文件。</footer></html>`, 'utf8');
console.log(JSON.stringify({ review: html, contactSheet: contact, existingImages: 5, newGenerationCalls: 0,
  technicalPassed: 4, accepted: ['modern-comic', 'gentle-watercolor'], rejected: ['classic-black-white', 'new-chinese'], deployed: false }));
