import type { RuntimeCatalog } from "@/data/runtimeCatalog";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const CSRF_KEY = "lyx_admin_csrf";

export interface AdminUser {
  username: string;
  displayName: string;
  role: "owner" | "operator" | "reviewer" | "auditor";
  expiresAt?: string;
}

export interface BillingOrder {
  id: string; userId: string; productId: string; amountFen: number; credits: number;
  status: string; channel?: string; createdAt: string; fulfilledAt?: string; refundedAt?: string; providerTradeId?: string;
  refundedFen?:number; productSnapshot?:{name:string}; startsAt?:string; expiresAt?:string|null;
}
export interface BillingRefund {
  id: string; orderId: string; userId: string; amountFen: number; credits: number;
  reason: string; status: string; holdActive: boolean; createdAt: string; updatedAt: string;
  reviewerId?: string; reviewReason?: string; providerRefundId?: string;
}
export interface BillingData {
  readiness: { ready: boolean; mode: string; blockers: string[] };
  operationsReadiness: { ready: boolean; blockers: string[] };
  orders: BillingOrder[]; refunds: BillingRefund[];
  reconciliation: { ok: boolean; users: number; mismatches: Array<{userId: string; referenceId?:string; expectedTrial?: number; actualTrial?: number; expectedPurchased?: number; actualPurchased?: number}> };
  products: Array<{ id: string; name: string; amountFen: number; credits: number; type?:'credits'|'monthly'; durationDays?:number|null }>;
  dailyBills?:Array<{id:string;date:string;ok:boolean;paymentFen:number;refundFen:number;differences:Array<{type:string;orderId?:string;refundId?:string}>}>;
}
export function reconcileDailyBill(date:string) {return request<{ok?:boolean;blocked?:boolean;busy?:boolean}>('/api/admin/billing/daily-bill',{method:'POST',body:JSON.stringify({date})});}

export function getBilling() { return request<BillingData>("/api/admin/billing"); }
export function reconcileBilling() {
  return request<{ checked?: number; settled?: number; errors?: number; busy?: boolean }>("/api/admin/billing/reconcile", { method: "POST", body: "{}" });
}
export function saveBillingProducts(products: BillingData["products"]) {
  return request<{ products: BillingData["products"] }>("/api/admin/billing/products", { method: "PUT", body: JSON.stringify({ products }) });
}
export function actOnRefund(refundId: string, action: "approve" | "reject" | "sync", reason?: string) {
  return request<{ refund: BillingRefund; duplicate?: boolean }>(`/api/admin/billing/refunds/${encodeURIComponent(refundId)}/${action}`, { method: "POST", body: JSON.stringify(action === "reject" ? { reason } : {}) });
}

export interface CatalogRelease {
  id: string;
  version: number;
  action: "seed" | "publish" | "rollback";
  note: string;
  publishedAt: string;
  publishedBy: string;
  sourceReleaseId?: string;
  integrityStatus?: "sealed" | "legacy-unsealed";
  integrityReason?: string;
}

export interface CatalogWorkspace {
  draft: {
    revision: number;
    updatedAt: string;
    updatedBy: string;
    note: string;
    catalog: RuntimeCatalog;
  };
  published: {
    releaseId: string;
    version: number;
    publishedAt: string;
    publishedBy: string;
    integrityStatus?: "sealed" | "legacy-unsealed";
    catalog: RuntimeCatalog;
  };
  dirty: boolean;
  releases: CatalogRelease[];
}

export interface CapabilityStatus {
  id: string;
  provider: string;
  model: string;
  configured: boolean;
  templateReady: boolean;
  passingSampleCount: number;
  acceptanceTarget: number;
  successRate: number | null;
  p95Ms: number | null;
  costFen: number | null;
  ready: boolean;
  status: string;
}

