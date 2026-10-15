import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { initializeCompliancePersistence } from "./compliance-persistence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = process.env.COMPLIANCE_STORE_FILE || path.join(DATA_DIR, "compliance.json");
const PRODUCTION = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";

function initialState() {
  return {
    schemaVersion: 1,
    users: {},
    sessions: {},
    consents: [],
    orders: {},
    refunds: {},
    paymentEvents: {},
    entitlements: {},
    ledger: [],
    audits: [],
    moderation: {},
    supplierDeletions: [],
    usageEvents: [],
    authChallenges: {},
    reports: {},
  };
}

function loadState() {
  if (!fs.existsSync(STORE_FILE)) return initialState();
  const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1) throw new Error(`不支持的合规台账版本: ${STORE_FILE}`);
  return { ...initialState(), ...parsed };
}

const sqlite = process.env.COMPLIANCE_BACKEND === "sqlite"
  ? (await import("./compliance-sqlite.js")).createComplianceSqlite(process.env.COMPLIANCE_SQLITE_FILE, initialState)
  : null;
const sqliteEvidence = sqlite ? (await import("./compliance-sqlite.js")).sqliteProductionEvidence : null;
if (!sqlite) fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
const persistence = sqlite ? null : await initializeCompliancePersistence(STORE_FILE);
let state = sqlite ? initialState() : loadState();
let transactionDepth = 0;

function transactionalCall(callback) {
  if (!sqlite || transactionDepth) return callback();
  const prior = state;
  try {
    return sqlite.transact(snapshot => {
      state = { ...initialState(), ...snapshot };
      transactionDepth++;
      try { const result = callback(); return { state, result }; }
      finally { transactionDepth--; }
    });
  } catch (error) {
    state = prior;
    throw error;
  }
}

function persist() {
  if (sqlite) {
    if (!transactionDepth) throw new Error("COMPLIANCE_WRITE_OUTSIDE_TRANSACTION");
    return;
  }
  persistence?.assertHealthy();
  try {
    const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const bytes = Buffer.from(JSON.stringify(state));
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, STORE_FILE);
    persistence?.enqueue(bytes);
  } catch (error) {
    if (persistence) persistence.failed = true;
    throw error;
  }
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generationPurpose(value) {
  const normalized = String(value || "unknown").trim();
  return /^[A-Za-z0-9:_-]{1,80}$/.test(normalized) ? normalized : "unknown";
}

function validAnalyticsDays(value, fallback = 7) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 90 ? parsed : fallback;
}

function reportEncryptionKey() {
  const secret = String(process.env.REPORT_DATA_ENCRYPTION_KEY || (PRODUCTION ? "" : process.env.AUTH_SESSION_SECRET) || "");
  return secret.length >= 32 ? crypto.createHash("sha256").update(secret).digest() : null;
}

