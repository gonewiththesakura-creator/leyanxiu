import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { photoAcceptanceDigest, photoEffectReportBound, photoSpecMatchesApprovedEffects,
  requiresPhotoAcceptanceBundle, validatePhotoAcceptanceBundle } from '../photo-jobs/generation-acceptance.js';
import { QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER } from '../photo-jobs/qwen-provider.js';
import { createPhotoCandidateInspector, photoCandidateConfig } from '../photo-jobs/candidate-server.js';
import { materializePhotoProductionFiles } from '../photo-jobs/production-bootstrap.js';
import { fixtureEffects, fixtureBundle, fixtureReview } from './photo-acceptance-fixture.mjs';

const effects = fixtureEffects();
const settings = { effects, provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL,
  pipelineVersion: 'original-effects-v1-20261015' };
const historicalPolicy = JSON.parse(fs.readFileSync(new URL('../docs/production-config/natural-avatar-merchant-policy-2026-10-13.json', import.meta.url)));
const historicalReport = JSON.parse(fs.readFileSync(new URL('../evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json', import.meta.url)));

test('one bound visual review is required per enabled effect and original pending technical report is preserved', () => {
  const bundle = fixtureBundle(); const accepted = validatePhotoAcceptanceBundle(bundle, settings);
  assert.deepEqual(accepted, bundle);
  assert.equal(accepted.effects[0].report.qualityAccepted, false);
  accepted.effects[0].report.passed = false;
  assert.equal(bundle.effects[0].report.passed, true, 'validated return does not alias caller data');
  const human = fixtureBundle(); human.effects[0].qualityReview.mode = 'human';
  assert.ok(validatePhotoAcceptanceBundle(human, settings));
});

test('missing, duplicate, foreign, pending, failed, mismatched and unbound reports fail closed', () => {
  const changes = [b => b.effects.pop(), b => b.effects.push(b.effects[0]), b => { b.effects[1] = b.effects[0]; },
    b => { b.schemaVersion = 2; }, b => { b.kind = 'report'; }, b => { b.probeVersion = 'old'; },
    b => { b.effects[0].effectId = 'foreign'; }, b => { b.effects[0].effectVersion = 'old'; },
    b => { b.effects[0].report = { passed: true }; }, b => { b.effects[0].report.acceptanceBinding.effectId = 'new-chinese'; },
    b => { b.effects[0].report.acceptanceBinding.effectVersion = 'other'; },
    b => { b.effects[0].report.acceptanceBinding.specSha256 = 'b'.repeat(64); },
    b => { b.effects[0].report.acceptanceBinding.probeVersion = 'old'; },
    b => { b.effects[0].report.sourceParameters.effectParameters.prompt = 'replacement'; },
    b => { b.effects[0].report.model = 'different'; }, b => { b.effects[0].report.failure = 'incomplete'; },
    b => { b.effects[0].report.passed = false; }, b => { b.effects[0].report.previewSaved = false; },
    b => { b.effects[0].report.cleanupPending = true; }, b => { b.effects[0].report.scratchAbsentObserved = '2'; },
    b => { b.effects[0].report.moderationServices.output = 'baselineCheck'; },
    b => { b.effects[0].report.labelVersion = 'wrong'; }, b => { b.effects[0].report.outputSha256 = null; },
    b => { b.effects[0].qualityReview = { passed: true }; }, b => { b.effects[0].qualityReview.decision = 'pending'; },
    b => { b.effects[0].qualityReview.mode = 'automatic'; }, b => { b.effects[0].qualityReview.reviewedBy = ''; },
    b => { b.effects[0].qualityReview.reviewedAt = 'bad'; }, b => { b.effects[0].qualityReview.scope = ''; },
    b => { b.effects[0].qualityReview.reportSha256 = 'c'.repeat(64); },
    b => { b.effects[0].qualityReview.inputSha256 = 'c'.repeat(64); },
    b => { b.effects[0].qualityReview.outputSha256 = 'c'.repeat(64); },
    b => { b.pipelineReport.scratchAbsentObserved = 0; }, b => { b.pipelineReport.labelVersion = 'old'; },
    b => { b.pipelineReport.acceptanceBinding.effectId = 'unbound-pipeline'; }];
  for (const mutate of changes) {
    const b = fixtureBundle(); mutate(b);
    assert.throws(() => validatePhotoAcceptanceBundle(b, settings), /PHOTO_GENERATION_ACCEPTANCE_/);
  }
  const changed = structuredClone(effects); changed[0].parameters.prompt = 'different prompt';
  assert.throws(() => validatePhotoAcceptanceBundle(fixtureBundle(), { ...settings, effects: changed }), /REPORT_INVALID/);
  assert.throws(() => validatePhotoAcceptanceBundle(fixtureBundle(), { ...settings, effects: [] }), /BUNDLE_REQUIRED/);
  assert.throws(() => validatePhotoAcceptanceBundle(fixtureBundle(), { ...settings, pipelineVersion: 'old' }), /PIPELINE_INVALID/);
});

