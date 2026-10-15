import { virtualEnabled, virtualRuntime, virtualReadiness, virtualProducts, virtualMessageCodec } from './runtime.js';
import { registerVirtualPaymentRoutes } from './routes.js';

// Public availability is narrower than a published effect: the same purpose
// must be explicitly reviewed for photo rights in the authoritative ledger.
export function miniCreationCatalog({ catalog, enabled, capabilityReady, disclosureReady, purposeRules }) {
  const photoEffectIds = (Array.isArray(catalog?.photoEffects) ? catalog.photoEffects : [])
    .filter(effect => effect?.enabled === true && typeof effect.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(effect.id)
      && purposeRules?.[`photo-effect:${effect.id}`]?.reviewed === true
      && purposeRules[`photo-effect:${effect.id}`].kind === 'photo')
    .map(effect => effect.id);
  return { available: enabled === true && catalog?.settings?.generationEnabled === true
    && capabilityReady === true && disclosureReady === true && photoEffectIds.length > 0,
  photoEffectIds: [...new Set(photoEffectIds)] };
}

// Compliance records non-generation calls; the selected billing ledger owns
// generation reservations. Counting them separately avoids both omissions and
// double counting when the legacy billing implementation is the same store.
export async function providerUsageCount({ compliance, billing, since, userId }) {
  const other = compliance.countProviderUsageSince(since, userId)
    - compliance.countGenerationReservationsSince(since, userId);
  const generations = await billing.countGenerationReservationsSince(since, userId);
  if (![other, generations].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('PROVIDER_USAGE_UNCONFIRMED');
  }
  return other + generations;
}

// A single routing boundary chooses the ledger before reservation; no dual writes of balances.
export function withVirtualBilling(legacy, { runtime = virtualRuntime, enabled = virtualEnabled, policy = () => JSON.parse(process.env.XPAY_PURPOSE_RULES_JSON || '{}') } = {}) {
  const selected = async userId => {
    if (!enabled()) return null;
    const current = await runtime();
    return await current.ledger.identity(userId) ? current.ledger : null;
  };
  return new Proxy(legacy, { get(target, property) {
    if (property === 'entitlements') return async userId => {
      const ledger = await selected(userId); if (!ledger) return target.entitlements(userId);
      const data = await ledger.entitlements(userId); const total = data.available.photo + data.available.video;
      return { ...data, trialRemaining: 0, purchasedRemaining: total, totalRemaining: total, source: 'wechat_virtual' };
    };
    if (property === 'reserveCreation') return async (userId, reference, purpose) => {
      const ledger = await selected(userId); if (!ledger) return target.reserveCreation(userId, reference, purpose);
      const rule = policy()[purpose];
      if (!rule || !['photo', 'video'].includes(rule.kind) || rule.reviewed !== true) return { ok: false, error: 'XPAY_PURPOSE_NOT_INCLUDED' };
      return ledger.reserve(userId, reference, purpose, rule.kind);
    };
    if (property === 'confirmCreation') return async (userId, reference, purpose) => {
      const ledger = await selected(userId); return ledger ? ledger.finish(userId, reference, 'success') : target.confirmCreation(userId, reference, purpose);
    };
    if (property === 'refundCreation') return async (userId, reference, reason) => {
      const ledger = await selected(userId);
      if (!ledger) return target.refundCreation(userId, reference, reason);
      // Network exceptions and lost task submissions do not prove the supplier did not charge.
      const confirmedFailure = ['provider_failed', 'face_not_detected', 'provider_not_configured', 'effect_not_supported', 'style_not_supported', 'background_not_owned', 'background_not_configured', 'consent_persistence_failed', 'operator_confirmed_failure'].includes(reason);
      return ledger.finish(userId, reference, confirmedFailure ? 'failed' : 'unknown');
    };
    if (property === 'countGenerationReservationsSince') return async (since, userId) => {
      const old = await target.countGenerationReservationsSince(since, userId);
      return enabled() ? old + await (await runtime()).ledger.countReservations(Date.parse(since), userId) : old;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export async function bindVirtualLogin({ userId, sessionId, appId, openid, sessionKey }) {
  if (!virtualEnabled()) return;
  await (await virtualRuntime()).ledger.bindSession({ userId, sessionId, appId, openid, sessionKey });
}

export async function virtualGenerationGate(userId, purpose, metadata) {
  if (!virtualEnabled() || !await (await virtualRuntime()).ledger.identity(userId)) return null;
  const rules = JSON.parse(process.env.XPAY_PURPOSE_RULES_JSON || '{}');
  const rule = rules[purpose];
  if (!rule || rule.reviewed !== true || !['photo', 'video'].includes(rule.kind)) return 'XPAY_PURPOSE_NOT_INCLUDED';
  if (rule.kind === 'video') {
    // Only reviewed fixed-duration templates are eligible. Arbitrary uploaded video is not a standard unit.
    if (purpose !== 'video-fusion' || !metadata?.templateId || !Array.isArray(rule.templateIds) || !rule.templateIds.includes(metadata.templateId)) return 'XPAY_VIDEO_TEMPLATE_NOT_INCLUDED';
  }
  return null;
}

export function mountVirtualPayments(app, dependencies) {
  // Lazy initialization keeps a deliberately disabled installation bootable without credentials.
  const ledger = new Proxy({}, { get: (_, method) => async (...args) => {
    const runtime = await virtualRuntime(); if (!runtime) throw new Error('XPAY_NOT_READY');
    return runtime.ledger[method](...args);
  } });
  let current;
  const readiness = async () => {
    const result = await virtualReadiness(await dependencies.operationalReadiness());
    if (result.operationsReady) current = await virtualRuntime();
    return result;
  };
  return registerVirtualPaymentRoutes(app, { ...dependencies, ledger, products: virtualProducts, readiness,
    adapter: () => { if (!current) throw new Error('XPAY_NOT_READY'); return current.adapter; },
    codec: virtualMessageCodec });
}
