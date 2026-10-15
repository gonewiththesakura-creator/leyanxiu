import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function media(value, max = 20 * 1024 * 1024) {
  const bytes = Buffer.isBuffer(value?.bytes) ? Buffer.from(value.bytes) : null;
  if (!bytes || bytes.length < 16 || bytes.length > max || !['image/png', 'image/jpeg', 'image/webp'].includes(value.contentType)
    || value.byteLength !== bytes.length || value.sha256 !== digest(bytes)) throw fail('PHOTO_GENERATION_BYTES_UNCONFIRMED');
  return { bytes, byteLength: bytes.length, sha256: digest(bytes), contentType: value.contentType };
}

/** Server-only candidate adapter. Every network/mark/register step is journaled
 * before invocation. Recovery reads stored receipts and immutable objects; it
 * never repeats a generation request, output PUT, or paid moderation request.
 */
export function createPhotoGenerationPipeline({ repository, context, ports }) {
  if (!repository?.begin || repository.database !== context?.database || typeof context?.registerOutput !== 'function'
    || !['readInput', 'generate', 'readGenerated', 'mark'].every(name => typeof ports?.[name] === 'function')
    || !['put', 'read'].every(name => typeof ports?.output?.[name] === 'function') || typeof ports?.moderator?.moderate !== 'function') throw fail('PHOTO_GENERATION_PORTS_REQUIRED');
  async function readStep(job, step, call) {
    const operation = await repository.begin(job.job_id, job.user_id, step);
    if (!operation.dispatch) throw fail('PHOTO_GENERATION_OPERATION_UNCONFIRMED');
    try {
      const value = await call();
      if (!await repository.complete(job.job_id, job.user_id, step, operation.token)) throw fail('PHOTO_GENERATION_OPERATION_CONFLICT');
      return value;
    } catch {
      await repository.complete(job.job_id, job.user_id, step, operation.token, 'unknown').catch(() => {});
      throw fail('PHOTO_GENERATION_OPERATION_UNCONFIRMED');
    }
  }
  async function runProvider(input) {
    let job = await repository.open(input);
    if (job.registered) {
      // Existing worker recordResult still owns normal completion. Recovery may
      // use repository.recordRecoveredResult explicitly after worker unknown.
      return { assetId: job.asset_id, providerRef: job.providerReceipt.providerRef };
    }
    if (!job.providerReceipt) {
      const original = media(await readStep(job, 'input_read', () => ports.readInput({ userId: job.user_id, assetId: job.spec.inputAssetId })), 2 * 1024 * 1024);
      const owned = await context.readOwnedAsset(job.user_id, job.spec.inputAssetId);
      if (!owned || owned.sha256 !== original.sha256 || owned.contentType !== original.contentType) throw fail('PHOTO_GENERATION_INPUT_UNCONFIRMED');
      const operation = await repository.begin(job.job_id, job.user_id, 'generate');
      if (!operation.dispatch) throw fail('PHOTO_GENERATION_PROVIDER_UNCONFIRMED');
      try {
        const receipt = await ports.generate({ input: original, spec: structuredClone(job.spec) });
        await repository.saveProviderReceipt(job.job_id, job.user_id, operation.token, receipt);
      } catch {
        await repository.complete(job.job_id, job.user_id, 'generate', operation.token, 'unknown').catch(() => {});
        throw fail('PHOTO_GENERATION_PROVIDER_UNCONFIRMED');
      }
      job = { ...job, ...await repository.read(job.job_id, job.user_id) };
    }
    let final;
    const operations = await repository.operations(job.job_id, job.user_id);
    if (job.marked_sha256 && operations.some(operation => operation.step === 'output_put')) {
      const found = await readStep(job, 'output_read', () => ports.output.read({ key: job.output_key,
        expected: { sha256: job.marked_sha256, byteLength: job.marked_length, contentType: job.marked_type } }));
      if (found?.found === false) throw fail('PHOTO_GENERATION_OUTPUT_UNCONFIRMED');
      final = media(found);
    } else {
      const original = media(await readStep(job, 'result_read', () => ports.readGenerated({ url: job.providerReceipt.resultUrl })));
      const marked = await readStep(job, 'mark', () => ports.mark({ ...original, contentId: job.job_id,
        operation: job.policy.operation, labelVersion: job.policy.labelVersion }));
      final = media(marked);
      await repository.freezeMarked(job.job_id, job.user_id, { ...final, labelVersion: marked.labelVersion,
        contentId: marked.contentId, operation: marked.operation, verified: marked.verified });
      job = { ...job, ...await repository.read(job.job_id, job.user_id) };
      const operation = await repository.begin(job.job_id, job.user_id, 'output_put');
      if (!operation.dispatch) throw fail('PHOTO_GENERATION_OUTPUT_UNCONFIRMED');
      try {
        await ports.output.put({ key: job.output_key, bytes: final.bytes, contentType: final.contentType });
        await repository.complete(job.job_id, job.user_id, 'output_put', operation.token);
      } catch {
        await repository.complete(job.job_id, job.user_id, 'output_put', operation.token, 'unknown').catch(() => {});
        throw fail('PHOTO_GENERATION_OUTPUT_UNCONFIRMED');
      }
      final = media(await readStep(job, 'output_read', () => ports.output.read({ key: job.output_key,
        expected: { sha256: job.marked_sha256, byteLength: job.marked_length, contentType: job.marked_type } })));
    }
    if (final.sha256 !== job.marked_sha256 || final.byteLength !== job.marked_length || final.contentType !== job.marked_type) throw fail('PHOTO_GENERATION_OUTPUT_UNCONFIRMED');
    if (!job.reviewReceipt) {
      const operation = await repository.begin(job.job_id, job.user_id, 'moderate');
      if (!operation.dispatch) throw fail('PHOTO_GENERATION_REVIEW_UNCONFIRMED');
      try {
        const receipt = await ports.moderator.moderate({ bytes: final.bytes, contentType: final.contentType, direction: 'output',
          journal: intent => repository.journalModeration(job.job_id, job.user_id, intent) });
        await repository.saveReview(job.job_id, job.user_id, operation.token, receipt);
      } catch {
        await repository.complete(job.job_id, job.user_id, 'moderate', operation.token, 'unknown').catch(() => {});
        throw fail('PHOTO_GENERATION_REVIEW_UNCONFIRMED');
      }
      job = { ...job, ...await repository.read(job.job_id, job.user_id) };
    }
    if (job.reviewReceipt.decision !== 'allow') throw fail('PHOTO_GENERATION_REVIEW_BLOCKED');
    await readStep(job, 'register', () => context.registerOutput(job.user_id, job.job_id, {
      id: job.asset_id, storageKey: job.output_key, sha256: final.sha256, byteLength: final.byteLength,
      contentType: final.contentType, expiresAt: job.expires_at, labelVersion: job.policy.labelVersion,
      moderation: { decision: 'allow', reference: job.reviewReceipt.reference },
    }));
    return repository.registered(job.job_id, job.user_id);
  }
  return { runProvider };
}