test('natural-avatar v2 is compatible alone and in a new batch without rewriting its historical report', () => {
  const legacy = historicalPolicy.approvedEffects[0];
  assert.equal(photoEffectReportBound(legacy, historicalReport), true);
  assert.equal(requiresPhotoAcceptanceBundle([legacy]), false);
  assert.equal(requiresPhotoAcceptanceBundle([{ ...legacy, id: 'unreviewed' }]), true);
  assert.equal(requiresPhotoAcceptanceBundle([legacy, ...effects]), true);
  assert.equal(photoEffectReportBound({ ...legacy, version: 'natural-avatar-v1-20261012' }, historicalReport), false);
  const bundle = fixtureBundle(); bundle.effects.unshift({ effectId: legacy.id, effectVersion: legacy.version,
    report: historicalReport, qualityReview: fixtureReview(historicalReport) });
  assert.ok(validatePhotoAcceptanceBundle(bundle, { ...settings, effects: [legacy, ...effects] }));
  assert.equal(bundle.effects[0].report.probeVersion, 'natural-avatar-v2-20261013');
  assert.equal(bundle.effects[0].report.outputSha256, undefined);
  const legacyPipeline = structuredClone(bundle); legacyPipeline.pipelineReport = historicalReport;
  assert.throws(() => validatePhotoAcceptanceBundle(legacyPipeline, { ...settings, effects: [legacy, ...effects],
    pipelineVersion: legacy.version, labelVersion: legacy.version, moderationVersion: legacy.version }), /PIPELINE_INVALID/);
  assert.equal(photoEffectReportBound(legacy, { ...historicalReport, effectId: 'modern-comic' }), false);
  const oldAsNew = fixtureBundle(); oldAsNew.effects[0].report = historicalReport;
  oldAsNew.effects[0].qualityReview = fixtureReview(historicalReport);
  assert.throws(() => validatePhotoAcceptanceBundle(oldAsNew, settings), /REPORT_INVALID/);
});

test('dispatch parameters must match the pinned enabled effect even if a different effect exists in the database', () => {
  const effect = effects[0], spec = { inputAssetId: 'fixture_input', billingRef: 'fixture_billing', effectId: effect.id, effectVersion: effect.version, provider: effect.provider,
    model: effect.model, purpose: effect.purpose, effectParameters: structuredClone(effect.parameters) };
  assert.equal(photoSpecMatchesApprovedEffects(spec, effects), true);
  const reordered = { ...spec, effectParameters: Object.fromEntries(Object.entries(spec.effectParameters).reverse()) };
  assert.equal(photoSpecMatchesApprovedEffects(reordered, effects), true);
  for (const change of [{ effectId: 'unreviewed' }, { effectVersion: 'other' }, { purpose: 'photo-effect:other' },
    { effectParameters: { ...spec.effectParameters, seed: 4 } }, { effectParameters: { ...spec.effectParameters, prompt: 'different' } }]) {
    assert.equal(photoSpecMatchesApprovedEffects({ ...spec, ...change }, effects), false);
  }
  assert.equal(photoSpecMatchesApprovedEffects(spec, []), false);
  for (const key of Object.keys(spec)) {
    const missing = { ...spec }; delete missing[key];
    assert.equal(photoSpecMatchesApprovedEffects(missing, effects), false, key);
  }
  assert.equal(photoSpecMatchesApprovedEffects({ ...spec, unreviewed: true }, effects), false);
  const wrongPurpose = structuredClone(effects); wrongPurpose[0].purpose = 'photo-effect:natural-avatar';
  assert.throws(() => validatePhotoAcceptanceBundle(fixtureBundle(), { ...settings, effects: wrongPurpose }), /REPORT_INVALID/);
});

test('bootstrap and pinned inspector preserve the complete bundle, reread changed bytes, and refuse a single report for new effects', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-bundle-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = fixtureBundle(), bytes = Buffer.from(JSON.stringify(bundle));
  const env = { PHOTO_PRODUCTION_ACCEPTANCE_BASE64: bytes.toString('base64'),
    PHOTO_PRODUCTION_ACCEPTANCE_SHA256: createHash('sha256').update(bytes).digest('hex') };
  const materialized = materializePhotoProductionFiles({ env, temporaryRoot: directory });
  t.after(materialized.cleanup);
  const font = path.join(directory, 'font-fixture'); fs.writeFileSync(font, 'synthetic font');
  const policy = { ...historicalPolicy.policy, acceptanceVersion: settings.pipelineVersion,
    labelVersion: settings.pipelineVersion, moderationVersion: settings.pipelineVersion };
  const config = { policy, approvedEffects: effects, python: process.execPath, font,
    acceptanceFile: materialized.paths.PHOTO_PRODUCTION_ACCEPTANCE_FILE,
    acceptanceSha256: env.PHOTO_PRODUCTION_ACCEPTANCE_SHA256 };
  const options = { execute: (_python, _args, _options, done) => done(null) };
  const inspect = createPhotoCandidateInspector(config, options);
  const observed = await inspect();
  assert.equal(observed.marker.ready, true);
  assert.deepEqual(observed.providerEvidence.acceptanceBundle, bundle);
  assert.deepEqual(observed.providerEvidence.report, bundle.pipelineReport);
  fs.appendFileSync(config.acceptanceFile, ' ');
  assert.equal((await inspect()).providerEvidence, undefined);
  const reportBytes = Buffer.from(JSON.stringify(historicalReport)); fs.writeFileSync(config.acceptanceFile, reportBytes);
  const old = createPhotoCandidateInspector({ ...config,
    acceptanceSha256: createHash('sha256').update(reportBytes).digest('hex') }, options);
  assert.equal((await old()).providerEvidence, undefined);
  const legacy = createPhotoCandidateInspector({ ...config, policy: historicalPolicy.policy,
    approvedEffects: historicalPolicy.approvedEffects, acceptanceSha256: createHash('sha256').update(reportBytes).digest('hex') }, options);
  assert.deepEqual((await legacy()).providerEvidence.report, historicalReport);
  assert.equal(photoAcceptanceDigest(historicalReport), photoAcceptanceDigest((await legacy()).providerEvidence.report));
});

