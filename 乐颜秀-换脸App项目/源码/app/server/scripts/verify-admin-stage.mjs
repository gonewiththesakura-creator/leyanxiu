import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Closed-test acceptance only. Does not call paid generation APIs.
const base = 'REDACTED_COMPANY_CLOUD_ENDPOINT';
const phase = process.argv[2] || 'verify';
assert.ok(['publish', 'verify'].includes(phase));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expectedCover = '/effects/uploads/96a13a9e-c957-438f-9d5b-7736fe01b90d.webp';
const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public/templates/dance-r12.webp'))).digest('hex');
let cookie = '';
let csrf = '';
const evidence = { checkedAt: new Date().toISOString(), phase, base, checks: [] };
async function request(route, method = 'GET', data) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(90000),
  });
  const json = await response.json();
  assert.equal(response.status, 200, `${method} ${route}: ${response.status} ${json.code || ''}`);
  return { response, json };
}
try {
  assert.ok(process.env.LEYANXIU_STAGE_REVIEWER_PASSWORD, 'Set LEYANXIU_STAGE_REVIEWER_PASSWORD');
  const login = await request('/api/admin/session', 'POST', { username: 'stage-review', password: process.env.LEYANXIU_STAGE_REVIEWER_PASSWORD });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  csrf = login.json.data.csrfToken;
  assert.equal(login.json.data.user.role, 'reviewer');
  const workspace = (await request('/api/admin/catalog')).json.data;
  if (phase === 'publish' && workspace.published.version === 1) {
    assert.equal(workspace.draft.revision, 2, 'Stop if someone edited the inspected draft');
    assert.equal(workspace.draft.updatedBy, 'stage-owner');
    assert.equal(workspace.draft.catalog.templates.find(t => t.id === 'dance').cover, expectedCover);
    assert.equal(workspace.published.version, 1);
    const published = (await request('/api/admin/catalog/publish', 'POST', {
      expectedRevision: 2,
      note: '闭测验收：复用原舞蹈封面，验证素材上传、实时预览、独立审核发布与持久保存',
    })).json.data;
    assert.equal(published.published.version, 2);
    assert.equal(published.dirty, false);
    evidence.checks.push('owner draft independently published by reviewer');
  } else if (phase === 'publish') {
    assert.equal(workspace.published.version, 2);
    assert.equal(workspace.published.publishedBy, 'stage-review');
    evidence.checks.push('existing reviewer publication confirmed; not published again');
  }
  const catalog = (await request('/api/catalog')).json.data;
  const selected = catalog.catalog || catalog;
  assert.equal(selected.templates.find(t => t.id === 'dance').cover, expectedCover);
  evidence.catalogVersion = catalog.release.version;
  evidence.releaseId = catalog.release.id;
  assert.equal(catalog.release.version, 2);
  const media = await fetch(base + expectedCover, { signal: AbortSignal.timeout(30000) });
  assert.equal(media.status, 200);
  const bytes = Buffer.from(await media.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, expectedHash);
  evidence.asset = { path: expectedCover, bytes: bytes.length, sha256, anonymousStatus: media.status };
  evidence.checks.push('published catalog uses uploaded cover', 'anonymous published asset equals original SHA256');
  const status = (await request('/api/admin/catalog')).json.data;
  assert.equal(status.published.version, 2);
  assert.equal(status.dirty, false);
  evidence.checks.push('published release and clean draft retained');
  console.log(JSON.stringify(evidence, null, 2));
  fs.mkdirSync(path.join(root, 'output/audit'), { recursive: true });
  fs.writeFileSync(path.join(root, `output/audit/admin-stage-${phase}-20260917.json`), JSON.stringify(evidence, null, 2));
} finally {
  if (cookie && csrf) await request('/api/admin/logout', 'POST', {});
}
