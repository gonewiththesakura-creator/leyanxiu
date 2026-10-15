import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyOneObject } from '../scripts/verify-photo-private-storage.mjs';

const key = 'private/photo-moderation/' + 'a'.repeat(32) + '.png';
const bytes = Buffer.from('synthetic byte fixture');
function setup({ anonymousStatus = 403, putError, deleteError, version, journalError = false } = {}) {
  const calls = [];
  const sameKey = (action, actual) => { assert.equal(actual, key); calls.push(action); };
  return { calls, run: () => verifyOneObject({ key, bytes, anonymousUrl: 'https://synthetic.invalid/object',
    journal: record => { assert.equal(record.key, key); calls.push('journal:' + record.phase); if (journalError) throw new Error('private log unavailable'); },
    sdk: { async get(actual, options) { sameKey('get', actual); assert.equal(options.timeout, 12000);
      return { res: { status: 200, headers: { 'x-oss-version-id': version } }, content: bytes }; },
    async head(actual) { sameKey('head', actual); throw Object.assign(new Error('fixture'), { code: 'NoSuchKey', status: 404 }); } },
    storage: { async put(actual, content, options) { sameKey('put', actual); assert.equal(content, bytes); assert.equal(options.contentType, 'image/png'); if (putError) throw putError; },
      signedUrl(actual, options) { sameKey('sign', actual); assert.equal(options.ttlSeconds, 60); return 'https://synthetic.invalid/signed'; },
      async delete(actual) { sameKey('delete', actual); if (deleteError) throw deleteError; } },
    async fetcher(url, options) { assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined); assert.ok(options.signal);
      calls.push(url.endsWith('/signed') ? 'signed' : 'anonymous');
      return new Response(url.endsWith('/signed') ? bytes : null, { status: url.endsWith('/signed') ? 200 : anonymousStatus }); },
  }) };
}
test('one-object acceptance journals before write, checks access and always deletes exact object once', async () => {
  const fixture = setup(); const result = await fixture.run();
  assert.equal(result.passed, true);
  assert.deepEqual(fixture.calls, ['journal:prepared', 'put', 'journal:put_confirmed', 'get', 'anonymous', 'sign', 'signed', 'journal:access_verified', 'delete', 'head', 'journal:finished']);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(result).includes('synthetic.invalid'), false);
});
test('anonymous success stops signed flow and immediately deletes; never claims privacy', async () => {
  const fixture = setup({ anonymousStatus: 200 }); const result = await fixture.run();
  assert.equal(result.failure, 'ANONYMOUS_READABLE'); assert.equal(result.passed, false);
  assert.equal(fixture.calls.includes('sign'), false); assert.equal(result.authenticatedHeadNoSuchKey, true);
});
test('existing object rejection is not permission to delete; missing private journal never writes', async () => {
  const fixture = setup({ putError: Object.assign(new Error('private raw upstream detail'), { code: 'ObjectAlreadyExists', status: 409 }) });
  const result = await fixture.run(); assert.equal(fixture.calls.includes('delete'), false); assert.equal(result.passed, false);
  assert.equal(JSON.stringify(result).includes('private raw'), false);
  const noLog = setup({ journalError: true }); await assert.rejects(noLog.run); assert.equal(noLog.calls.includes('put'), false);
});
test('uncertain write, failed deletion and a version marker cannot claim completed cleanup', async () => {
  for (const options of [{ putError: new Error('timeout') }, { deleteError: new Error('timeout') }, { version: 'synthetic-version' }]) {
    const fixture = setup(options); const result = await fixture.run();
    assert.equal(result.cleanupPending, true); assert.equal(result.passed, false);
    assert.equal(fixture.calls.filter(value => value === 'put').length, 1);
    assert.equal(fixture.calls.filter(value => value === 'delete').length, 1);
  }
});