export interface DashboardData {
  catalog: {
    version: number;
    releaseId: string;
    publishedAt: string;
    enabledTemplates: number;
    enabledVideoTemplates: number;
    enabledPhotoEffects: number;
    generationEnabled: boolean;
    dirty: boolean;
    draftRevision: number;
  };
  service: {
    status: "OK" | "ALERT";
    http5xx: number;
    http5xxTotal: number;
    http5xxRate: number;
    requests: number;
    avgLatencyMs: number;
    capturedAt: string;
    alerts: Array<{ name: string; createdAt: string; details?: Record<string, unknown> }>;
    slowRoutes: Array<{ name: string; value: number; limit: number }>;
    series: Array<{ timestamp: string; requests: number; errors5xx: number; avgLatencyMs: number; routeCounts?: Record<string, number> }>;
    incidents: ServiceIncident[];
    playbooks: ServicePlaybook[];
    readiness: { ready: boolean; mode: string; backend: string; durable: boolean; blockers: string[] };
  };
  analytics: GenerationAnalytics;
  usage: {
    users: number;
    orders: number;
    ledgerEntries: number;
    reportsOpen: number;
    moderationReview: number;
    supplierDeletionPending: number;
  };
  capabilities: CapabilityStatus[];
  environment: { deploy: string; provider: string; photoProvider: string; releaseChannel: string };
}

export interface GenerationAnalyticsRow {
  purpose: string;
  calls: number;
  successes: number;
  refunds: number;
  pending: number;
  successRate?: number | null;
}

export interface GenerationAnalyticsWindow {
  days: number;
  windowStart: string;
  windowEnd: string;
  calls: number;
  successes: number;
  refunds: number;
  pending: number;
  successRate: number | null;
  byPurpose: GenerationAnalyticsRow[];
  daily: Array<{ date: string; calls: number; successes: number; refunds: number; pending: number }>;
  source: string;
}

export interface GenerationAnalytics {
  requestedDays: number;
  generatedAt: string;
  windows: Record<"7" | "30", GenerationAnalyticsWindow>;
}

export interface ServiceIncident {
  id: string;
  key: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  status: string;
  impact: string;
  action: string;
  prevention: string;
  details?: Record<string, unknown>;
  source: string;
  firstSeen: string;
  lastSeen: string;
}

export interface ManagedIncident extends ServiceIncident {
  status: "open" | "investigating" | "resolved";
  revision: number;
  assignee: string | null;
  observedActive: boolean;
  notes: Array<{ action: string; note: string; actor: string; createdAt: string }>;
}

export interface MediaAsset {
  id: string;
  url: string;
  name: string;
  kind: "image" | "video";
  mime: string;
  size: number;
  width: number;
  height: number;
  duration?: number;
  createdAt: string;
  createdBy: string;
}

export function getRisks() {
  return request<{ items: ManagedIncident[]; audits: AuditItem[] }>("/api/admin/risks");
}

export function actOnRisk(incidentId: string, expectedRevision: number, action: "claim" | "note" | "resolve" | "reopen", note: string) {
  return request<ManagedIncident>("/api/admin/risks/actions", { method: "POST", body: JSON.stringify({ incidentId, expectedRevision, action, note }) });
}

export function getMediaAssets() {
  return request<{ items: MediaAsset[]; maxBytes: number; storage?: { persistent: boolean; note: string } }>("/api/admin/media");
}

export function uploadMediaAsset(name: string, dataUrl: string, rightsReference: string) {
  return request<MediaAsset>("/api/admin/media", { method: "POST", body: JSON.stringify({ name, dataUrl, rightsConfirmed: true, rightsReference }) });
}

export interface ServicePlaybook {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  status: string;
  isPlan: true;
  trigger: string;
  impact: string;
  action: string;
  prevention: string;
  steps: string[];
  source: string;
}

export interface ReportItem {
  id: string;
  category: string;
  status: string;
  templateId?: string | null;
  createdAt: string;
  updatedAt: string;
  sensitive?: { description?: string; contact?: string } | null;
}

export interface ModerationItem {
  id: string;
  decision: "allow" | "block" | "review";
  direction: "input" | "output";
  categories: string[];
  provider: string;
  reason?: string | null;
  createdAt: string;
}

export interface AuditItem {
  id: string;
  action: string;
  actor?: string;
  reviewerId?: string;
  createdAt: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}

export type WorkflowType = "capability" | "video_template" | "photo_effect" | "visual_asset";
export type WorkflowStatus = "submitted" | "technical_review" | "integration" | "quality_validation" | "ready" | "rejected";
export type WorkflowRisk = "low" | "medium" | "high";

