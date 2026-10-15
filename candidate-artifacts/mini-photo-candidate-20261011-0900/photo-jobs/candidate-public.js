const publicSupport = Object.freeze({ operatorName: 'REDACTED_COMPANY_NAME', supportContact: 'REDACTED_COMPANY_CONTACT_EMAIL' });
const text = (value, maximum = 80) => typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) ? value : null;

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

/** Only existing public client fields. The owner confirmed this company and
 * support mailbox on 2026-10-09. Policy approval and a synthetic media probe
 * are not approval of published legal/supplier facts or production quality.
 * Configuring document URLs therefore never changes this pending status.
 */
export function photoCandidatePublicProfile({ env = {}, policy = {} } = {}) {
  return Object.freeze({ ...publicSupport,
    privacyPolicyUrl: publicDocument(env.PRIVACY_POLICY_URL),
    userAgreementUrl: publicDocument(env.USER_AGREEMENT_URL),
    thirdPartyListUrl: publicDocument(env.THIRD_PARTY_LIST_URL),
    consentVersions: Object.freeze({ basic: text(policy.basicVersion), faceProcessing: text(policy.faceVersion) }),
    retention: null, aiServices: Object.freeze([]), status: 'pending_company_approval' });
}

export function registerPhotoCandidatePublicRoutes(app, { profile = photoCandidatePublicProfile(), catalog, authenticated }) {
  if (typeof catalog !== 'function' || typeof authenticated !== 'function') throw new Error('PHOTO_CANDIDATE_PUBLIC_DEPENDENCIES_REQUIRED');
  const published = photoCandidatePublicProfile({ env: { PRIVACY_POLICY_URL: profile?.privacyPolicyUrl,
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
      status: available ? 'blocked_pending_disclosure' : 'blocked_pending_evidence' }] });
  });
  app.post('/api/reports', async c => {
    const identity = await authenticated(c);
    if (identity?.response) return identity.response;
    // No body parsing, SQL write, ticket or external submission. This distinct
    // error tells the client no request was accepted, unlike an ambiguous 503.
    return c.json({ code: 'REPORT_SUBMISSION_DISABLED', message: '在线反馈暂未开通，请通过公开客服邮箱联系；本次未提交申请。' }, 503);
  });
}