test('actual reviewed candidate policy and bundle pass full config parsing and preserve exact reports and retained sample hashes', async t => {
  const policyBytes = fs.readFileSync(new URL('../docs/production-config/original-effects-merchant-policy-2026-10-15.json', import.meta.url));
  const acceptanceBytes = fs.readFileSync(new URL('../evidence/mini-photo-original-effects-acceptance-bundle-2026-10-15.json', import.meta.url));
  const policy = JSON.parse(policyBytes), bundle = JSON.parse(acceptanceBytes), sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const materialized = materializePhotoProductionFiles({ env: {
    PHOTO_PRODUCTION_CONFIG_BASE64: policyBytes.toString('base64'), PHOTO_PRODUCTION_CONFIG_SHA256: sha(policyBytes),
    PHOTO_PRODUCTION_ACCEPTANCE_BASE64: acceptanceBytes.toString('base64'), PHOTO_PRODUCTION_ACCEPTANCE_SHA256: sha(acceptanceBytes),
  } });
  t.after(materialized.cleanup);
  // Host/platform values are synthetic and all work switches remain closed.
  // The policy and bundle bytes are the actual local candidate artifacts.
  const env = { RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENABLED: 'true', XPAY_ENV: '1',
    XPAY_MODE: 'closed', XPAY_DB_BACKEND: 'mysql', WECHAT_APP_ID: policy.policy.serviceProviderCode,
    WECHAT_APP_SECRET: 'synthetic-no-network', XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64),
    OSS_REGION: 'oss-cn-shanghai', OSS_BUCKET: 'synthetic-no-network', PYTHON_PATH: process.execPath, AI_MARK_FONT: process.execPath,
    PHOTO_CANDIDATE_CONFIG_FILE: materialized.paths.PHOTO_PRODUCTION_CONFIG_FILE, PHOTO_CANDIDATE_CONFIG_SHA256: sha(policyBytes),
    PHOTO_CANDIDATE_ACCEPTANCE_FILE: materialized.paths.PHOTO_PRODUCTION_ACCEPTANCE_FILE, PHOTO_CANDIDATE_ACCEPTANCE_SHA256: sha(acceptanceBytes) };
  const config = photoCandidateConfig(env);
  assert.deepEqual(config.approvedEffects.map(effect => effect.id), ['natural-avatar', 'modern-comic', 'gentle-watercolor']);
  assert.deepEqual(config.approvedEffects[0], historicalPolicy.approvedEffects[0]);
  assert.equal(config.generationEnabled, false); assert.equal(config.purchaseEnabled, false);
  const inspection = await createPhotoCandidateInspector(config, { execute: (_python, _args, _options, done) => done(null) })();
  assert.deepEqual(inspection.providerEvidence.acceptanceBundle, bundle);
  for (const entry of bundle.effects) {
    const stem = entry.effectId === 'natural-avatar' ? 'natural-avatar-v2-20261013' : entry.effectVersion;
    const report = entry.effectId === 'natural-avatar' ? historicalReport
      : JSON.parse(fs.readFileSync(new URL(`../evidence/mini-photo-${stem}.json`, import.meta.url)));
    const imageBytes = fs.readFileSync(new URL(`../evidence/mini-photo-${stem}.png`, import.meta.url));
    assert.deepEqual(entry.report, report);
    assert.equal(entry.qualityReview.reportSha256, photoAcceptanceDigest(report));
    assert.equal(entry.qualityReview.outputSha256, sha(imageBytes));
  }
  // A valid technical bundle alone must not mask invalid runtime identifiers.
  const bad = structuredClone(policy); bad.approvedEffects[1].reviewReference += ':invalid';
  const badBytes = Buffer.from(JSON.stringify(bad));
  fs.writeFileSync(env.PHOTO_CANDIDATE_CONFIG_FILE, badBytes);
  assert.throws(() => photoCandidateConfig({ ...env, PHOTO_CANDIDATE_CONFIG_SHA256: sha(badBytes) }), /EFFECTS_REQUIRED/);
});
