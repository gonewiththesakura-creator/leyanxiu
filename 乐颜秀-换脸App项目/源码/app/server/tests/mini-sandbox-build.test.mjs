import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBundle } from '../scripts/deploy-mini-sandbox-cloud.mjs';

test('reviewed sandbox bundle ships the official CloudRun CA configuration without disabling TLS checks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-mini-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'candidate');
  const builder = fileURLToPath(new URL('../scripts/build-mini-payment-sandbox.mjs', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [builder, output], { encoding: 'utf8' }));
  assert.equal(result.realMoneyAllowed, undefined);
  assert.equal(result.env, 1); assert.equal(result.productionPaymentsEnabled, false);
  assert.equal(result.sandboxMayCharge, true); assert.equal(result.manifestVersion, 2);
  assert.equal(result.includesPrivateConfig, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2); assert.equal(manifest.env, 1);
  assert.equal(manifest.productionPaymentsEnabled, false); assert.equal(manifest.sandboxMayCharge, true);
  assert.equal(manifest.realMoneyAllowed, undefined);
  assert.equal(readBundle(output).entries.length, manifest.files.length + 1);
  const docker = fs.readFileSync(path.join(output, 'Dockerfile'), 'utf8');
  const reviewed = manifest.files.find(file => file.path === 'Dockerfile');
  assert.equal(reviewed.sha256, crypto.createHash('sha256').update(docker).digest('hex'));
  assert.match(docker, /\bNODE_EXTRA_CA_CERTS=\/app\/cert\/certificate\.crt(?:\s|$)/);
  assert.match(docker, /apt-get install[^\n]*\bca-certificates\b/);
  assert.match(docker, /^USER node$/m);
  for (const entry of manifest.files) {
    assert.equal(/(?:^|\/)\.env(?:[./]|$)|(?:^|\/)node_modules\//.test(entry.path), false);
    if (/\.(?:js|mjs)$/.test(entry.path) || entry.path === 'Dockerfile') {
      const source = fs.readFileSync(path.join(output, entry.path), 'utf8');
      assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|rejectUnauthorized\s*:\s*false/);
      for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), match[1]));
        assert.ok(manifest.files.some(file => file.path === dependency), `${entry.path} has an unpackaged relative import`);
      }
    }
  }
});
