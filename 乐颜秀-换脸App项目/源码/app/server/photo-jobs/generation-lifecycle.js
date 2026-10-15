import { createPhotoGenerationRepository } from './generation-repository.js';
import { createPhotoGenerationPipeline } from './generation-pipeline.js';
import { createPhotoGenerationCleanupRepository, createPhotoGenerationCleanupWorker } from './generation-cleanup.js';
import { createPhotoMediaPorts } from './media-ports.js';
import { QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_POLICY } from './qwen-provider.js';
import { validatePhotoAcceptanceBundle, requiresPhotoAcceptanceBundle, photoEffectReportBound,
  photoAcceptanceDigest, photoSpecMatchesApprovedEffects } from './generation-acceptance.js';

const fail = code => Object.assign(new Error(code), { code });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  && !['unknown', 'unconfigured', 'none'].includes(value.toLowerCase());
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const schemaReads = [
  'SELECT user_id,app_id,openid FROM vp_accounts LIMIT 0',
  'SELECT id,user_id,status,payload FROM vp_orders LIMIT 0',
  'SELECT id,user_id,order_id,kind,starts_at,expires_at,remaining,reserved,frozen FROM vp_buckets LIMIT 0',
  'SELECT id,user_id,bucket_id,purpose,status FROM vp_reservations LIMIT 0',
  'SELECT id,user_id,action,reference_id,detail,created_at FROM vp_audit LIMIT 0',
  'SELECT user_id,enabled,consent_epoch,basic_version,face_version,subject_authorization,updated_at FROM mini_photo_accounts LIMIT 0',
  'SELECT effect_id,version,provider,model,purpose,parameters,enabled,review_reference FROM mini_photo_effects LIMIT 0',
  'SELECT id,user_id,kind,state,storage_key,sha256,byte_length,content_type,consent_epoch,job_id,moderation_reference,label_version,expires_at,created_at FROM mini_photo_assets LIMIT 0',
  'SELECT job_id,asset_id,user_id,created_at FROM mini_photo_works LIMIT 0',
  'SELECT id,user_id,idem,spec,spec_hash,billing_ref,state,claim_token,claimed_at,attempt,output_asset_id,provider_ref,failure_code,created_at,updated_at FROM mini_photo_jobs LIMIT 0',
  'SELECT job_id,user_id,spec_hash,policy,asset_id,output_key,marked_sha256,marked_length,marked_type,provider_receipt,review_receipt,moderation_reference,moderation_extension,moderation_cleanup_pending,output_cleanup_pending,registered,expires_at,created_at,updated_at FROM mini_photo_generation LIMIT 0',
  'SELECT job_id,step,state,token,attempts,started_at,updated_at FROM mini_photo_generation_operations LIMIT 0',
  'SELECT job_id,kind,storage_key,state,attempts,operation_token,delete_status,observation,next_at,checked_at,absent_observations,created_at,updated_at FROM mini_photo_generation_cleanup LIMIT 0',
];

/** Thin explicit lifecycle for createPhotoApplication.runProviderFactory.
 * No environment/credential reads, network-on-import, timers, migration or DB
 * close. inspectPrerequisites is a trusted READ-ONLY host port: it must inspect
 * the actual marker and matching existing real probe evidence. Its return value
 * is not a certificate, and must never originate from an HTTP request.
 */
