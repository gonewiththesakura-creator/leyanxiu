import crypto from "node:crypto";
import { store } from "./compliance-store.js";

const CLOSED_TEST_SECRET = "closed-test-session-secret-change-before-production-2026";
const SECRET = process.env.AUTH_SESSION_SECRET || CLOSED_TEST_SECRET;
const requestedTtl = Number(process.env.AUTH_SESSION_TTL_SECONDS || 86_400);
const SESSION_TTL_SECONDS = Number.isFinite(requestedTtl) ? Math.min(604_800, Math.max(300, Math.trunc(requestedTtl))) : 86_400;
const AUTH_MODE = String(process.env.AUTH_MODE || "anonymous").toLowerCase();
const AUTH_COOKIE_ENABLED = String(process.env.AUTH_COOKIE_ENABLED || "false").toLowerCase() === "true";
const PRODUCTION = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
const RELEASE_CHANNEL = String(process.env.RELEASE_CHANNEL || "wechat-mini-program").toLowerCase();

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function signature(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authReadiness() {
  const blockers = [];
  if (PRODUCTION && (!process.env.AUTH_SESSION_SECRET || process.env.AUTH_SESSION_SECRET.length < 32)) {
    blockers.push("AUTH_SESSION_SECRET must be a 32+ character production secret");
  }
  if (PRODUCTION && RELEASE_CHANNEL === "wechat-mini-program" && AUTH_MODE !== "wechat") {
    blockers.push("AUTH_MODE=wechat is required for public mini-program identity");
  }
  if (PRODUCTION && RELEASE_CHANNEL === "android-app" && AUTH_MODE !== "device_key") {
    blockers.push("AUTH_MODE=device_key is required for Android production identity");
  }
  if(PRODUCTION && RELEASE_CHANNEL==='android-app' && process.env.APP_LOGIN_ENABLED!=='true') blockers.push('APP_LOGIN_ENABLED=true required for recoverable App accounts');
  if (PRODUCTION && !["wechat-mini-program", "android-app"].includes(RELEASE_CHANNEL)) {
    blockers.push(`unsupported production RELEASE_CHANNEL=${RELEASE_CHANNEL}`);
  }
  if (PRODUCTION && process.env.CLOSED_TEST_MODE === "true") blockers.push("CLOSED_TEST_MODE must be false in production");
  return {
    ready: blockers.length === 0,
    blockers,
    mode: AUTH_MODE,
    production: PRODUCTION,
    identityScope: AUTH_MODE === "device_key" ? "device-possession-only" : AUTH_MODE,
  };
}

export function realNameReadiness() {
  const mode = String(process.env.REAL_NAME_AUTH_MODE || "not_configured").trim().toLowerCase();
  const provider = String(process.env.REAL_NAME_AUTH_PROVIDER || "").trim();
  const configuredAsVerified = String(process.env.REAL_NAME_AUTH_VERIFIED || "false").toLowerCase() === "true";
  const blockers = [];
  if (PRODUCTION) {
    if (["", "none", "not_configured", "device_key"].includes(mode)) {
      blockers.push("a real-name identity verification mode is required independently of device_key");
    }
    if (!provider) blockers.push("REAL_NAME_AUTH_PROVIDER must identify the contracted identity verifier");
    if (!configuredAsVerified) blockers.push("REAL_NAME_AUTH_VERIFIED=true requires completed provider acceptance evidence");
    // No verifier callback/token binding exists in this codebase yet. Configuration alone must never unlock launch.
    blockers.push("real-name verification adapter and per-user verification binding are not implemented");
  }
  return {
    ready: blockers.length === 0,
    mode,
    provider: provider || null,
    configuredAsVerified,
    implemented: false,
    blockers,
  };
}

export function createSession({ subject, channel = "unknown", authMethod = AUTH_MODE, grantTrial = true }) {
  const user = store.createOrGetUser({ subject, channel, authMethod });
  if (grantTrial && !PRODUCTION && String(process.env.CLOSED_TEST_MODE || "true") === "true") {
    const amount = Math.max(0, Number(process.env.CLOSED_TEST_CREDITS || 12));
    if (amount) store.grantTrial(user.id, amount);
  }

  return createSessionForUser(user.id, { channel, authMethod });
}

export function createSessionForUser(userId, { channel = 'android', authMethod = 'phone', deviceId, deviceVersion, authenticatedAt } = {}) {
  const user = store.getUser(userId);
  if (!user || user.status !== 'active') throw new Error('ACCOUNT_UNAVAILABLE');
  const sessionId = `ses_${crypto.randomUUID()}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sid: sessionId,
    sub: user.id,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
    channel,
    authMethod,
    ...(deviceId ? {deviceId,deviceVersion:deviceVersion || null,authenticatedAt:authenticatedAt || 0} : {}),
  };
  const body = encode(payload);
  const token = `${body}.${signature(body)}`;
  store.createSession({
    sessionId,
    userId: user.id,
    tokenHash: hash(token),
    channel,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  });
  return { token, user: { id: user.id, channel: user.channel, authMethod: user.authMethod }, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

export function authenticateToken(token) {
  if (!token || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const body = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  if (!safeEqual(signature(body), provided)) return null;
  let payload;
  try {
    payload = decode(body);
  } catch {
    return null;
  }
  if (payload.v !== 1 || !payload.sid || !payload.sub || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  const found = store.findSession(payload.sid);
  if (!found || found.user.id !== payload.sub || !safeEqual(found.session.tokenHash, hash(token))) return null;
  return {
    userId: found.user.id,
    user: found.user,
    sessionId: found.session.id,
    channel: payload.channel,
    authMethod: payload.authMethod,
    deviceId:payload.deviceId,deviceVersion:payload.deviceVersion || null,authenticatedAt:payload.authenticatedAt || 0,
    expiresAt: found.session.expiresAt,
  };
}

export function requestToken(request) {
  const authorization = request.header("authorization") || "";
  if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, "").trim();
  if (!AUTH_COOKIE_ENABLED) return "";
  const cookie = request.header("cookie") || "";
  const match = /(?:^|;\s*)ly_session=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : "";
}

export function getAuth(c) {
  return authenticateToken(requestToken(c.req));
}

// The async database check runs once before legacy synchronous route handlers.
// A selected mini-program installation must never fall back to another token.
export function miniIdentityMiddleware({ enabled, identity }) {
  return async (c, next) => {
    if (!enabled()) return next();
    c.set("miniIdentitySelected", true);
    c.set("auth", null);
    const authorization = c.req.header("authorization");
    if (typeof authorization === "string" && /^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)) {
      try { c.set("auth", await (await identity()).authenticateBearer(authorization)); }
      catch { return c.json({ code: "AUTH_SERVICE_UNAVAILABLE", message: "登录服务暂不可用，请稍后重试" }, 503); }
    }
    return next();
  };
}

export function requireAuth(c) {
  const auth = c.get("miniIdentitySelected") ? c.get("auth") : getAuth(c);
  if (!auth) {
    return { response: c.json({ code: "AUTH_REQUIRED", message: "请先完成登录或建立测试会话" }, 401) };
  }
  c.set("auth", auth);
  return { auth };
}

export function revokeAuth(auth, reason = "logout") {
  return store.revokeSession(auth.sessionId, reason);
}

export function authConfig() {
  return { mode: AUTH_MODE, production: PRODUCTION, ttlSeconds: SESSION_TTL_SECONDS };
}
