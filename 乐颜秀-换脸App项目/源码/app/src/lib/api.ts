/**
 * 生成服务客户端
 * - 默认走同域真实 API；VITE_API_BASE 仅用于前后端分域部署
 * - 只有显式设置 VITE_USE_MOCK=true 时才启用本地演示合成
 * - 真实服务失败直接抛错，不伪装成本地成功
 */
import { compositeFace } from "@/lib/composite";
import { APP_ACCOUNT_ONLY } from '@/lib/account-only';
import type { Template, Work } from "@/data/templates";
import {
  APP_CHANNEL,
  IS_NATIVE_APP,
  getNativeDevicePublicKey,
  signNativeDeviceChallenge,
} from "@/lib/native";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
export const LOCAL_DEMO_MODE = USE_MOCK;
export const CLOSED_TEST_INVITE_REQUIRED = import.meta.env.VITE_CLOSED_TEST_INVITE_REQUIRED === "true";
const SESSION_KEY = "lyx_session_token";
const CLOSED_TEST_INVITE_KEY = "lyx_closed_test_invite";
const CLIENT_KEY = "lyx_client_id";
const PENDING_GENERATION_KEY = "lyx_pending_generation_v1";
let sessionRequest: Promise<string> | null = null;
let sessionGeneration = 0;

interface PendingGeneration {
  taskId: string;
  templateId: string;
  createdAt: string;
}

function browserStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function sessionStorageBackend() {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

function closedTestInvite() {
  if (!CLOSED_TEST_INVITE_REQUIRED) return "";
  return sessionStorageBackend()?.getItem(CLOSED_TEST_INVITE_KEY)?.trim() || "";
}

function closedTestInviteHeaders(): Record<string, string> {
  const invite = closedTestInvite();
  return invite ? { "X-Closed-Test-Invite": invite } : {};
}

export function hasClosedTestInvite() {
  return Boolean(closedTestInvite());
}

export function setClosedTestInvite(value: string) {
  const storage = sessionStorageBackend();
  const invite = value.trim();
  if (!storage) return;
  if (!invite) {
    storage.removeItem(CLOSED_TEST_INVITE_KEY);
    storage.removeItem(SESSION_KEY);
    sessionRequest = null;
    return;
  }
  if (storage.getItem(CLOSED_TEST_INVITE_KEY) !== invite) {
    storage.setItem(CLOSED_TEST_INVITE_KEY, invite);
    storage.removeItem(SESSION_KEY);
    sessionRequest = null;
  }
}

function clientId() {
  const storage = browserStorage();
  if (!storage) return "server-rendered-client";
  let value = storage.getItem(CLIENT_KEY);
  if (!value) {
    value = `${APP_CHANNEL}_${crypto.randomUUID()}`;
    storage.setItem(CLIENT_KEY, value);
  }
  return value;
}

async function createSessionToken(): Promise<string> {
  if (IS_NATIVE_APP) {
    const deviceKey = await getNativeDevicePublicKey();
    const challengeResponse = await fetch(`${API_BASE}/api/auth/device/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...closedTestInviteHeaders() },
      body: JSON.stringify({
        algorithm: deviceKey.algorithm,
        publicKeySpki: deviceKey.publicKeySpki,
      }),
    });
    const challengeJson = await challengeResponse.json().catch(() => ({}));
    if (!challengeResponse.ok || challengeJson.code !== 0 || !challengeJson.data?.challengeId || !challengeJson.data?.challenge) {
      throw new Error(challengeJson.message || "设备认证服务暂时不可用");
    }
    const proof = await signNativeDeviceChallenge(challengeJson.data.challenge as string);
    const verifyResponse = await fetch(`${API_BASE}/api/auth/device/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...closedTestInviteHeaders() },
      body: JSON.stringify({
        challengeId: challengeJson.data.challengeId,
        challenge: challengeJson.data.challenge,
        algorithm: proof.algorithm,
        publicKeySpki: deviceKey.publicKeySpki,
        signature: proof.signature,
      }),
    });
    const verifyJson = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok || verifyJson.code !== 0 || !verifyJson.data?.token) {
      throw new Error(verifyJson.message || "设备身份验证失败");
    }
    return verifyJson.data.token as string;
  }

  const response = await fetch(`${API_BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...closedTestInviteHeaders() },
    body: JSON.stringify({ clientId: clientId(), channel: APP_CHANNEL }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !json.data?.token) throw new Error(json.message || "登录服务暂时不可用");
  return json.data.token as string;
}

async function ensureSession(): Promise<string> {
  if (CLOSED_TEST_INVITE_REQUIRED && !closedTestInvite()) {
    throw new Error("请输入闭测邀请码后再继续");
  }
  const storage = sessionStorageBackend();
  const existing = storage?.getItem(SESSION_KEY);
  if (existing) return existing;
  const generation = sessionGeneration;
  sessionRequest ??= createSessionToken()
    .then((token) => {
      if (generation !== sessionGeneration) throw new Error('账号已切换，请重新操作');
      storage?.setItem(SESSION_KEY, token);
      return token;
    })
    .finally(() => {
      sessionRequest = null;
    });
  return sessionRequest;
}

export async function prepareAuthenticatedSession(inviteCode?: string) {
  // Non-closed builds keep the previous consent-only entry behavior. The preflight
  // is intentionally required only for a closed-test build.
  if (!CLOSED_TEST_INVITE_REQUIRED) return "";
  if (inviteCode !== undefined) setClosedTestInvite(inviteCode);
  if (!closedTestInvite()) throw new Error("请输入闭测邀请码后再继续");
  if (USE_MOCK) return "";
  return ensureSession();
}

// Called only from the explicit first-screen consent action. Account testing
// never enters creation, where the full product otherwise records this consent.
export async function recordAccountTestConsent() {
  if (!APP_ACCOUNT_ONLY || USE_MOCK) return;
  const { entries, basicVersion } = await consentState();
  if (basicVersion !== '2026-10-09-account') throw new Error('账号测试协议正在更新，请稍后重新进入');
  if (!hasActiveConsent(entries, 'basic', basicVersion)) {
    await grantConsent('basic', basicVersion, '参加乐颜秀账号测试', ['账号与设备标识', '必要安全记录'], []);
  }
}

export function adoptRecoveredSession(token: string) {
  if (!token) throw new Error('找回账号未返回有效登录信息');
  clearAccountSession();
  sessionStorageBackend()?.setItem(SESSION_KEY, token);
  sessionRequest = null;
}

// Async consumers can reject stale results without reading or exposing tokens.
export function getAccountSessionGeneration() { return sessionGeneration; }

export function clearAccountSession() {
  sessionGeneration += 1;
  sessionStorageBackend()?.removeItem(SESSION_KEY);
  browserStorage()?.removeItem(PENDING_GENERATION_KEY);
  browserStorage()?.removeItem('lyx_payment_attempt_v1');
  browserStorage()?.removeItem('ly_credits');
  sessionRequest = null;
}

export async function apiFetch(input: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await ensureSession();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${input}`, { ...init, headers });
  if (sessionStorageBackend()?.getItem(SESSION_KEY) !== token) throw new Error('账号已切换，请重新操作');
  if (response.status === 401 && retry) {
    sessionStorageBackend()?.removeItem(SESSION_KEY);
    return apiFetch(input, init, false);
  }
  return response;
}

function hasActiveConsent(entries: Array<{ consentType?: string; version?: string; action?: string; occurredAt?: string }>, consentType: string, version: string) {
  return entries
    .filter((entry) => entry.consentType === consentType && entry.version === version)
    .sort((left, right) => Date.parse(left.occurredAt || "") - Date.parse(right.occurredAt || ""))
    .at(-1)?.action === "granted";
}