function sealReportValue(value) {
  const key = reportEncryptionKey();
  if (!key) {
    const error = new Error("REPORT_ENCRYPTION_NOT_CONFIGURED");
    error.code = "REPORT_ENCRYPTION_NOT_CONFIGURED";
    throw error;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function openReportValue(envelope) {
  const key = reportEncryptionKey();
  if (!key || envelope?.version !== 1 || envelope?.algorithm !== "aes-256-gcm") return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

function reportRetentionDays() {
  const configured = Number(process.env.REPORT_RETENTION_DAYS || 180);
  return Number.isSafeInteger(configured) ? Math.max(1, Math.min(3650, configured)) : 180;
}

function pruneAuthChallenges(now = Date.now()) {
  let changed = false;
  for (const [challengeId, challenge] of Object.entries(state.authChallenges)) {
    const staleUsed = challenge.usedAt && Date.parse(challenge.usedAt) < now - 10 * 60_000;
    const expired = Date.parse(challenge.expiresAt) < now - 10 * 60_000;
    if (staleUsed || expired) {
      delete state.authChallenges[challengeId];
      changed = true;
    }
  }
  return changed;
}

function getEntitlementRow(userId) {
  if (!state.entitlements[userId]) {
    state.entitlements[userId] = {
      trialRemaining: 0,
      purchasedRemaining: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  return state.entitlements[userId];
}

function trialAccessAllowed() {
  const production = [process.env.DEPLOY_ENV, process.env.NODE_ENV]
    .some((value) => String(value || '').toLowerCase() === 'production');
  return !production && process.env.CLOSED_TEST_MODE === 'true';
}

function addAudit(event) {
  state.audits.push({
    id: id("audit"),
    createdAt: new Date().toISOString(),
    ...event,
  });
  if (state.audits.length > 5000) state.audits.splice(0, state.audits.length - 5000);
}

export const store = new Proxy({
  file: sqlite ? process.env.COMPLIANCE_SQLITE_FILE : STORE_FILE,

  createOrGetUser({ subject, channel = "unknown", authMethod = "anonymous" }) {
    const subjectHash = crypto.createHash("sha256").update(String(subject)).digest("hex");
    const existing = Object.values(state.users).find((user) => user.subjectHash === subjectHash && !user.deletedAt);
    if (existing) return clone(existing);

    const user = {
      id: id("usr"),
      subjectHash,
      channel,
      authMethod,
      createdAt: new Date().toISOString(),
      status: "active",
    };
    state.users[user.id] = user;
    getEntitlementRow(user.id);
    persist();
    return clone(user);
  },

  // vp_accounts owns the stable mini-program ID. Only a server-verified
  // mapping may enter here; never allocate or silently merge another user.
  ensureMiniUser({ userId, appId, openid }) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId || "")
      || !/^[A-Za-z0-9_-]{1,80}$/.test(appId || "")
      || !/^[A-Za-z0-9_-]{1,128}$/.test(openid || "")) throw new Error("XPAY_IDENTITY_INVALID");
    const subjectHash = crypto.createHash("sha256").update(`wechat:${appId}:${openid}`).digest("hex");
    const existing = state.users[userId];
    if (existing && (existing.deletedAt || existing.status !== "active")) throw new Error("XPAY_ACCOUNT_UNAVAILABLE");
    const subjectUser = Object.values(state.users).find(user => user.subjectHash === subjectHash);
    if ((subjectUser && subjectUser.id !== userId)
      || (existing && (existing.subjectHash !== subjectHash || existing.channel !== "wechat" || existing.authMethod !== "wechat"))) {
      throw new Error("XPAY_IDENTITY_CONFLICT");
    }
    const legacyHash = crypto.createHash("sha256").update(`wechat:${openid}`).digest("hex");
    if (!existing && Object.values(state.users).some(user => user.subjectHash === legacyHash && !user.deletedAt)) {
      throw new Error("XPAY_LEGACY_IDENTITY_REVIEW_REQUIRED");
    }
    if (existing) return clone(existing);
    const user = { id: userId, subjectHash, channel: "wechat", authMethod: "wechat",
      createdAt: new Date().toISOString(), status: "active" };
    state.users[userId] = user;
    getEntitlementRow(userId);
    persist();
    return clone(user);
  },

  miniUserAvailable({ userId, appId, openid }) {
    const user = state.users[userId];
    const expected = crypto.createHash("sha256").update(`wechat:${appId}:${openid}`).digest("hex");
    return Boolean(user && !user.deletedAt && user.status === "active" && user.channel === "wechat"
      && user.authMethod === "wechat" && user.subjectHash === expected);
  },

  findUserBySubject(subject) {
    const subjectHash = crypto.createHash("sha256").update(String(subject)).digest("hex");
    const user = Object.values(state.users).find((item) => item.subjectHash === subjectHash && !item.deletedAt);
    return user ? clone(user) : null;
  },

  activeUserCount() {
    return Object.values(state.users).filter((user) => !user.deletedAt && user.status === "active").length;
  },

  getUser(userId) {
    const user = state.users[userId];
    return user && !user.deletedAt ? clone(user) : null;
  },

  createSession({ userId, tokenHash, channel, expiresAt, sessionId }) {
    const session = {
      id: sessionId || id("ses"),
      userId,
      tokenHash,
      channel,
      createdAt: new Date().toISOString(),
      expiresAt,
      revokedAt: null,
    };
    state.sessions[session.id] = session;
    persist();
    return clone(session);
  },

  findSession(sessionId) {
    const session = state.sessions[sessionId];
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
    const user = state.users[session.userId];
    if (!user || user.deletedAt || user.status !== "active") return null;
    return { session: clone(session), user: clone(user) };
  },

  revokeSession(sessionId, reason = "logout") {
    const session = state.sessions[sessionId];
    if (!session) return false;
    if (session.revokedAt) {
      if (session.tokenHash != null) { session.tokenHash = null; persist(); }
      return false;
    }
    session.revokedAt = new Date().toISOString();
    session.revokeReason = reason;
    session.tokenHash = null;
    persist();
    return true;
  },

  revokeUserSessions(userId, reason = "account_action") {
    let count = 0;
    let changed = false;
    for (const session of Object.values(state.sessions)) {
      if (session.userId !== userId) continue;
      if (!session.revokedAt) {
        session.revokedAt = new Date().toISOString();
        session.revokeReason = reason;
        count += 1;
        changed = true;
      }
      if (session.tokenHash != null) { session.tokenHash = null; changed = true; }
    }
    if (changed) persist();
    return count;
  },

  // Only credentials/session metadata are in scope. Consent, audits and money stay intact.
  retainAccountSessions({ now = Date.now(), apply = false } = {}) {
    if (!Number.isSafeInteger(now) || now < 0 || typeof apply !== "boolean") throw new Error("ACCOUNT_RETENTION_OPTIONS_INVALID");
    const counts = { sessionTokenHashesCleared: 0, sessionsDeleted: 0, invalidSessionTimes: 0 };
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const expiresAt = Date.parse(session.expiresAt);
      const revokedAt = session.revokedAt ? Date.parse(session.revokedAt) : NaN;
      if (!Number.isFinite(expiresAt) || (session.revokedAt && !Number.isFinite(revokedAt))) counts.invalidSessionTimes++;
      const endedAt = Math.min(...[expiresAt, revokedAt].filter(Number.isFinite));
      if (endedAt <= now - 7 * 86_400_000) {
        counts.sessionsDeleted++;
        if (apply) delete state.sessions[sessionId];
      } else if ((session.revokedAt || expiresAt <= now) && session.tokenHash != null) {
        counts.sessionTokenHashesCleared++;
        if (apply) session.tokenHash = null;
      }
    }
    if (apply && (counts.sessionTokenHashesCleared || counts.sessionsDeleted)) persist();
    return counts;
  },

  createAuthChallenge({ challengeId, publicKeySpki, keyFingerprint, challengeDigest, expiresAt, channel = "android" }) {
    const pruned = pruneAuthChallenges();
    const configuredLimit = Number(process.env.AUTH_CHALLENGE_MAX_ACTIVE || 10_000);
    const maxChallenges = Number.isSafeInteger(configuredLimit) ? Math.max(100, Math.min(100_000, configuredLimit)) : 10_000;
    const activeCount = Object.values(state.authChallenges).filter((item) => !item.usedAt && Date.parse(item.expiresAt) > Date.now()).length;
    if (activeCount >= maxChallenges) {
      if (pruned) persist();
      const error = new Error("AUTH_CHALLENGE_CAPACITY");
      error.code = "AUTH_CHALLENGE_CAPACITY";
      throw error;
    }
    const challenge = {
      id: challengeId || id("dch"),
      publicKeySpki,
      keyFingerprint,
      challengeDigest,
      channel,
      createdAt: new Date().toISOString(),
      expiresAt,
      usedAt: null,
    };
    state.authChallenges[challenge.id] = challenge;
    persist();
    return clone(challenge);
  },

  consumeAuthChallenge({ challengeId, publicKeySpki, challengeDigest }) {
    const challenge = state.authChallenges[challengeId];
    if (!challenge) return { ok: false, error: "AUTH_CHALLENGE_NOT_FOUND" };
    if (challenge.usedAt) return { ok: false, error: "AUTH_CHALLENGE_REPLAYED" };
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      challenge.usedAt = new Date().toISOString();
      challenge.failure = "expired";
      persist();
      return { ok: false, error: "AUTH_CHALLENGE_EXPIRED" };
    }
    const sameKey = challenge.publicKeySpki === publicKeySpki;
    const sameChallenge = challenge.challengeDigest === challengeDigest;
    if (!sameKey || !sameChallenge) return { ok: false, error: "AUTH_CHALLENGE_MISMATCH" };
    challenge.usedAt = new Date().toISOString();
    persist();
    return { ok: true, challenge: clone(challenge) };
  },

  recordConsent({ userId, consentType, version, action, purpose, dataTypes, suppliers, evidence }) {
    const entry = {
      id: id("consent"),
      userId,
      consentType,
      version,
      action,
      purpose,
      dataTypes: [...new Set(dataTypes || [])],
      suppliers: [...new Set(suppliers || [])],
      evidence: evidence || {},
      occurredAt: new Date().toISOString(),
    };
    state.consents.push(entry);
    addAudit({ userId, action: `consent.${action}`, resourceType: "consent", resourceId: entry.id, consentType, version });
    persist();
    return clone(entry);
  },

  hasActiveConsent(userId, consentType, version) {
    const entries = state.consents
      .filter((item) => item.userId === userId && item.consentType === consentType && (!version || item.version === version))
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    return entries.at(-1)?.action === "granted";
  },

  activeConsent(userId, consentType, version) {
    const entries = state.consents
      .filter((item) => item.userId === userId && item.consentType === consentType && (!version || item.version === version))
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const latest = entries.at(-1);
    return latest?.action === "granted" ? clone(latest) : null;
  },

  listConsents(userId) {
    return clone(state.consents.filter((item) => item.userId === userId));
  },

  createOrder({ userId, productId, amountFen, currency = "CNY", channel, idempotencyKey, credits = 0 }) {
    const existing = Object.values(state.orders).find((order) => order.userId === userId && order.idempotencyKey === idempotencyKey);
    if (existing) {
      const sameRequest = existing.productId === productId
        && existing.amountFen === amountFen
        && existing.currency === currency
        && existing.credits === credits
        && existing.channel === channel;
      return sameRequest
        ? { order: clone(existing), duplicate: true }
        : { order: clone(existing), duplicate: false, conflict: true, error: "IDEMPOTENCY_KEY_CONFLICT" };
    }
    const order = {
      id: id("ord"),
      userId,
      productId,
      amountFen,
      credits: Number.isInteger(credits) && credits > 0 ? credits : 0,
      currency,
      channel,
      idempotencyKey,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.orders[order.id] = order;
    addAudit({ userId, action: "order.created", resourceType: "order", resourceId: order.id, productId, channel });
    persist();
    return { order: clone(order), duplicate: false };
  },

  getOrder(orderId, userId) {
    const order = state.orders[orderId];
    if (!order || (userId && order.userId !== userId)) return null;
    return clone(order);
  },

  closePaymentOrder(orderId, userId) {
    const order = state.orders[orderId];
    if (!order || order.userId !== userId) return { error: 'ORDER_NOT_FOUND' };
    if (order.status === 'closed') return { order: clone(order), duplicate: true };
    if (order.status !== 'pending') return { error: 'PAYMENT_TRANSITION_INVALID' };
    order.status = 'closed'; order.updatedAt = new Date().toISOString();
    addAudit({ userId, action: 'order.closed', resourceType: 'order', resourceId: order.id });
    persist(); return { order: clone(order), duplicate: false };
  },

  applyPaymentEvent({ eventId, orderId, status, providerTradeId, rawDigest }) {
    if (!["paid", "refunded"].includes(status)) return { duplicate: false, error: "PAYMENT_STATUS_INVALID" };
    if (state.paymentEvents[eventId]) {
      const existingEvent = state.paymentEvents[eventId];
      const sameEvent = existingEvent.orderId === orderId
        && existingEvent.status === status
        && (existingEvent.providerTradeId || "") === (providerTradeId || "")
        && (existingEvent.rawDigest || "") === (rawDigest || "");
      return sameEvent
        ? { duplicate: true, event: clone(existingEvent), order: this.getOrder(existingEvent.orderId) }
        : { duplicate: false, error: "PAYMENT_EVENT_ID_CONFLICT" };
    }
    const order = state.orders[orderId];
    if (!order) return { duplicate: false, error: "ORDER_NOT_FOUND" };
    if (!/^[a-f0-9]{64}$/i.test(String(rawDigest || ""))) return { duplicate: false, error: "PAYMENT_EVENT_DIGEST_INVALID" };
    if (status === "paid" && !String(providerTradeId || "").trim()) return { duplicate: false, error: "PAYMENT_TRADE_ID_REQUIRED" };
    if (status === "refunded" && (!providerTradeId || order.providerTradeId !== providerTradeId)) return { duplicate: false, error: "PAYMENT_TRADE_ID_CONFLICT" };
    if (status === "paid" && !["pending", "paid"].includes(order.status)) return { duplicate: false, error: "PAYMENT_TRANSITION_INVALID" };
    if (status === "refunded" && !["paid", "refunded"].includes(order.status)) return { duplicate: false, error: "PAYMENT_TRANSITION_INVALID" };
    if (!["pending", "paid", "refunded"].includes(order.status)) return { duplicate: false, error: "PAYMENT_TRANSITION_INVALID" };
    if (status === "paid" && order.providerTradeId && providerTradeId && order.providerTradeId !== providerTradeId) {
      return { duplicate: false, error: "PAYMENT_TRADE_ID_CONFLICT" };
    }
    if (status === "paid" && Object.values(state.orders).some((item) => item.id !== orderId && item.providerTradeId === providerTradeId)) {
      return { duplicate: false, error: "PAYMENT_TRADE_ID_CONFLICT" };
    }
    const event = {
      id: id("pay"),
      eventId,
      orderId,
      status,
      providerTradeId: providerTradeId || null,
      rawDigest: rawDigest || null,
      createdAt: new Date().toISOString(),
    };
    state.paymentEvents[eventId] = event;
    order.status = status;
    order.updatedAt = new Date().toISOString();
    if (status === "paid" && !order.fulfilledAt) {
      const row = getEntitlementRow(order.userId);
      const credits = Number(order.credits || 0);
      row.purchasedRemaining += credits;
      row.updatedAt = new Date().toISOString();
      order.fulfilledAt = new Date().toISOString();
      order.providerTradeId = providerTradeId || null;
      state.ledger.push({ id: id("led"), userId: order.userId, type: "grant", amount: credits, unit: "creation", bucket: "purchasedRemaining", reason: "payment", referenceId: order.id, createdAt: new Date().toISOString() });
    }
    if (status === "refunded" && !order.refundedAt) {
      const row = getEntitlementRow(order.userId);
      const credits = Number(order.credits || 0);
      const heldRefund = Object.values(state.refunds).find(item => item.orderId === order.id && item.holdActive);
      const held = heldRefund ? heldRefund.credits : 0;
      const revoked = Math.min(row.purchasedRemaining, Math.max(0, credits - held));
      row.purchasedRemaining -= revoked;
      row.updatedAt = new Date().toISOString();
      order.refundedAt = new Date().toISOString();
      order.refundedCredits = revoked + held;
      order.refundShortfall = credits - revoked - held;
      if (heldRefund) { heldRefund.holdActive = false; heldRefund.status = "succeeded"; heldRefund.updatedAt = order.refundedAt; }
      state.ledger.push({ id: id("led"), userId: order.userId, type: "revoke", amount: -revoked, unit: "creation", bucket: "purchasedRemaining", reason: "refund", referenceId: order.id, createdAt: new Date().toISOString() });
    }
    addAudit({ userId: order.userId, action: `payment.${status}`, resourceType: "order", resourceId: order.id, eventId });
    persist();
    return { duplicate: false, event: clone(event), order: clone(order) };
  },

  requestRefund(orderId, userId, reason) {
    const order = state.orders[orderId];
    if (!order || order.userId !== userId) return { error: "ORDER_NOT_FOUND" };
    const existing = Object.values(state.refunds).find(item => item.orderId === orderId);
    if (existing) return { refund: clone(existing), order: clone(order), duplicate: true };
    if (order.status !== "paid" || order.refundedAt || !order.fulfilledAt) return { error: "REFUND_ORDER_NOT_PAID" };
    if (!Number.isSafeInteger(order.credits) || order.credits <= 0) return { error: "REFUND_CREDITS_INVALID" };
    const row = getEntitlementRow(userId);
    if (row.purchasedRemaining < order.credits) return { error: "REFUND_CREDITS_IN_USE" };
    const now = new Date().toISOString();
    const refund = { id: crypto.randomUUID().replaceAll("-", ""), orderId, userId, amountFen: order.amountFen, credits: order.credits, reason: String(reason || "用户申请退款").slice(0, 200), status: "requested", holdActive: true, createdAt: now, updatedAt: now };
    state.refunds[refund.id] = refund;
    row.purchasedRemaining -= refund.credits; row.updatedAt = now;
    state.ledger.push({ id: id("led"), userId, type: "refund_hold", amount: -refund.credits, unit: "creation", bucket: "purchasedRemaining", reason: "refund_hold", referenceId: refund.id, createdAt: now });
    addAudit({ userId, action: "refund.requested", resourceType: "refund", resourceId: refund.id });
    persist();
    return { refund: clone(refund), order: clone(order), duplicate: false };
  },

  getRefund(refundId, userId) {
    const refund = state.refunds[refundId];
    return refund && (!userId || refund.userId === userId) ? clone(refund) : null;
  },

  listRefunds(userId) { return clone(Object.values(state.refunds).filter(item => !userId || item.userId === userId)); },

  paymentProducts() { return state.paymentProducts === undefined ? null : clone(state.paymentProducts); },

  savePaymentProducts(products, reviewerId) {
    if (!reviewerId || !Array.isArray(products) || products.length > 50) throw new Error("INVALID_PAYMENT_PRODUCTS");
    const seen = new Set();
    const validated = products.map(item => {
      if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)
        || !Number.isSafeInteger(item.amountFen) || item.amountFen <= 0 || item.amountFen > 1000000
        || !Number.isSafeInteger(item.credits) || item.credits <= 0 || item.credits > 100000
        || typeof item.name !== "string" || !item.name.trim() || Buffer.byteLength(item.name.trim(), "utf8") > 127) throw new Error("INVALID_PAYMENT_PRODUCTS");
      seen.add(item.id);
      return { id: item.id, name: item.name.trim(), amountFen: item.amountFen, credits: item.credits };
    });
    state.paymentProducts = validated;
    addAudit({ action: "payment.products.updated", resourceType: "payment_products", reviewerId, details: { count: validated.length, products: validated } });
    persist(); return clone(validated);
  },

  approveRefund(refundId, reviewerId) {
    const refund = state.refunds[refundId];
    if (!refund) return { error: "REFUND_NOT_FOUND" };
    if (refund.status === "processing") return { refund: clone(refund), duplicate: true };
    if (refund.status !== "requested" || !reviewerId) return { error: "REFUND_TRANSITION_INVALID" };
    refund.status = "processing"; refund.reviewerId = reviewerId; refund.updatedAt = new Date().toISOString();
    addAudit({ userId: refund.userId, action: "refund.approved", resourceType: "refund", resourceId: refundId, reviewerId });
    persist(); return { refund: clone(refund), duplicate: false };
  },

  rejectRefund(refundId, reviewerId, reason, { authoritativeClosed = false } = {}) {
    const refund = state.refunds[refundId];
    if (!refund) return { error: "REFUND_NOT_FOUND" };
    if (refund.status === "rejected") return { refund: clone(refund), duplicate: true };
    if (refund.status === "succeeded") return { error: "REFUND_TRANSITION_INVALID" };
    if (refund.status !== "requested" && !authoritativeClosed) return { error: "REFUND_AUTHORITATIVE_STATUS_REQUIRED" };
    if (!reviewerId || !reason) return { error: "REFUND_REVIEW_REQUIRED" };
    if (refund.holdActive) {
      const row = getEntitlementRow(refund.userId); row.purchasedRemaining += refund.credits; row.updatedAt = new Date().toISOString();
      state.ledger.push({ id: id("led"), userId: refund.userId, type: "refund_release", amount: refund.credits, unit: "creation", bucket: "purchasedRemaining", reason: "refund_rejected", referenceId: refundId, createdAt: row.updatedAt });
    }
    refund.holdActive = false; refund.status = "rejected"; refund.reviewReason = String(reason).slice(0, 200); refund.updatedAt = new Date().toISOString();
    addAudit({ userId: refund.userId, action: "refund.rejected", resourceType: "refund", resourceId: refundId, reviewerId });
    persist(); return { refund: clone(refund), duplicate: false };
  },

  applyRefundResult({ refundId, status, providerRefundId, providerTradeId }) {
    const refund = state.refunds[refundId];
    if (!refund) return { error: "REFUND_NOT_FOUND" };
    const order = state.orders[refund.orderId];
    if (!providerTradeId || providerTradeId !== order.providerTradeId) return { error: "PAYMENT_TRADE_ID_CONFLICT" };
    if (!providerRefundId || (refund.providerRefundId && refund.providerRefundId !== providerRefundId) || Object.values(state.refunds).some(item => item.id !== refundId && item.providerRefundId === providerRefundId)) return { error: "REFUND_PROVIDER_ID_CONFLICT" };
    if (!["SUCCESS", "PROCESSING", "ABNORMAL", "CLOSED"].includes(status)) return { error: "REFUND_STATUS_INVALID" };
    if (refund.status === "succeeded") return status === "SUCCESS" ? { refund: clone(refund), duplicate: true } : { error: "REFUND_TRANSITION_INVALID" };
    if (refund.status === "rejected" && refund.providerRefundId === providerRefundId && status === "CLOSED") return { refund: clone(refund), duplicate: true };
    if (!["processing", "abnormal"].includes(refund.status)) return { error: "REFUND_TRANSITION_INVALID" };
    refund.providerRefundId = providerRefundId;
    if (status === "SUCCESS") {
      const result = this.applyPaymentEvent({ eventId: `refund:${refundId}`, orderId: order.id, status: "refunded", providerTradeId, rawDigest: crypto.createHash("sha256").update(`${refundId}:${providerRefundId}:SUCCESS`).digest("hex") });
      if (result.error) throw new Error(result.error);
    } else if (status === "CLOSED") return this.rejectRefund(refundId, "provider", "provider refund closed", { authoritativeClosed: true });
    else refund.status = status === "ABNORMAL" ? "abnormal" : "processing";
    refund.updatedAt = new Date().toISOString(); persist();
    return { refund: clone(refund), duplicate: false };
  },

  grantTrial(userId, amount, referenceId = `trial:${userId}`) {
    if (!trialAccessAllowed() || !Number.isSafeInteger(amount) || amount <= 0) return false;
    if (state.ledger.some((entry) => entry.userId === userId && entry.referenceId === referenceId)) return false;
    const row = getEntitlementRow(userId);
    row.trialRemaining += amount;
    row.updatedAt = new Date().toISOString();
    state.ledger.push({ id: id("led"), userId, type: "grant", amount, unit: "creation", bucket: "trialRemaining", reason: "closed_test", referenceId, createdAt: new Date().toISOString() });
    persist();
    return true;
  },

  reserveCreation(userId, referenceId, purpose = "unknown") {
    const existing = state.ledger.find((entry) => entry.userId === userId && entry.type === "consume" && entry.referenceId === referenceId);
    if (existing) {
      if (existing.status === "refunded") return { ok: false, duplicate: true, error: "GENERATION_REFERENCE_REFUNDED" };
      if (!existing.purpose && purpose) {
        existing.purpose = generationPurpose(purpose);
        persist();
      }
      return { ok: true, duplicate: true, ledgerId: existing.id };
    }
    const row = getEntitlementRow(userId);
    const trialRemaining = trialAccessAllowed() ? row.trialRemaining : 0;
    if (trialRemaining + row.purchasedRemaining <= 0) return { ok: false, duplicate: false };
    const bucket = trialRemaining > 0 ? "trialRemaining" : "purchasedRemaining";
    row[bucket] -= 1;
    row.updatedAt = new Date().toISOString();
    const entry = {
      id: id("led"),
      userId,
      type: "consume",
      amount: -1,
      unit: "creation",
      reason: "generation",
      purpose: generationPurpose(purpose),
      status: "pending",
      referenceId,
      bucket,
      createdAt: new Date().toISOString(),
    };
    state.ledger.push(entry);
    persist();
    return { ok: true, duplicate: false, ledgerId: entry.id };
  },

  confirmCreation(userId, referenceId, purpose = "unknown") {
    const consume = state.ledger.find((entry) => entry.userId === userId && entry.type === "consume" && entry.reason === "generation" && entry.referenceId === referenceId);
    if (!consume) return false;
    if (consume.status === "refunded") return false;
    if (consume.status === "success") return true;
    consume.purpose = generationPurpose(consume.purpose || purpose);
    consume.status = "success";
    consume.outcomeAt = new Date().toISOString();
    consume.successAt = consume.outcomeAt;
    persist();
    return true;
  },

  recordProviderUsage({ userId, purpose, referenceId }) {
    const existing = state.usageEvents.find((entry) => entry.userId === userId && entry.referenceId === referenceId);
    if (existing) return { recorded: false, duplicate: true, event: clone(existing) };
    const event = {
      id: id("use"),
      userId,
      purpose: String(purpose || "provider-call").slice(0, 120),
      referenceId,
      createdAt: new Date().toISOString(),
    };
    state.usageEvents.push(event);
    if (state.usageEvents.length > 20_000) state.usageEvents.splice(0, state.usageEvents.length - 20_000);
    persist();
    return { recorded: true, duplicate: false, event: clone(event) };
  },

  refundCreation(userId, referenceId, reason = "generation_failed") {
    const existing = state.ledger.find((entry) => entry.userId === userId && entry.type === "refund" && entry.referenceId === referenceId);
    if (existing) return false;
    const consume = state.ledger.find((entry) => entry.userId === userId && entry.type === "consume" && entry.referenceId === referenceId);
    if (!consume) return false;
    if (consume.status === "refunded" || consume.status === "success") return false;
    const row = getEntitlementRow(userId);
    row[consume.bucket] += 1;
    row.updatedAt = new Date().toISOString();
    const refundedAt = new Date().toISOString();
    consume.status = "refunded";
    consume.outcomeAt = refundedAt;
    consume.refundedAt = refundedAt;
    consume.refundReason = String(reason || "generation_failed").slice(0, 120);
    state.ledger.push({ id: id("led"), userId, type: "refund", amount: 1, unit: "creation", reason, purpose: generationPurpose(consume.purpose), referenceId, bucket: consume.bucket, createdAt: refundedAt });
    persist();
    return true;
  },

  entitlements(userId) {
    const row = getEntitlementRow(userId);
    const trialRemaining = trialAccessAllowed() ? row.trialRemaining : 0;
    return {
      trialRemaining,
      purchasedRemaining: row.purchasedRemaining,
      totalRemaining: trialRemaining + row.purchasedRemaining,
      updatedAt: row.updatedAt,
    };
  },

  countGenerationReservationsSince(since, userId) {
    const threshold = Date.parse(since);
    if (!Number.isFinite(threshold)) throw new Error("invalid reservation window");
    return state.ledger.filter((entry) => (
      entry.type === "consume"
      && entry.reason === "generation"
      && (!userId || entry.userId === userId)
      && Date.parse(entry.createdAt) >= threshold
    )).length;
  },

  countProviderUsageSince(since, userId) {
    const threshold = Date.parse(since);
    if (!Number.isFinite(threshold)) throw new Error("invalid usage window");
    const generationCalls = this.countGenerationReservationsSince(since, userId);
    const otherCalls = state.usageEvents.filter((entry) => (
      (!userId || entry.userId === userId)
      && Date.parse(entry.createdAt) >= threshold
    )).length;
    return generationCalls + otherCalls;
  },

  generationAnalytics({ days = 7, now = Date.now() } = {}) {
    const requestedDays = validAnalyticsDays(days);
    const end = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const windows = [7, 30].map((windowDays) => {
      const startDate = new Date(end);
      startDate.setUTCHours(0, 0, 0, 0);
      startDate.setUTCDate(startDate.getUTCDate() - (windowDays - 1));
      const start = startDate.getTime();
      const dayKeys = Array.from({ length: windowDays }, (_, index) => {
        const date = new Date(start);
        date.setUTCDate(date.getUTCDate() + index);
        return date.toISOString().slice(0, 10);
      });
      const byPurpose = new Map();
      const daily = new Map(dayKeys.map((day) => [day, { date: day, calls: 0, successes: 0, refunds: 0, pending: 0 }]));
      const refunds = new Set(state.ledger.filter((entry) => entry.type === "refund" && entry.referenceId).map((entry) => `${entry.userId}:${entry.referenceId}`));
      const reservations = state.ledger.filter((entry) => {
        const created = Date.parse(entry.createdAt);
        return entry.type === "consume" && entry.reason === "generation" && Number.isFinite(created) && created >= start && created <= end;
      });
      for (const entry of reservations) {
        const purpose = generationPurpose(entry.purpose);
        const row = byPurpose.get(purpose) || { purpose, calls: 0, successes: 0, refunds: 0, pending: 0 };
        row.calls += 1;
        const refunded = entry.status === "refunded" || refunds.has(`${entry.userId}:${entry.referenceId}`);
        const success = !refunded && (entry.status === "success" || Boolean(entry.successAt));
        if (refunded) row.refunds += 1;
        else if (success) row.successes += 1;
        else row.pending += 1;
        byPurpose.set(purpose, row);
        const day = new Date(Date.parse(entry.createdAt)).toISOString().slice(0, 10);
        const point = daily.get(day);
        if (!point) continue;
        point.calls += 1;
        if (refunded) point.refunds += 1;
        else if (success) point.successes += 1;
        else point.pending += 1;
      }
      const summarize = (row) => ({
        ...row,
        successRate: row.calls ? Number((row.successes / row.calls).toFixed(4)) : null,
      });
      const totals = [...byPurpose.values()].reduce((total, row) => ({
        calls: total.calls + row.calls,
        successes: total.successes + row.successes,
        refunds: total.refunds + row.refunds,
        pending: total.pending + row.pending,
      }), { calls: 0, successes: 0, refunds: 0, pending: 0 });
      return {
        days: windowDays,
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(end).toISOString(),
        ...summarize(totals),
        byPurpose: [...byPurpose.values()]
          .sort((left, right) => right.calls - left.calls || left.purpose.localeCompare(right.purpose))
          .map(summarize),
        daily: [...daily.values()],
        source: "compliance-ledger",
      };
    });
    return {
      requestedDays,
      generatedAt: new Date(end).toISOString(),
      windows: Object.fromEntries(windows.map((item) => [String(item.days), item])),
    };
  },

  listOrders(userId) {
    return Object.values(state.orders)
      .filter((order) => !userId || order.userId === userId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map(clone);
  },

  reconcileEntitlements() {
    const byUser = {};
    for (const userId of Object.keys(state.entitlements)) {
      byUser[userId] = { expectedTrial: 0, expectedPurchased: 0, actualTrial: state.entitlements[userId].trialRemaining, actualPurchased: state.entitlements[userId].purchasedRemaining };
    }
    for (const entry of state.ledger) {
      if (!byUser[entry.userId]) byUser[entry.userId] = { expectedTrial: 0, expectedPurchased: 0, actualTrial: 0, actualPurchased: 0 };
      const bucket = entry.bucket === "purchasedRemaining" ? "expectedPurchased" : entry.bucket === "trialRemaining" ? "expectedTrial" : null;
      if (bucket) byUser[entry.userId][bucket] += Number(entry.amount || 0);
    }
    const mismatches = Object.entries(byUser).filter(([, row]) => row.expectedTrial !== row.actualTrial || row.expectedPurchased !== row.actualPurchased).map(([userId, row]) => ({ userId, ...row }));
    return { users: Object.keys(byUser).length, mismatches, ok: mismatches.length === 0 };
  },

  recordAudit(event) {
    addAudit(event);
    persist();
  },

  listAudits({ userId, limit = 200 } = {}) {
    return clone(state.audits.filter((item) => !userId || item.userId === userId).slice(-Math.max(1, Math.min(1000, limit))));
  },

  createReport({ userId, category, description, contact = "", assetId = null, templateId = null, evidence = {} }) {
    const now = new Date();
    const report = {
      id: id("rpt"),
      userId,
      category,
      assetId: assetId || null,
      templateId: templateId || null,
      sensitive: sealReportValue({ description, contact }),
      descriptionDigest: crypto.createHash("sha256").update(String(description)).digest("hex"),
      evidence,
      status: "submitted",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      sensitiveExpiresAt: new Date(now.getTime() + reportRetentionDays() * 86_400_000).toISOString(),
    };
    state.reports[report.id] = report;
    addAudit({
      userId,
      action: "report.submitted",
      resourceType: "report",
      resourceId: report.id,
      details: { category, assetId: report.assetId, templateId: report.templateId },
    });
    persist();
    return clone({ ...report, sensitive: undefined });
  },

  listReports({ status, limit = 200 } = {}) {
    return Object.values(state.reports)
      .filter((item) => !status || item.status === status)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, Math.max(1, Math.min(1000, limit)))
      .map((item) => ({ ...clone(item), sensitive: openReportValue(item.sensitive) }));
  },

  updateReport(idValue, { status, reviewerId, note = "" } = {}) {
    const report = state.reports[idValue];
    if (!report || !["submitted", "processing", "resolved", "rejected"].includes(status)) return null;
    report.status = status;
    report.reviewerId = reviewerId || null;
    report.reviewNote = String(note || "").slice(0, 500);
    report.updatedAt = new Date().toISOString();
    addAudit({
      userId: report.userId,
      action: `report.${status}`,
      resourceType: "report",
      resourceId: idValue,
      reviewerId: reviewerId || null,
      details: { note: report.reviewNote },
    });
    persist();
    return { ...clone(report), sensitive: openReportValue(report.sensitive) };
  },

  purgeExpiredReportData(now = Date.now()) {
    if (!Number.isFinite(now)) throw new Error("invalid report retention time");
    const purged = [];
    for (const report of Object.values(state.reports)) {
      if (!report.sensitive || !report.sensitiveExpiresAt || Date.parse(report.sensitiveExpiresAt) > now) continue;
      report.sensitive = null;
      report.descriptionDigest = null;
      if (report.evidence && typeof report.evidence === "object") {
        report.evidence = { ...report.evidence, networkFingerprint: null };
      }
      report.purgedAt = new Date(now).toISOString();
      report.updatedAt = report.purgedAt;
      purged.push(report.id);
      addAudit({
        userId: report.userId,
        action: "report.sensitive_data_purged",
        resourceType: "report",
        resourceId: report.id,
        details: { category: report.category },
      });
    }
    if (purged.length) persist();
    return purged;
  },

  recordModeration({ userId, assetId, taskId, direction, decision, categories, provider, policyVersion, reason }) {
    const item = {
      id: id("mod"),
      userId,
      assetId: assetId || null,
      taskId: taskId || null,
      direction,
      decision,
      categories: categories || [],
      provider: provider || "local-rules",
      policyVersion,
      reason: reason || null,
      createdAt: new Date().toISOString(),
    };
    state.moderation[item.id] = item;
    addAudit({ userId, action: `moderation.${decision}`, resourceType: "moderation", resourceId: item.id, taskId: taskId || null });
    persist();
    return clone(item);
  },

  getModeration(idValue) {
    return state.moderation[idValue] ? clone(state.moderation[idValue]) : null;
  },

  listModeration({ decision, limit = 200 } = {}) {
    return Object.values(state.moderation)
      .filter((item) => !decision || item.decision === decision)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, Math.max(1, Math.min(1000, limit)))
      .map(clone);
  },

  recordSupplierDeletion({ objectId, provider, status, details = {} }) {
    const entry = {
      id: id("del"),
      objectId,
      provider: provider || "unknown",
      status,
      details,
      createdAt: new Date().toISOString(),
    };
    state.supplierDeletions.push(entry);
    if (state.supplierDeletions.length > 5000) state.supplierDeletions.splice(0, state.supplierDeletions.length - 5000);
    addAudit({ action: `supplier_deletion.${status}`, resourceType: "supplier_copy", resourceId: entry.id, details: { objectId, provider, ...details } });
    persist();
    return clone(entry);
  },

  listSupplierDeletions() {
    return clone(state.supplierDeletions);
  },

  decideModeration(idValue, { decision, reviewerId, reason = null } = {}) {
    const item = state.moderation[idValue];
    if (!item || !["allow", "block", "review"].includes(decision)) return null;
    item.decision = decision;
    item.reviewerId = reviewerId || null;
    item.reviewedAt = new Date().toISOString();
    item.reviewReason = reason;
    addAudit({ userId: item.userId, action: `moderation.reviewed.${decision}`, resourceType: "moderation", resourceId: idValue, reviewerId: reviewerId || null });
    persist();
    return clone(item);
  },

  markUserDeleted(userId) {
    const user = state.users[userId];
    if (!user || user.deletedAt) return false;
    user.status = "deleted";
    user.deletedAt = new Date().toISOString();
    this.revokeUserSessions(userId, "account_deleted");
    user.subjectHash = null;
    for (const session of Object.values(state.sessions)) {
      if (session.userId === userId) session.tokenHash = null;
    }
    addAudit({ userId, action: "account.deleted", resourceType: "user", resourceId: userId });
    persist();
    return true;
  },

  snapshot() {
    return clone({
      schemaVersion: state.schemaVersion,
      users: Object.values(state.users).map(({ subjectHash, ...user }) => user),
      sessions: Object.values(state.sessions).map(({ tokenHash, ...session }) => session),
      consentCount: state.consents.length,
      orderCount: Object.keys(state.orders).length,
      ledgerCount: state.ledger.length,
      auditCount: state.audits.length,
      moderationCount: Object.keys(state.moderation).length,
      supplierDeletionCount: state.supplierDeletions.length,
      reportCount: Object.keys(state.reports).length,
      activeAuthChallengeCount: Object.values(state.authChallenges).filter((item) => !item.usedAt && Date.parse(item.expiresAt) > Date.now()).length,
    });
  },
}, { get(target, property, receiver) {
  const value = Reflect.get(target, property, receiver);
  if (typeof value !== "function") return value;
  return function (...args) { persistence?.assertHealthy(); return transactionalCall(() => value.apply(this, args)); };
} });

export async function flushComplianceStore() {
  await persistence?.flush();
}

export function resetStoreForTests() {
  transactionalCall(() => { state = initialState(); persist(); });
}

export function complianceStoreReadiness() {
  if (sqlite) { const evidence = sqliteEvidence(); return {
    ...sqlite.readiness(),
    ...evidence,
    ready: !PRODUCTION || evidence.ready,
    productionSupported: evidence.ready,
    file: PRODUCTION ? null : process.env.COMPLIANCE_SQLITE_FILE,
    blockers: PRODUCTION ? evidence.blockers : [],
  }; }
  const blockers = PRODUCTION
    ? ["durable transactional compliance ledger and tested backup/restore are not implemented; local JSON is closed-test only"]
    : [];
  if (persistence?.failed) blockers.push("compliance persistence failed; requests must remain blocked until recovery");
  return {
    ...(persistence?.readiness() || { durable: false, singleInstanceOnly: true }),
    ready: blockers.length === 0,
    backend: persistence ? "oss-single-instance-snapshot" : "local-json",
    productionSupported: false,
    file: PRODUCTION ? null : STORE_FILE,
    blockers,
  };
}
