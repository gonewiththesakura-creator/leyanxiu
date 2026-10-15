const { createPaymentClient } = require('./payments');
const imageLimit = 2 * 1024 * 1024;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const jobProtocol = 'photo-jobs-v1';
const uploadProtocol = 'photo-uploads-v1';
const uploadStates = new Set(['staging', 'queued', 'claimed', 'reviewed', 'ready', 'rejected', 'review', 'unknown', 'cancelled']);
const safeUploadId = value => typeof value === 'string' && /^upload_[a-f0-9]{32}$/.test(value);
const safeKey = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const uploadNotStarted = new Set(['PHOTO_UPLOAD_INVALID_REQUEST', 'PHOTO_UPLOAD_NOT_AUTHORIZED',
  'PHOTO_UPLOAD_BUDGET_LIMIT', 'PHOTO_UPLOAD_NOT_AVAILABLE']);
const jobStates = new Set(['queued', 'claimed', 'result_ready', 'succeeded', 'cancelled', 'blocked', 'unknown']);
const definiteNotStarted = new Set(['INSUFFICIENT_ENTITLEMENT', 'GENERATION_PAUSED', 'XPAY_PURPOSE_NOT_INCLUDED',
  'COMPLIANCE_DISCLOSURE_REQUIRED', 'CONSENT_REQUIRED', 'INVALID_OBJECT_REFERENCE', 'OBJECT_NOT_OWNED',
  'OBJECT_EXPIRED', 'EFFECT_DISABLED', 'CONTENT_BLOCKED', 'CONTENT_REVIEW_REQUIRED', 'PROVIDER_BUDGET_LIMIT', 'XPAY_PROVIDER_BUDGET_LIMIT',
  'CLOSED_TEST_DAILY_LIMIT', 'INVALID_IDEMPOTENCY_KEY', 'PHOTO_JOB_NOT_AUTHORIZED',
  'PHOTO_JOB_ENTITLEMENT_REQUIRED', 'PHOTO_JOB_INVALID_REQUEST', 'PHOTO_JOB_NOT_AVAILABLE']);
const failure = (message, code) => { const error = new Error(message); error.code = code; return error; };

// All availability facts come from the same service as identity and rights.
// Public catalog publication alone does not prove an effect is sold or usable.
function photoAvailability(catalog, compliance, capabilities, enabled) {
  const policy = catalog?.miniProgramCreation;
  const declared = Array.isArray(policy?.photoEffectIds) ? policy.photoEffectIds.filter(safeId) : [];
  const capability = Array.isArray(capabilities) && capabilities.find(item => item.id === 'photo-effects');
  const services = Array.isArray(compliance?.aiServices) ? compliance.aiServices.filter(service =>
    Array.isArray(service.capabilities) && service.capabilities.includes('photo-effect')
    && ['provider', 'model', 'filingReference', 'purpose', 'region'].every(field => typeof service[field] === 'string' && service[field].trim())) : [];
  const disclosureReady = compliance?.status === 'approved' && services.length > 0
    && typeof compliance.operatorName === 'string' && compliance.operatorName.trim()
    && typeof compliance.consentVersions?.basic === 'string' && compliance.consentVersions.basic
    && typeof compliance.consentVersions?.faceProcessing === 'string' && compliance.consentVersions.faceProcessing
    && Number.isFinite(compliance.retention?.sourceHours) && compliance.retention.sourceHours > 0
    && Number.isFinite(compliance.retention?.resultHours) && compliance.retention.resultHours > 0
    && typeof compliance.retention?.supplierPolicy === 'string' && compliance.retention.supplierPolicy.trim();
  const available = enabled === true && policy?.available === true && catalog?.settings?.generationEnabled === true
    && policy.jobProtocol === jobProtocol && policy.uploadProtocol === uploadProtocol
    && capability?.ready === true && capability.status === 'verified' && Boolean(disclosureReady);
  const catalogEffects = Array.isArray(catalog?.photoEffects) ? catalog.photoEffects : [];
  const effects = catalogEffects
    .filter(item => item?.enabled === true && safeId(item.id))
    .map(item => ({ id: item.id, title: String(item.title || '图片效果'), subtitle: String(item.subtitle || ''),
      included: declared.filter(id => id === item.id).length === 1,
      available: available && declared.filter(id => id === item.id).length === 1
        && catalogEffects.filter(effect => effect?.id === item.id).length === 1 }));
  return { available: available && effects.some(item => item.available), effects, services };
}

