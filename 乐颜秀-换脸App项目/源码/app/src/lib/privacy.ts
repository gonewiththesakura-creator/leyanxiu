import { APP_ACCOUNT_ONLY } from '@/lib/account-only';

const PRIVACY_ACCEPTANCE_KEY = "lyx_privacy_acceptance_v1";
export const PRIVACY_VERSION = APP_ACCOUNT_ONLY ? "2026-10-09-account" : "2026-09-05";

interface PrivacyAcceptance {
  version: string;
  acceptedAt: string;
  adultAttested: true;
}

export function hasAcceptedPrivacy() {
  try {
    const raw = window.localStorage.getItem(PRIVACY_ACCEPTANCE_KEY);
    if (!raw) return false;
    const value = JSON.parse(raw) as Partial<PrivacyAcceptance>;
    return value.version === PRIVACY_VERSION && Boolean(value.acceptedAt) && value.adultAttested === true;
  } catch {
    return false;
  }
}

export function acceptPrivacy() {
  const value: PrivacyAcceptance = {
    version: PRIVACY_VERSION,
    acceptedAt: new Date().toISOString(),
    adultAttested: true,
  };
  window.localStorage.setItem(PRIVACY_ACCEPTANCE_KEY, JSON.stringify(value));
}

export function clearPrivacyAcceptance() {
  window.localStorage.removeItem(PRIVACY_ACCEPTANCE_KEY);
}
