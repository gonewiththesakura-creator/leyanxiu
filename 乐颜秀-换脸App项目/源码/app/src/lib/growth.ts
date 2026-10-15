/* 裂变增长：免费额度 + 分享奖励 + 平台文案 */

const CREDIT_KEY = "ly_credits";
const SHARED_KEY = "ly_shared_ids";
const TEST_GRANT_KEY = "ly_test_credits_r15";
export const TEST_CREDIT_TARGET = 12;
const LOCAL_DEMO = import.meta.env.VITE_USE_MOCK === "true";

function readCredits(): number {
  const value = Number.parseInt(localStorage.getItem(CREDIT_KEY) || "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function getCredits(): number {
  const current = readCredits();
  if (LOCAL_DEMO && localStorage.getItem(TEST_GRANT_KEY) !== "1") {
    const granted = Math.max(current, TEST_CREDIT_TARGET);
    localStorage.setItem(CREDIT_KEY, String(granted));
    localStorage.setItem(TEST_GRANT_KEY, "1");
    return granted;
  }
  return current;
}

export function useCredit(): boolean {
  const c = getCredits();
  if (c <= 0) return false;
  localStorage.setItem(CREDIT_KEY, String(c - 1));
  return true;
}

export function addCredit(n = 1): number {
  const c = getCredits() + n;
  localStorage.setItem(CREDIT_KEY, String(c));
  return c;
}

export function refillTestCredits(): number {
  if (!LOCAL_DEMO) return readCredits();
  const next = Math.max(readCredits(), TEST_CREDIT_TARGET);
  localStorage.setItem(CREDIT_KEY, String(next));
  localStorage.setItem(TEST_GRANT_KEY, "1");
  return next;
}

/** 每个平台每天只能领一次奖励（防刷） */
export function canReward(platform: string): boolean {
  const today = new Date().toDateString();
  try {
    const rec: Record<string, string> = JSON.parse(localStorage.getItem(SHARED_KEY) || "{}");
    return rec[platform] !== today;
  } catch {
    return true;
  }
}

export function markShared(platform: string) {
  const today = new Date().toDateString();
  let rec: Record<string, string> = {};
  try {
    rec = JSON.parse(localStorage.getItem(SHARED_KEY) || "{}");
  } catch { /* ignore */ }
  rec[platform] = today;
  localStorage.setItem(SHARED_KEY, JSON.stringify(rec));
}

/* ---------- 平台配置与自动文案 ---------- */
export interface SharePlatform {
  id: string;
  name: string;
  color: string;
  reward: boolean; // 分享该平台是否奖励额度
}

export const PLATFORMS: SharePlatform[] = [
  { id: "douyin",  name: "抖音",     color: "from-slate-800 to-slate-900", reward: true },
  { id: "kuaishou", name: "快手",    color: "from-orange-500 to-orange-600", reward: true },
  { id: "channels", name: "视频号",  color: "from-emerald-500 to-emerald-600", reward: true },
  { id: "wechat",  name: "微信群",   color: "from-green-500 to-green-600", reward: true },
  { id: "moments", name: "朋友圈",   color: "from-sky-500 to-sky-600", reward: false },
];

export function buildCaption(platform: string, templateName: string): string {
  const productTag = "#乐颜秀 #AI生成";
  switch (platform) {
    case "douyin":
      return `我用自己的照片做了《${templateName}》AI 创意视频，记录一下。${productTag}`;
    case "kuaishou":
      return `一张照片生成的《${templateName}》创意作品。${productTag}`;
    case "channels":
      return `用照片制作了一段《${templateName}》AI 生成作品，和大家分享。${productTag}`;
    case "wechat":
      return `分享一段用本人照片制作的《${templateName}》AI 生成作品。${productTag}`;
    case "moments":
      return `今天做了一段《${templateName}》AI 创意作品。${productTag}`;
    default:
      return `《${templateName}》AI 生成作品。${productTag}`;
  }
}
