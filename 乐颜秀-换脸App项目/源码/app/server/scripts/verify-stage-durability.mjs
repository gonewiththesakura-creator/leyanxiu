import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const base = 'REDACTED_COMPANY_CLOUD_ENDPOINT';
const phase = process.argv[2];
assert.ok(['baseline', 'verify'].includes(phase));
const privateFile = fileURLToPath(new URL('../.env.stage-durability-check', import.meta.url));
const output = fileURLToPath(new URL(`../../output/audit/stage-durability-${phase}-20260918.json`, import.meta.url));
let token = '';
async function api(route, method = 'GET', body, extra = {}) {
  const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const data = await r.json();
  assert.equal(r.status, 200, `${route}: ${r.status} ${data.code}`);
  return data.data;
}
const secrets = Object.fromEntries(fs.readFileSync(new URL('../.env.stage.secrets', import.meta.url), 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const internal = { 'X-Internal-Token': secrets.INTERNAL_CRON_TOKEN };
let saved;
if (phase === 'baseline') {
  assert.ok(process.env.LEYANXIU_STAGE_INVITE_SECRET);
  const session = await api('/api/auth/session', 'POST', { clientId: 'durability-acceptance-20260918', channel: 'h5', inviteCode: process.env.LEYANXIU_STAGE_INVITE_SECRET });
  token = session.token;
  const consents = await api('/api/consents');
  await api('/api/consents', 'POST', { consentType: 'basic', action: 'granted', version: consents.current.basic });
  const entitlements = await api('/api/account/entitlements');
  const entries = (await api('/api/consents')).entries;
  const metrics = await api('/api/ops/metrics', 'GET', undefined, internal);
  saved = { token, userId: session.user.id, entitlements, entries, httpRequests: metrics.http.requests, checkedAt: new Date().toISOString() };
  fs.writeFileSync(privateFile, JSON.stringify(saved), { mode: 0o600 });
} else {
  saved = JSON.parse(fs.readFileSync(privateFile)); token = saved.token;
  const me = await api('/api/auth/me');
  assert.equal(me.user?.id || me.userId || me.id, saved.userId);
  assert.deepEqual(await api('/api/account/entitlements'), saved.entitlements);
  assert.deepEqual((await api('/api/consents')).entries, saved.entries);
  const metrics = await api('/api/ops/metrics', 'GET', undefined, internal);
  assert.ok(metrics.http.requests >= saved.httpRequests, 'persisted HTTP history must not reset');
  assert.equal(metrics.persistence.backend, 'oss');
  assert.ok(metrics.counters['http.POST./api/auth/session'] >= 1, 'restore pre-restart session creation counter');
  assert.ok(metrics.counters['http.POST./api/consents'] >= 1, 'restore pre-restart consent write counter');
  saved.restoredHttpRequests = metrics.http.requests;
}
const evidence = { phase, checkedAt: new Date().toISOString(), userId: saved.userId, entitlements: saved.entitlements, consentRecords: saved.entries.length, baselineHttpRequests: saved.httpRequests, restoredHttpRequests: saved.restoredHttpRequests, paidProviderCalls: 0 };
fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