async function grantConsent(consentType: string, version: string, purpose: string, dataTypes: string[], suppliers: string[], subjectAuthorization?: "self" | "authorized") {
  const response = await apiFetch("/api/consents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consentType, version, action: "granted", purpose, dataTypes, suppliers, ...(subjectAuthorization ? { subjectAuthorization } : {}) }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0) throw new Error(json.message || "授权记录失败");
}

async function consentState() {
  const response = await apiFetch("/api/consents");
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0) throw new Error(json.message || "无法读取授权状态");
  const entries = Array.isArray(json.data?.entries) ? json.data.entries : [];
  const basicVersion = String(json.data?.current?.basic || "");
  const faceVersion = String(json.data?.current?.face_processing || "");
  return { entries, basicVersion, faceVersion };
}

export async function recordCreationConsent({
  suppliers,
  subjectAuthorization,
  purpose,
}: {
  suppliers: string[];
  subjectAuthorization: "self" | "authorized";
  purpose: string;
}) {
  if (USE_MOCK) return;
  const disclosedSuppliers = [...new Set(suppliers.map((item) => item.trim()).filter(Boolean))];
  if (disclosedSuppliers.length === 0) throw new Error("影像处理服务商尚未完成披露，当前不能上传照片");
  const { entries, basicVersion, faceVersion } = await consentState();
  if (!hasActiveConsent(entries, "basic", basicVersion)) {
    await grantConsent("basic", basicVersion, "使用乐颜秀基础服务", ["账户标识", "操作日志"], []);
  }
  // Every creation records the user's current, informed authorization and the suppliers shown on screen.
  await grantConsent("face_processing", faceVersion, purpose, ["人脸图像", "生成结果"], disclosedSuppliers, subjectAuthorization);
}

async function ensureFaceConsent() {
  const { entries, basicVersion, faceVersion } = await consentState();
  if (!hasActiveConsent(entries, "basic", basicVersion) || !hasActiveConsent(entries, "face_processing", faceVersion)) {
    throw new Error("授权状态未生效，请返回制作页重新确认");
  }
}

interface FusionTask {
  taskId: string;
  provider: string;
}

interface FusionResult {
  status: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED";
  videoUrl?: string;
  assetId?: string;
}

async function createTask(templateId: string, userPhotoUrl: string): Promise<FusionTask> {
  const resp = await apiFetch("/api/fusion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, userPhotoUrl }),
  });
  const json = await resp.json();
  if (json.code !== 0) throw new Error(json.message || "创建任务失败");
  return json.data;
}

async function uploadPhoto(photoDataUrl: string): Promise<string> {
  const resp = await apiFetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: photoDataUrl }),
  });
  const json = await resp.json();
  if (json.code !== 0 || !json.data?.url) throw new Error(json.message || "照片上传失败");
  return json.data.url;
}