function createCreationClient(wxApi, endpoint, { enabled = false } = {}) {
  const api = createPaymentClient(wxApi, endpoint);
  const invoke = (method, args = {}) => new Promise((resolve, reject) => wxApi[method]({ ...args, success: resolve, fail: reject }));
  const key = () => `lyx-creation-pending:${api.currentAccountId()}`;
  let producing = false, active = true, recoveryTask;
  let snapshot;
  const ensureAccount = async () => { await api.login(); if (!api.currentAccountId()) throw failure('请重新打开创作页', 'XPAY_ACCOUNT_CHANGED'); };
  const readPending = () => {
    const pending = wxApi.getStorageSync(key());
    if (!pending) return null;
    if (pending.protocol === uploadProtocol) {
      if (!safeId(pending.effectId) || !safeKey(pending.uploadKey) || !safeKey(pending.generationKey)
        || pending.uploadKey === pending.generationKey
        || (pending.uploadId !== undefined && !safeUploadId(pending.uploadId))
        || (pending.state !== undefined && !uploadStates.has(pending.state))
        || (pending.inputAssetId !== undefined && (!safeId(pending.inputAssetId) || pending.state !== 'ready'))) {
        throw failure('上一次照片上传记录需要核实，请联系客户支持', 'CREATION_PENDING_INVALID');
      }
      return pending;
    }
    if (!safeId(pending.effectId) || !safeId(pending.inputAssetId) || !/^[a-f0-9]{32}$/.test(pending.idempotencyKey || '')
      || (pending.jobId !== undefined && !safeId(pending.jobId)) || (pending.state !== undefined && !jobStates.has(pending.state))) {
      throw failure('上一次制作记录需要核实，请联系客户支持', 'CREATION_PENDING_INVALID');
    }
    return pending;
  };
  const validateJob = (job, pending) => {
    if (!job || !safeId(job.id) || !jobStates.has(job.state)
      || (pending.jobId && job.id !== pending.jobId)
      || (job.effectId !== undefined && (!safeId(job.effectId) || job.effectId !== pending.effectId))
      || (job.state === 'succeeded' && !safeId(job.assetId))) throw failure('制作记录尚未确认，请稍后刷新', 'CREATION_UNCONFIRMED');
    // The current public job DTO has no effectId. Its authenticated job/asset
    // response binds this account's original pending intent. This metadata is
    // for presentation only; readiness and billing still use server facts.
    return { id: job.id, state: job.state, effectId: pending.effectId,
      effectSource: job.effectId === undefined ? 'account-pending' : 'server-job',
      ...(job.state === 'succeeded' ? { assetId: job.assetId } : {}) };
  };
  const rememberJob = (pending, job) => {
    const updated = { ...pending, jobId: job.id, state: job.state };
    wxApi.setStorageSync(key(), updated); return updated;
  };
  const submitJob = async pending => {
    const storageKey = key();
    // Write the generation key BEFORE the only initial POST. After an unknown
    // reply even an absent lookup cannot authorize another submission.
    wxApi.setStorageSync(storageKey, pending);
    try {
      const response = await api.request('/api/mini/photo-jobs', { method: 'POST',
        data: { inputAssetId: pending.inputAssetId, effectId: pending.effectId },
        idempotencyKey: pending.idempotencyKey, timeout: 15000 });
      const job = validateJob(response?.job, pending);
      return { pending: rememberJob(pending, job), job, inputAssetId: pending.inputAssetId };
    } catch (error) {
      if (definiteNotStarted.has(error.code)) { wxApi.removeStorageSync(storageKey); throw error; }
      if (error.code === 'XPAY_ACCOUNT_CHANGED') throw error;
      throw failure('制作结果仍待确认，请刷新原任务，勿重复制作；剩余次数以服务端为准', 'CREATION_UNCONFIRMED');
    }
  };
  const advanceUpload = async (pending, value, onStage = () => {}) => {
    // A concurrent refresh or initial upload response may already have moved
    // this intent into its generation phase. A late upload reply cannot rewind it.
    const current = readPending();
    if (!current) return { pending: null, job: { state: 'upload_cancelled' } };
    if (current.protocol === jobProtocol) return { pending: current, job: { state: current.state || 'unconfirmed' } };
    if (current.protocol !== uploadProtocol || current.uploadKey !== pending.uploadKey) throw failure('照片任务已变化，请刷新原任务', 'CREATION_UNCONFIRMED');
    pending = current;
    if (!value || !safeUploadId(value.id) || !uploadStates.has(value.state)
      || (pending.uploadId && pending.uploadId !== value.id)
      || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
      || (value.state === 'ready' ? !safeId(value.assetId) : value.assetId !== undefined)
      || (value.state === 'ready' && pending.inputAssetId && pending.inputAssetId !== value.assetId)) {
      throw failure('照片审核记录尚未确认，请刷新原任务', 'CREATION_UNCONFIRMED');
    }
    const updated = { ...pending, uploadId: value.id, state: value.state,
      ...(value.state === 'ready' ? { inputAssetId: value.assetId } : {}) };
    wxApi.setStorageSync(key(), updated);
    const job = { state: `upload_${value.state}`, effectId: pending.effectId, effectSource: 'account-pending' };
    if (['rejected', 'cancelled'].includes(value.state)) {
      wxApi.removeStorageSync(key()); return { pending: null, job };
    }
    if (value.state !== 'ready' || !active || !enabled) return { pending: updated, job };
    onStage('generating');
    return submitJob({ effectId: pending.effectId, inputAssetId: value.assetId,
      idempotencyKey: pending.generationKey, protocol: jobProtocol });
  };
  const recoverOnce = async () => {
    const pending = readPending();
    if (!pending) return { pending: null };
    if (pending.protocol === uploadProtocol) {
      try {
        const response = await api.request(pending.uploadId ? `/api/mini/photo-uploads/${pending.uploadId}`
          : `/api/mini/photo-uploads/by-key/${pending.uploadKey}`);
        if (!response?.upload) return { pending, job: { state: 'unconfirmed' } };
        return await advanceUpload(pending, response.upload);
      } catch (error) {
        if (error.code === 'XPAY_ACCOUNT_CHANGED' || definiteNotStarted.has(error.code)) throw error;
        return { pending: readPending(), job: { state: 'unconfirmed' } };
      }
    }
    // Old synchronous submissions have no durable lookup contract. Preserve
    // them for support rather than treating a missing async job as a refund.
    if (pending.protocol !== jobProtocol) return { pending, job: { state: 'unknown' } };
    const storageKey = key();
    try {
      const response = await api.request(pending.jobId ? `/api/mini/photo-jobs/${encodeURIComponent(pending.jobId)}`
        : `/api/mini/photo-jobs/by-key/${encodeURIComponent(pending.idempotencyKey)}`);
      if (!response?.job) return { pending, job: { state: 'unconfirmed' } };
      const job = validateJob(response.job, pending);
      const updated = rememberJob(pending, job);
      if (job.state === 'cancelled') { wxApi.removeStorageSync(storageKey); return { pending: null, job }; }
      if (job.state !== 'succeeded') return { pending: updated, job };
      const asset = await api.request(`/api/assets/${encodeURIComponent(job.assetId)}/url`);
      if (asset?.assetId !== job.assetId || typeof asset?.url !== 'string' || !asset.url.startsWith('https://')) throw failure('作品链接尚未确认', 'CREATION_UNCONFIRMED');
      wxApi.removeStorageSync(storageKey);
      return { pending: null, job, result: { assetId: job.assetId, url: asset.url, inputAssetId: pending.inputAssetId,
        effectId: job.effectId, effectSource: job.effectSource } };
    } catch (error) {
      if (error.code === 'XPAY_ACCOUNT_CHANGED') throw error;
      return { pending: readPending(), job: { state: 'unconfirmed' } };
    }
  };
  const recover = async () => {
    if (!recoveryTask) recoveryTask = recoverOnce();
    const task = recoveryTask;
    try { return await task; } finally { if (recoveryTask === task) recoveryTask = undefined; }
  };
  const randomKey = async () => {
    const random = await invoke('getRandomValues', { length: 16 });
    const value = Array.from(new Uint8Array(random.randomValues)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (!safeKey(value)) throw failure('无法生成制作凭据，请重试', 'CREATION_RANDOM_UNAVAILABLE');
    return value;
  };
  return {
    setActive(value) { active = value === true; },
    entitlements: () => api.entitlements(),
    async refresh() {
      await ensureAccount();
      const recovery = await recover();
      const [catalog, compliance, capabilities, entitlements, works] = await Promise.all([
        api.request('/api/catalog'), api.request('/api/public/compliance'), api.request('/api/capabilities'),
        api.entitlements(), api.request('/api/works'),
      ]);
      if (!api.currentAccountId()) throw failure('微信账号已变化，请重新打开页面', 'XPAY_ACCOUNT_CHANGED');
      if (!Number.isSafeInteger(entitlements?.available?.photo) || entitlements.available.photo < 0 || !Array.isArray(works)) {
        throw failure('作品与剩余次数尚未确认，请刷新后重试', 'CREATION_RESPONSE_INVALID');
      }
      const availability = photoAvailability(catalog, compliance, capabilities, enabled);
      snapshot = { ...availability, compliance, photo: entitlements.available.photo,
        works: works.filter(work => work?.kind === 'image' && safeId(work.assetId)), ...recovery };
      return snapshot;
    },
    async authorize({ basicAgreed, faceAgreed, subjectAuthorization, basicVersion, faceVersion }) {
      if (!snapshot || !basicAgreed || !faceAgreed || !['self', 'authorized'].includes(subjectAuthorization)) {
        throw failure('请分别确认服务说明、人脸处理和照片授权', 'CREATION_CONSENT_REQUIRED');
      }
      const current = await api.request('/api/consents');
      if (current?.current?.basic !== basicVersion || current?.current?.face_processing !== faceVersion
        || snapshot.compliance.consentVersions.basic !== basicVersion
        || snapshot.compliance.consentVersions.faceProcessing !== faceVersion) {
        throw failure('处理说明已更新，请刷新并重新阅读', 'STALE_CONSENT_VERSION');
      }
      await api.request('/api/consents', { method: 'POST', data: { consentType: 'basic', version: basicVersion, action: 'granted' } });
      // Never infer consent from an old checkbox or combine face consent with payment.
      return api.request('/api/consents', { method: 'POST', data: { consentType: 'face_processing',
        version: faceVersion, action: 'granted', subjectAuthorization } });
    },
    async generate({ image, effectId, consent }, onStage = () => {}) {
      if (producing) throw failure('上一张照片正在制作，请稍候', 'CREATION_IN_PROGRESS');
      producing = true;
      try {
        await this.refresh();
        if (readPending()) throw failure('上一次制作结果仍待确认，请刷新作品，勿重复制作', 'CREATION_UNCONFIRMED');
        const selected = snapshot.effects.filter(effect => effect.id === effectId);
        if (!snapshot.available || selected.length !== 1 || selected[0].included !== true || selected[0].available !== true) {
          throw failure('这个效果暂未开放制作，请选择可用的效果', 'CREATION_NOT_AVAILABLE');
        }
        if (snapshot.photo < 1) throw failure('可用图片次数不足，请先查看套餐', 'INSUFFICIENT_ENTITLEMENT');
        if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
          || image.length > Math.ceil(imageLimit / 3) * 4 + 64) throw failure('请使用不超过 2MB 的 JPG、PNG 或 WebP 照片', 'INVALID_IMAGE');
        onStage('authorizing'); await this.authorize(consent);
        if (!active) throw failure('请返回创作页后继续', 'CREATION_INACTIVE');
        const uploadKey = await randomKey(), generationKey = await randomKey();
        if (uploadKey === generationKey) throw failure('无法生成独立制作凭据，请重试', 'CREATION_RANDOM_UNAVAILABLE');
        if (!active) throw failure('请返回创作页后继续', 'CREATION_INACTIVE');
        if (!api.currentAccountId()) throw failure('微信账号已变化，请重新打开页面', 'XPAY_ACCOUNT_CHANGED');
        const storageKey = key();
        const pending = { effectId, uploadKey, generationKey, protocol: uploadProtocol };
        // No photo bytes are persisted locally. Save account-scoped intent
        // before the upload POST, including both independently generated keys.
        wxApi.setStorageSync(storageKey, pending);
        onStage('uploading');
        try {
          const response = await api.request('/api/mini/photo-uploads', { method: 'POST', data: { image },
            idempotencyKey: uploadKey, timeout: 15000 });
          const result = await advanceUpload(pending, response?.upload, onStage);
          return { ...result, pending: Boolean(result.pending) };
        } catch (error) {
          if (uploadNotStarted.has(error.code)) { wxApi.removeStorageSync(storageKey); throw error; }
          if (definiteNotStarted.has(error.code)) throw error;
          if (error.code === 'XPAY_ACCOUNT_CHANGED') throw error;
          throw failure('照片处理结果仍待确认，请刷新原任务，勿重复上传或制作', 'CREATION_UNCONFIRMED');
        }
      } finally { producing = false; }
    },
    async assetUrl(assetId) {
      if (!safeId(assetId)) throw failure('作品信息无效', 'INVALID_ASSET');
      const result = await api.request(`/api/assets/${encodeURIComponent(assetId)}/url`);
      if (result?.assetId !== assetId || typeof result?.url !== 'string' || !result.url.startsWith('https://')) throw failure('作品链接尚未确认', 'INVALID_ASSET');
      return result;
    },
    async deleteAsset(assetId) {
      if (!safeId(assetId)) throw failure('作品信息无效', 'INVALID_ASSET');
      await ensureAccount();
      const result = await api.request(`/api/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE', acceptPartialErasure: true });
      if (result?.deleted !== true && result?.missing !== true) throw failure('删除结果尚未确认，请稍后核实', 'DELETE_UNCONFIRMED');
      return { partial: result?.erasurePartial === true, data: result };
    },
    async withdrawFaceConsent() {
      await ensureAccount();
      const result = await api.request('/api/consents/face_processing/withdraw', { method: 'POST', acceptPartialErasure: true });
      if (result?.consent?.action !== 'withdrawn') throw failure('授权撤回结果尚未确认，请稍后核实', 'WITHDRAW_UNCONFIRMED');
      return { partial: result?.erasurePartial === true, data: result };
    },
    async saveAsset(assetId) {
      await ensureAccount();
      const result = await this.assetUrl(assetId);
      const download = await invoke('downloadFile', { url: result.url, timeout: 60000 });
      try {
        if (download.statusCode !== 200 || !download.tempFilePath) throw failure('作品暂时无法下载，请重试', 'DOWNLOAD_FAILED');
        // Recheck account before copying private media to the system album.
        await ensureAccount();
        await invoke('saveImageToPhotosAlbum', { filePath: download.tempFilePath });
      } finally {
        if (download.tempFilePath) try { wxApi.getFileSystemManager().unlink({ filePath: download.tempFilePath, fail: () => {} }); } catch {}
      }
    },
  };
}
module.exports = { createCreationClient, photoAvailability, imageLimit };
