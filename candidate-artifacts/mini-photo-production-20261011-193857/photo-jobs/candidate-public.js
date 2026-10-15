const publicSupport = Object.freeze({ operatorName: 'REDACTED_COMPANY_NAME', supportContact: 'REDACTED_COMPANY_CONTACT_EMAIL' });
const text = (value, maximum = 80) => typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) ? value : null;
const publicText = (value, maximum) => typeof value === 'string' && value.length <= maximum
  && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() || null : null;
const projectedProfiles = new WeakSet();

function publicDocument(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\<>"#?]/.test(value)) return null;
  const match = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?(?:[/?][^#]*)?$/.exec(value);
  if (!match) return null;
  const labels = match[1].toLowerCase().split('.');
  if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels.at(-1))
    || ['local', 'localhost', 'internal', 'lan'].includes(labels.at(-1))
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  try { if (new URL(value).href !== value) return null; } catch { return null; }
  return value;
}

function photoDisclosures(value, policy) {
  if (typeof value !== 'string' || value.length > 32768) return Object.freeze([]);
  try {
    const rows = JSON.parse(value);
    if (!Array.isArray(rows) || rows.length > 30) return Object.freeze([]);
    const facts = rows.filter(item => item?.provider === policy.provider && item?.model === policy.model
      && Array.isArray(item.capabilities) && item.capabilities.includes('photo-effect'))
      .map(item => ({ provider: publicText(item.provider, 80), model: publicText(item.model, 100),
        filingReference: publicText(item.filingReference, 200), purpose: publicText(item.purpose, 500),
        region: publicText(item.region, 100), capabilities: Object.freeze(['photo-effect']) }));
    if (!facts.length || facts.some(item => Object.values(item).some(value => !value))) return Object.freeze([]);
    return Object.freeze(facts.map(Object.freeze));
  } catch { return Object.freeze([]); }
}

/** Reuse existing publication fields; only this configured photo provider/model
 * is disclosed. Retention comes from the actual job policy, never a display
 * default. The legacy client status "approved" means complete configured
 * disclosures here, not a platform approval or evidence of image quality.
 * Internal policy approval and a synthetic media probe cannot supply any of
 * these missing facts or turn on the independently closed capability.
 */
export function photoCandidatePublicProfile({ env = {}, policy = {} } = {}) {
  const supplierPolicy = publicText(env.RETENTION_SUPPLIER_POLICY, 500);
  const retentionMs = [policy.sourceRetentionMs, policy.resultRetentionMs];
  const retention = supplierPolicy && retentionMs.every(value => Number.isSafeInteger(value) && value > 0 && value <= 30 * 86400000)
    ? Object.freeze({ sourceHours: policy.sourceRetentionMs / 3600000,
      resultHours: policy.resultRetentionMs / 3600000, supplierPolicy }) : null;
  const facts = { ...publicSupport,
    privacyPolicyUrl: publicDocument(env.PRIVACY_POLICY_URL),
    userAgreementUrl: publicDocument(env.USER_AGREEMENT_URL),
    thirdPartyListUrl: publicDocument(env.THIRD_PARTY_LIST_URL),
    consentVersions: Object.freeze({ basic: text(policy.basicVersion), faceProcessing: text(policy.faceVersion) }),
    retention, aiServices: photoDisclosures(env.AI_SERVICE_DISCLOSURES_JSON, policy) };
  // PIPIA_REFERENCE is the existing internal assessment reference, not a new
  // approval switch. Do not return the reference or any other private config.
  const complete = Boolean(facts.privacyPolicyUrl && facts.userAgreementUrl && facts.thirdPartyListUrl
    && facts.consentVersions.basic && facts.consentVersions.faceProcessing && retention && facts.aiServices.length
    && publicText(env.PIPIA_REFERENCE, 500));
  const profile = Object.freeze({ ...facts, status: complete ? 'approved' : 'pending_company_approval' });
  projectedProfiles.add(profile);
  return profile;
}

// A copied public response/status cannot supply missing private disclosure facts.
export const photoPublicDisclosureReady = profile => projectedProfiles.has(profile) && profile.status === 'approved';

export function registerPhotoCandidatePublicRoutes(app, { profile = photoCandidatePublicProfile(), catalog, authenticated }) {
  if (typeof catalog !== 'function' || typeof authenticated !== 'function') throw new Error('PHOTO_CANDIDATE_PUBLIC_DEPENDENCIES_REQUIRED');
  // Only a deeply frozen projection from the constructor can carry complete
  // disclosure status. A public response copied back in is not private proof.
  const published = projectedProfiles.has(profile) ? profile : photoCandidatePublicProfile({ env: { PRIVACY_POLICY_URL: profile?.privacyPolicyUrl,
    USER_AGREEMENT_URL: profile?.userAgreementUrl, THIRD_PARTY_LIST_URL: profile?.thirdPartyListUrl },
  policy: { basicVersion: profile?.consentVersions?.basic, faceVersion: profile?.consentVersions?.faceProcessing } });
  // These responses describe the same deployment for anonymous and logged-in
  // visitors. No identity, raw policy, object location or evidence is published.
  app.get('/api/public/compliance', c => c.json({ code: 0, data: published }));
  app.get('/api/capabilities', async c => {
    // Consult the current technical gate, but never promote synthetic-only
    // acceptance into the native client's formal "verified" status.
    let available = false;
    try { const value = await catalog(); available = value.settings?.generationEnabled === true && value.miniProgramCreation?.available === true; }
    catch { /* Missing current readiness keeps the capability closed. */ }
    return c.json({ code: 0, data: [{ id: 'photo-effects', route: '/api/mini/photo-jobs', ready: false,
      status: available && published.status !== 'approved' ? 'blocked_pending_disclosure' : 'blocked_pending_evidence' }] });
  });
  app.post('/api/reports', async c => {
    const identity = await authenticated(c);
    if (identity?.response) return identity.response;
    // No body parsing, SQL write, ticket or external submission. This distinct
    // error tells the client no request was accepted, unlike an ambiguous 503.
    return c.json({ code: 'REPORT_SUBMISSION_DISABLED', message: '在线反馈暂未开通，请通过公开客服邮箱联系；本次未提交申请。' }, 503);
  });
}
