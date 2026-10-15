// These profiles apply only to the already confirmed buildtest-009 sandbox.
// No caller-selected service, database, catalog, production key or live mode.
// Sandbox isolation does not promise zero cash movement. This fixed predecessor
// cannot be reused after 009 -> 010; another upgrade needs a separately reviewed source.
export const nextUpgradeSource = Object.freeze({ operationId: '4144dccb93cb1fee6beb7527',
  releaseTaskId: 2306735, version: 'buildtest-009' });
export const nextSourceManifest = '1eb58686c1f1a2d1eca213fcfc7ca0626af9c5547b9a38bccfffa1224c6258ef';
export const repairSource = Object.freeze({ operationId: '794539d7274bdead5e742d7c',
  releaseTaskId: 2307702, version: 'buildtest-010' });
export const repairSourceManifest = '5a8701cc4d043d28be49f27097759c80c95527f5dfc7dfaef185cdb6788e6387';
export const repairProfile = 'sandbox-closed-repair';
// One user-authorized acceptance cycle from the confirmed safety release. The
// later close is restricted to the exact release journal produced by this resume.
export const resumeSource = Object.freeze({ operationId: 'e3000ccf2fe621f1b94f398b',
  releaseTaskId: 2308642, version: 'buildtest-011' });
export const resumeSourceManifest = '454ffad34349170f39193c6b5e831cbd5b4e138e8ed0d3f23c771296e51cb7b6';
export const resumeProfile = 'sandbox-acceptance-resume';
export const closeProfile = 'sandbox-acceptance-close';
export const acceptanceProfiles = Object.freeze([resumeProfile, closeProfile]);
export const nextProfiles = Object.freeze(['closed', 'sandbox-ledger']);
const same = (a, b) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
const fail = () => { throw new Error('LOCAL_CONFIGURATION_INVALID'); };

export function nextEnvironment(base, payment, profile = 'closed') {
  if (!nextProfiles.includes(profile) || base?.XPAY_MODE !== 'closed' || base.XPAY_ENV !== '1'
    || base.XPAY_ENABLED !== 'true' || base.XPAY_PRODUCTS_JSON !== '[]'
    || base.XPAY_PURPOSE_RULES_JSON !== '{}' || base.XPAY_RECONCILE_ENABLED !== 'false') fail();
  if (profile === 'closed') return { ...base };
  const ids = String(payment?.XPAY_TEST_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length
    || ids.some(value => !/^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))) fail();
  return { ...base, XPAY_MODE: 'sandbox', XPAY_TEST_USER_IDS: ids.join(','), XPAY_RECONCILE_ENABLED: 'true',
    XPAY_PRODUCTS_JSON: JSON.stringify([{ id: 'photo10', name: '图片处理10次包（沙箱联调）', amountFen: 990,
      type: 'pack', days: 365, components: [{ kind: 'photo', quantity: 10, valueFen: 990 }] }]) };
}

export function nextEnvironmentMatches(before, after, profile) {
  try { return same(nextEnvironment(before, after, profile), after); } catch { return false; }
}

export function repairEnvironment(before) {
  if (before?.XPAY_MODE !== 'sandbox' || before.XPAY_ENV !== '1' || before.XPAY_RECONCILE_ENABLED !== 'true') fail();
  return { ...before, XPAY_MODE: 'closed' };
}

export function repairEnvironmentMatches(before, after) {
  try { return same(repairEnvironment(before), after); } catch { return false; }
}

export function acceptanceEnvironment(before, profile) {
  if (!acceptanceProfiles.includes(profile) || before?.XPAY_ENV !== '1' || before.XPAY_ENABLED !== 'true'
    || before.XPAY_RECONCILE_ENABLED !== 'true' || before.XPAY_PURPOSE_RULES_JSON !== '{}'
    || before.XPAY_MODE !== (profile === resumeProfile ? 'closed' : 'sandbox')
    || !/^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(before.XPAY_TEST_USER_IDS || '')) fail();
  const base = { ...before, XPAY_MODE: 'closed', XPAY_PRODUCTS_JSON: '[]', XPAY_RECONCILE_ENABLED: 'false' };
  if (!nextEnvironmentMatches(base, { ...before, XPAY_MODE: 'sandbox' }, 'sandbox-ledger')) fail();
  return { ...before, XPAY_MODE: profile === resumeProfile ? 'sandbox' : 'closed' };
}

export function acceptanceEnvironmentMatches(before, after, profile) {
  try { return same(acceptanceEnvironment(before, profile), after); } catch { return false; }
}

export function nextProfileSummary(variables, profile) {
  const purchase = profile === 'sandbox-ledger' || profile === resumeProfile;
  return { profile, sandboxPurchasesPlanned: purchase,
    env: 1, productionPaymentsEnabled: false, sandboxMayCharge: true,
    testUserCount: purchase || acceptanceProfiles.includes(profile) ? variables.XPAY_TEST_USER_IDS.split(',').length : 0,
    platformCatalogVerified: false, generationEnabled: false,
    ...(purchase || acceptanceProfiles.includes(profile) ? { catalog: [{ id: 'photo10', amountFen: 990, photoCredits: 10, days: 365 }] } : {}) };
}