export interface WorkflowItem {
  id: string;
  revision: number;
  type: WorkflowType;
  name: string;
  desiredOutcome: string;
  businessOwner: string;
  providerHint: string;
  status: WorkflowStatus;
  riskLevel: WorkflowRisk;
  notes: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

function csrfToken() {
  return sessionStorage.getItem(CSRF_KEY) || "";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) headers.set("X-CSRF-Token", csrfToken());
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0) {
    const error = new Error(json.message || "请求失败") as Error & { code?: string; status?: number };
    error.code = json.code;
    error.status = response.status;
    throw error;
  }
  return json.data as T;
}

export async function login(username: string, password: string) {
  const data = await request<{ user: AdminUser; csrfToken: string; expiresAt: string }>("/api/admin/session", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  sessionStorage.setItem(CSRF_KEY, data.csrfToken);
  return { ...data.user, expiresAt: data.expiresAt };
}

export async function currentAdmin() {
  const data = await request<{ user: AdminUser; csrfToken: string }>("/api/admin/me");
  sessionStorage.setItem(CSRF_KEY, data.csrfToken);
  return data.user;
}

export async function logout() {
  try {
    await request<{ loggedOut: boolean }>("/api/admin/logout", { method: "POST", body: "{}" });
  } finally {
    sessionStorage.removeItem(CSRF_KEY);
  }
}

export function getDashboard() {
  return request<DashboardData>("/api/admin/dashboard");
}

export function getCatalogWorkspace() {
  return request<CatalogWorkspace>("/api/admin/catalog");
}

export function validateCatalogDraft(catalog: RuntimeCatalog) {
  return request<{ valid: true; catalogHash: string }>("/api/admin/catalog/validate", {
    method: "POST",
    body: JSON.stringify({ catalog }),
  });
}

export function saveCatalogDraft(catalog: RuntimeCatalog, expectedRevision: number, note: string) {
  return request<CatalogWorkspace>("/api/admin/catalog/draft", {
    method: "PUT",
    body: JSON.stringify({ catalog, expectedRevision, note }),
  });
}

export function publishCatalog(expectedRevision: number, note: string) {
  return request<CatalogWorkspace>("/api/admin/catalog/publish", {
    method: "POST",
    body: JSON.stringify({ expectedRevision, note }),
  });
}

export function rollbackCatalog(releaseId: string, note: string) {
  return request<CatalogWorkspace>("/api/admin/catalog/rollback", {
    method: "POST",
    body: JSON.stringify({ releaseId, note }),
  });
}

export function emergencyPause(reason: string) {
  return request<CatalogWorkspace>("/api/admin/emergency-pause", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function getReports() {
  return request<ReportItem[]>("/api/admin/reports?limit=300");
}

export function updateReport(reportId: string, status: string, note: string) {
  return request<ReportItem>(`/api/admin/reports/${encodeURIComponent(reportId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, note }),
  });
}

export function getModeration() {
  return request<ModerationItem[]>("/api/admin/moderation?limit=300");
}

export function decideModeration(moderationId: string, decision: "allow" | "block", reason: string) {
  return request<ModerationItem>(`/api/admin/moderation/${encodeURIComponent(moderationId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, reason }),
  });
}

export function getAudits() {
  return request<{ admin: AuditItem[]; business: AuditItem[] }>("/api/admin/audits?limit=300");
}

export function getReadiness() {
  return request<{ status: string; publicLaunchAllowed: boolean; blockers: string[]; checkedAt: string }>("/api/admin/readiness");
}

export function getWorkflows() {
  return request<WorkflowItem[]>("/api/admin/workflows?limit=500");
}

export function createWorkflow(input: {
  type: WorkflowType;
  name: string;
  desiredOutcome: string;
  businessOwner: string;
  providerHint: string;
  riskLevel: WorkflowRisk;
  notes: string;
}) {
  return request<WorkflowItem>("/api/admin/workflows", { method: "POST", body: JSON.stringify(input) });
}

export function updateWorkflow(workflowId: string, expectedRevision: number, patch: Partial<Pick<WorkflowItem, "name" | "desiredOutcome" | "businessOwner" | "providerHint" | "status" | "riskLevel" | "notes">>) {
  return request<WorkflowItem>(`/api/admin/workflows/${encodeURIComponent(workflowId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision, patch }),
  });
}