export function createPhotoGenerationLifecycle({ context, policy, approvedEffects = [], media, cleanup,
  inspectPrerequisites, authorizeUser, generationEnabled = false, now = Date.now } = {}) {
  const database = context?.database;
  if (!database?.transaction || !['mysql', 'sqlite'].includes(database.backend)
    || typeof inspectPrerequisites !== 'function' || typeof authorizeUser !== 'function'
    || typeof generationEnabled !== 'boolean' || typeof now !== 'function') throw fail('PHOTO_GENERATION_LIFECYCLE_DEPENDENCIES_REQUIRED');
  let config, cleanupPolicy, effects;
  try { config = freeze(structuredClone(policy)); cleanupPolicy = freeze(structuredClone(cleanup?.policy));
    effects = freeze(structuredClone(approvedEffects)); }
  catch { throw fail('PHOTO_GENERATION_LIFECYCLE_POLICY_REQUIRED'); }
  if (config?.approved !== true || !identifier(config.reviewReference) || !identifier(config.acceptanceVersion)
    || !identifier(config.serviceProviderCode) || config.provider !== QWEN_PHOTO_PROVIDER || config.model !== QWEN_PHOTO_MODEL
    || config.resultUrlPolicy !== QWEN_PHOTO_RESULT_POLICY || config.operation !== 'edit') throw fail('PHOTO_GENERATION_LIFECYCLE_POLICY_REQUIRED');

  let accepting = true, prepared = false, preparing, draining, cleaning;
  const active = new Set(), portsActive = new Set();
  const keep = (set, operation) => { set.add(operation); operation.finally(() => set.delete(operation)).catch(() => {}); return operation; };
  const trackPort = (target, names) => Object.fromEntries(names.map(name => {
    if (typeof target?.[name] !== 'function') throw fail('PHOTO_GENERATION_LIFECYCLE_PORTS_REQUIRED');
    const call = target[name].bind(target);
    return [name, (...args) => keep(portsActive, Promise.resolve().then(() => call(...args)))];
  }));
  // One output port supplies both delivery and cleanup. Keep actual promises
  // alive even if the cleanup worker's bounded wait has already timed out.
  const outputStorage = trackPort(media?.outputStorage, ['put', 'read', 'delete', 'inspect']);
  const moderationStorage = trackPort(cleanup?.moderationStorage, ['delete', 'inspect']);
  const ports = createPhotoMediaPorts({ context,
    inputStorage: trackPort(media?.inputStorage, ['read']), outputStorage,
    provider: trackPort(media?.provider, ['generate', 'readGenerated']), marker: trackPort(media?.marker, ['mark']),
    moderator: trackPort(media?.moderator, ['moderate']), storageTimeoutMs: media?.storageTimeoutMs });
  const repository = createPhotoGenerationRepository({ context, policy: config, now });
  const cleanupRepository = createPhotoGenerationCleanupRepository({ context, now });
  const cleanupWorker = createPhotoGenerationCleanupWorker({ repository: cleanupRepository, outputStorage, moderationStorage, policy: cleanupPolicy });

  const inspect = async () => {
    let value;
    try { value = structuredClone(await keep(portsActive, Promise.resolve().then(() => inspectPrerequisites({ policy: config })))); }
    catch { throw fail('PHOTO_GENERATION_PREREQUISITES_UNCONFIRMED'); }
    const marker = value?.marker;
    if (!marker || marker.ready !== true || marker.python !== true || marker.pillow !== true || marker.chineseFont !== true
      || marker.labelVersion !== config.labelVersion || marker.operation !== config.operation
      || marker.serviceProviderCode !== config.serviceProviderCode) throw fail('PHOTO_GENERATION_MARKER_NOT_READY');
    return value;
  };
  const accepted = value => {
    const evidence = value?.providerEvidence, report = evidence?.report;
    if (requiresPhotoAcceptanceBundle(effects) || evidence?.acceptanceBundle) {
      try {
        const bundle = validatePhotoAcceptanceBundle(evidence?.acceptanceBundle, { effects,
          ...config, pipelineVersion: config.acceptanceVersion });
        if (photoAcceptanceDigest(bundle.pipelineReport) !== photoAcceptanceDigest(report)) return false;
      } catch { return false; }
    } else if (effects?.length === 1 && !photoEffectReportBound(effects[0], report)) {
      return false;
    }
    return evidence?.provider === config.provider && evidence.model === config.model && evidence.version === config.acceptanceVersion
      && evidence.resultUrlPolicy === config.resultUrlPolicy && evidence.labelVersion === config.labelVersion
      && evidence.moderationVersion === config.moderationVersion && evidence.moderationService === config.moderationService
      && report?.provider === config.provider && report.model === config.model && report.probeVersion === config.acceptanceVersion
      && report.resultUrlPolicy === config.resultUrlPolicy && report.labelVersion === config.labelVersion
      && report.moderationVersion === config.moderationVersion && report.moderationServices?.input === 'baselineCheck'
      && report.moderationServices.output === config.moderationService
      && report?.executed === true && report.syntheticOnly === true && report.passed === true
      && report.inputAllowed === true && report.outputAllowed === true && report.marked === true && report.outputReadMatches === true
      && report.outputAbsentObserved === true && report.scratchAbsentObserved === 2 && report.cleanupPending === false && !report.failure
      && report.attemptedGenerationCalls === 1 && report.attemptedGreenCalls === 2;
  };
  const readiness = async userId => {
    const closed = reason => ({ ready: false, prepared, accepting, generationEnabled, blockers: [reason] });
    if (!accepting) return closed('PHOTO_GENERATION_DRAINING');
    if (!prepared) return closed('PHOTO_GENERATION_NOT_PREPARED');
    if (!generationEnabled) return closed('PHOTO_GENERATION_DISABLED');
    try {
      if (!accepted(await inspect())) return closed('PHOTO_GENERATION_ACCEPTANCE_REQUIRED');
      if (!accepting) return closed('PHOTO_GENERATION_DRAINING');
      // An omitted user is the application's global scheduler/catalog check,
      // never proof that an arbitrary caller may start a task.
      if (userId !== undefined && (!identifier(userId)
        || await keep(portsActive, Promise.resolve().then(() => authorizeUser({ userId, policy: config }))) !== true)) return closed('PHOTO_GENERATION_USER_NOT_ALLOWED');
    } catch { return closed('PHOTO_GENERATION_PREREQUISITES_UNCONFIRMED'); }
    return accepting ? { ready: true, prepared: true, accepting: true, generationEnabled: true, blockers: [] } : closed('PHOTO_GENERATION_DRAINING');
  };
  return {
    database,
    prepare() {
      if (!accepting) return Promise.reject(fail('PHOTO_GENERATION_DRAINING'));
      if (preparing) return preparing;
      prepared = false;
      preparing = keep(active, (async () => {
        try { await database.transaction(async q => { for (const sql of schemaReads) await q(sql); }); }
        catch { throw fail('PHOTO_GENERATION_LIFECYCLE_SCHEMA_REQUIRED'); }
        // Missing marker/evidence closes creation, but cannot prevent cleanup
        // of objects for which this database already owns responsibility.
        let prerequisites, markerReady = false; const blockers = [];
        try { prerequisites = await inspect(); markerReady = true; }
        catch (error) { blockers.push(error.code === 'PHOTO_GENERATION_MARKER_NOT_READY'
          ? error.code : 'PHOTO_GENERATION_PREREQUISITES_UNCONFIRMED'); }
        const acceptanceReady = markerReady && accepted(prerequisites);
        if (!acceptanceReady && !blockers.length) blockers.push('PHOTO_GENERATION_ACCEPTANCE_REQUIRED');
        if (!accepting) throw fail('PHOTO_GENERATION_DRAINING');
        prepared = true; return { prepared: true, markerReady, acceptanceReady, blockers };
      })());
      preparing.finally(() => { preparing = undefined; }).catch(() => {});
      return preparing;
    },
    readiness,
    runProvider(input) {
      if (!accepting) return Promise.reject(fail('PHOTO_GENERATION_DRAINING'));
      let snapshot;
      try { snapshot = structuredClone(input); } catch { return Promise.reject(fail('PHOTO_GENERATION_REQUEST_INVALID')); }
      return keep(active, (async () => {
        // Undefined user must not accidentally use the global readiness path.
        if (!identifier(snapshot?.userId)) throw fail('PHOTO_GENERATION_USER_NOT_ALLOWED');
        if (!(await readiness(snapshot.userId)).ready) throw fail('PHOTO_GENERATION_NOT_AVAILABLE');
        if (!photoSpecMatchesApprovedEffects(snapshot.spec, effects)) throw fail('PHOTO_GENERATION_EFFECT_NOT_ACCEPTED');
        if (!accepting) throw fail('PHOTO_GENERATION_DRAINING');
        // Bind this invocation's trusted job/user to the last paid-call gate.
        // Evidence checks may await a filesystem/marker read, so recheck the
        // canonical reservation/refund/consent state AFTER that await too.
        const pipeline = createPhotoGenerationPipeline({ repository, context, ports: { ...ports, async generate(input) {
          if (!photoSpecMatchesApprovedEffects(input?.spec, effects) || !accepted(await inspect())) {
            throw fail('PHOTO_GENERATION_EFFECT_NOT_ACCEPTED');
          }
          const authorized = await database.transaction(async q => {
            const row = (await q('SELECT * FROM mini_photo_jobs WHERE id = ? AND user_id = ?', [snapshot.jobId, snapshot.userId]))[0];
            return row && ['claimed', 'unknown'].includes(row.state) && row.attempt === 1
              && await context.ports.authorize({ query: q, job: { ...row, spec: JSON.parse(row.spec) }, phase: 'dispatch' }) === true;
          });
          if (!authorized) throw fail('PHOTO_GENERATION_NOT_AUTHORIZED');
          if (!accepting) throw fail('PHOTO_GENERATION_DRAINING');
          return ports.generate(input);
        } } });
        return pipeline.runProvider(snapshot);
      })());
    },
    runCleanupOnce() {
      if (!accepting || !prepared) return Promise.resolve(null);
      if (cleaning) return cleaning;
      cleaning = keep(active, cleanupWorker.runOnce());
      cleaning.finally(() => { cleaning = undefined; }).catch(() => {});
      return cleaning;
    },
    drain() {
      if (draining) return draining;
      accepting = false;
      draining = (async () => {
        await cleanupWorker.drain();
        while (active.size) await Promise.allSettled([...active]);
        while (portsActive.size) await Promise.allSettled([...portsActive]);
        return { accepting: false, active: active.size + portsActive.size, databaseClosed: false };
      })();
      return draining;
    },
  };
}