async function pollTask(taskId: string, timeoutMs = 360_000): Promise<FusionResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await apiFetch(`/api/fusion/${taskId}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.message || "查询失败");
    const data: FusionResult = json.data;
    if (data.status === "SUCCESS" || data.status === "FAILED") return data;
  }
  throw new Error("生成超时");
}

function savePendingGeneration(value: PendingGeneration) {
  browserStorage()?.setItem(PENDING_GENERATION_KEY, JSON.stringify(value));
}

function readPendingGeneration(): PendingGeneration | null {
  try {
    const raw = browserStorage()?.getItem(PENDING_GENERATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingGeneration>;
    if (!value.taskId || !value.templateId || !value.createdAt) throw new Error("invalid pending generation");
    if (Date.now() - Date.parse(value.createdAt) > 24 * 60 * 60 * 1000) throw new Error("expired pending generation");
    return value as PendingGeneration;
  } catch {
    browserStorage()?.removeItem(PENDING_GENERATION_KEY);
    return null;
  }
}

function clearPendingGeneration(taskId?: string) {
  const pending = readPendingGeneration();
  if (!taskId || pending?.taskId === taskId) browserStorage()?.removeItem(PENDING_GENERATION_KEY);
}

export async function resumePendingCreation(): Promise<(CreationResult & { templateId: string }) | null> {
  if (USE_MOCK) return null;
  const pending = readPendingGeneration();
  if (!pending) return null;
  const result = await pollTask(pending.taskId);
  clearPendingGeneration(pending.taskId);
  if (result.status === "SUCCESS" && result.videoUrl) {
    return { kind: "video", url: result.videoUrl, assetId: result.assetId, templateId: pending.templateId };
  }
  throw new Error("上次生成任务未成功，请重新制作");
}

/**
 * 生成换脸结果。返回 { kind: "video"|"image", url }
 * 真实API返回视频URL；演示模式返回本地合成图。
 */
export async function generateFusion(
  template: Template,
  photoDataUrl: string
): Promise<CreationResult> {
  if (!USE_MOCK) {
    try {
      await ensureFaceConsent();
      const photoUrl = await uploadPhoto(photoDataUrl);
      const { taskId } = await createTask(template.id, photoUrl);
      savePendingGeneration({ taskId, templateId: template.id, createdAt: new Date().toISOString() });
      const result = await pollTask(taskId);
      clearPendingGeneration(taskId);
      if (result.status === "SUCCESS" && result.videoUrl) {
        return { kind: "video", url: result.videoUrl, assetId: result.assetId };
      }
      throw new Error("生成失败");
    } catch (e) {
      console.error("真实服务生成失败:", e);
      throw e;
    }
  }
  const url = await compositeFace(template, photoDataUrl);
  return { kind: "image", url };
}

export interface CreationResult {
  kind: "video" | "image";
  url: string;
  assetId?: string;
}

export interface RefreshedAssetUrl {
  url: string;
  contentType?: string;
  ext?: string;
}

export async function refreshAssetUrl(assetId: string): Promise<RefreshedAssetUrl> {
  const response = await apiFetch(`/api/assets/${encodeURIComponent(assetId)}/url`);
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !json.data?.url) {
    throw new Error(json.message || "作品链接已失效，请返回作品页重试");
  }
  return {
    url: json.data.url as string,
    contentType: typeof json.data.contentType === "string" ? json.data.contentType : undefined,
    ext: typeof json.data.ext === "string" ? json.data.ext : undefined,
  };
}

async function runPhotoFeature(path: string, payload: Record<string, unknown>): Promise<CreationResult> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !json.data?.url) {
    throw new Error(json.message || "影像服务暂时不可用");
  }
  return { kind: "image", url: json.data.url, assetId: json.data.assetId };
}

export async function generateCreation(template: Template, photoDataUrl: string): Promise<CreationResult> {
  if (USE_MOCK) {
    const url = await compositeFace(template, photoDataUrl);
    return { kind: "image", url };
  }

  await ensureFaceConsent();

  if (template.mode === "video-fusion") {
    return generateFusion(template, photoDataUrl);
  }

  const imageUrl = await uploadPhoto(photoDataUrl);
  switch (template.mode) {
    case "photo-restore":
      return runPhotoFeature("/api/photo/restore", { imageUrl, colorize: true });
    case "photo-age":
      return runPhotoFeature("/api/photo/age", { imageUrl, age: template.targetAge || 30 });
    case "photo-anime":
      return runPhotoFeature("/api/photo/anime", { imageUrl, style: template.animeStyle || "watercolor" });
    case "photo-bg":
      return runPhotoFeature("/api/photo/photobg", { imageUrl, bgId: template.bgId || "westlake" });
    case "photo-effect":
      return runPhotoFeature("/api/photo/effect", { imageUrl, effectId: template.effectId });
    default:
      throw new Error("暂不支持这个创作类型");
  }
}

export interface PlayProfile {
  name?: string;
  birthDate?: string;
  birthTime?: string;
  date?: string;
}

export interface PlayAnalysis {
  reply: string;
  facts: Record<string, unknown> | null;
  provider: string;
}

export interface PublicCompliance {
  status: "approved" | "pending_company_approval";
  operatorName?: string | null;
  appRecordNumber?: string | null;
  icpFilingNumber?: string | null;
  privacyPolicyUrl: string | null;
  userAgreementUrl: string | null;
  thirdPartyListUrl: string | null;
  supportContact: string | null;
  pipiaReference: string | null;
  retention?: {
    sourceHours: number;
    resultHours: number;
    supplierPolicy: string;
  } | null;
  consentVersions: { basic: string; faceProcessing: string };
  aiServices: Array<{
    provider: string;
    model: string;
    filingReference: string;
    purpose: string;
    region: string;
    capabilities?: string[];
  }>;
}

export async function getPublicCompliance(): Promise<PublicCompliance> {
  const response = await fetch(`${API_BASE}/api/public/compliance`, { cache: "no-store" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !json.data) throw new Error(json.message || "合规信息暂时不可用");
  return json.data as PublicCompliance;
}

export interface CapabilityStatus {
  id: string;
  ready: boolean;
  status: "verified" | "blocked_pending_evidence";
  sampleCount: number;
  acceptanceTarget: number;
}

export async function getCapabilities(): Promise<CapabilityStatus[]> {
  const response = await fetch(`${API_BASE}/api/capabilities`, { cache: "no-store" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !Array.isArray(json.data)) {
    throw new Error(json.message || "功能可用状态暂时无法确认");
  }
  return json.data as CapabilityStatus[];
}

export type SafetyReportCategory = "likeness" | "minor" | "rights" | "ai_label" | "harmful" | "other";

export async function submitSafetyReport({
  category,
  description,
  contact,
  templateId,
}: {
  category: SafetyReportCategory;
  description: string;
  contact?: string;
  templateId?: string;
}): Promise<{ ticketId: string }> {
  const response = await apiFetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, description, contact, templateId }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !json.data?.ticketId) throw new Error(json.message || "提交失败，请稍后重试");
  return { ticketId: String(json.data.ticketId) };
}

export async function analyzePlay({
  scene,
  input,
  profile,
}: {
  scene: string;
  input: string;
  profile?: PlayProfile;
}): Promise<PlayAnalysis> {
  const response = await apiFetch("/api/play/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene, input, profile }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !json.data?.reply) {
    throw new Error(json.message || "玩法服务暂时不可用");
  }
  return json.data as PlayAnalysis;
}

export async function getServerEntitlements(): Promise<number> {
  const response = await apiFetch("/api/account/entitlements");
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0) throw new Error(json.message || "无法读取剩余次数");
  return Number(json.data?.totalRemaining || 0);
}

export async function listServerWorks(): Promise<Work[]> {
  const response = await apiFetch("/api/works");
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !Array.isArray(json.data)) throw new Error(json.message || "无法读取作品列表");
  return json.data.map((item: { assetId: string; url: string; kind: "video" | "image"; createdAt: string }) => ({
    id: item.assetId,
    templateName: "我的作品",
    image: item.url,
    kind: item.kind,
    createdAt: Date.parse(item.createdAt) || Date.now(),
  }));
}

export interface ErasureResult {
  partial: boolean;
  supplierPending: unknown[];
}

export async function deleteServerAsset(assetId: string): Promise<ErasureResult> {
  const response = await apiFetch(`/api/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message || "作品删除失败");
  return { partial: json.code === "ERASURE_PARTIAL", supplierPending: json.data?.supplierDeletion?.status === "confirmed" ? [] : [json.data?.supplierDeletion].filter(Boolean) };
}

export async function withdrawFaceConsent(): Promise<ErasureResult> {
  const response = await apiFetch("/api/consents/face_processing/withdraw", { method: "POST" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message || "撤回授权失败");
  return { partial: json.code === "ERASURE_PARTIAL", supplierPending: Array.isArray(json.data?.supplierPending) ? json.data.supplierPending : [] };
}

export async function deleteServerAccount(): Promise<ErasureResult> {
  const response = await apiFetch("/api/account", { method: "DELETE" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message || "账号注销失败");
  clearAccountSession();
  browserStorage()?.removeItem("ly_works");
  return { partial: json.code === "ERASURE_PARTIAL", supplierPending: Array.isArray(json.data?.supplierPending) ? json.data.supplierPending : [] };
}
