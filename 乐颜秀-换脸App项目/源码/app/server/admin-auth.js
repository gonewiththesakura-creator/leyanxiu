import crypto from "node:crypto";

const PRODUCTION = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
const COOKIE_NAME = "ly_admin_session";
const SESSION_SECONDS = Math.max(900, Math.min(43_200, Number(process.env.ADMIN_SESSION_TTL_SECONDS || 14_400)));
const LOCAL_SESSION_SECRET = "local-admin-session-secret-not-for-production";
const ALLOW_INSECURE_LOCAL = !PRODUCTION && process.env.ADMIN_ALLOW_INSECURE_LOCAL === "true";
const COOKIE_SECURE = PRODUCTION || process.env.ADMIN_COOKIE_SECURE === "true";
const SESSION_SECRET = String(process.env.ADMIN_SESSION_SECRET || (ALLOW_INSECURE_LOCAL ? LOCAL_SESSION_SECRET : ""));
const SESSION_SIGNING_READY = SESSION_SECRET.length >= 32 && (SESSION_SECRET !== LOCAL_SESSION_SECRET || ALLOW_INSECURE_LOCAL);
const attempts = new Map();
const revokedSessions = new Map();

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(value) {
  if (!SESSION_SIGNING_READY) throw new Error("ADMIN_SESSION_SIGNING_NOT_CONFIGURED");
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookie(header) {
  const raw = String(header || "");
  if (raw.length > 16_384) return "";
  const entries = raw.split(";").map((part) => part.trim().split("="));
  const found = entries.find(([key]) => key === COOKIE_NAME);
  if (!found) return "";
  try {
    return decodeURIComponent(found.slice(1).join("="));
  } catch {
    return "";
  }
}

function configuredUsers() {
  const configured = String(process.env.ADMIN_USERS_JSON || "").trim();
  if (configured) {
    try {
      const users = JSON.parse(configured);
      if (Array.isArray(users)) return users.filter((user) => user && user.enabled !== false).map((user) => ({
        username: String(user.username || "").trim(),
        displayName: String(user.displayName || user.username || "管理员").trim(),
        role: ["owner", "operator", "reviewer", "auditor"].includes(user.role) ? user.role : "auditor",
        passwordHash: String(user.passwordHash || ""),
      })).filter((user) => user.username && user.passwordHash);
    } catch {
      return [];
    }
  }
  const passwordHash = String(process.env.ADMIN_PASSWORD_HASH || "");
  if (passwordHash) return [{
    username: String(process.env.ADMIN_USERNAME || "admin"),
    displayName: String(process.env.ADMIN_DISPLAY_NAME || "系统管理员"),
    role: "owner",
    passwordHash,
  }];
  if (ALLOW_INSECURE_LOCAL && process.env.ADMIN_PASSWORD) return [{
    username: String(process.env.ADMIN_USERNAME || "admin"),
    displayName: String(process.env.ADMIN_DISPLAY_NAME || "本地管理员"),
    role: "owner",
    plainPassword: String(process.env.ADMIN_PASSWORD),
  }];
  return [];
}

function verifyScrypt(password, encoded) {
  const match = /^scrypt\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/.exec(encoded);
  if (!match) return false;
  const expected = Buffer.from(match[2], "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(match[1], "base64url"), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function hashAdminPassword(password) {
  const value = String(password || "");
  if (value.length < 12 || value.length > 200) throw new Error("管理员密码长度需为 12-200 个字符");
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(value, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export function authenticateAdmin(username, password) {
  const requested = String(username || "").trim();
  const secret = String(password || "");
  if (!requested || secret.length < 1 || secret.length > 200) return null;
  const user = configuredUsers().find((candidate) => safeEqual(candidate.username, requested));
  if (!user) {
    crypto.scryptSync(secret, Buffer.alloc(16), 64);
    return null;
  }
  const valid = user.passwordHash ? verifyScrypt(secret, user.passwordHash) : !PRODUCTION && safeEqual(user.plainPassword, secret);
  return valid ? { username: user.username, displayName: user.displayName, role: user.role } : null;
}

export function allowAdminLogin(fingerprint) {
  const key = String(fingerprint || "unknown").slice(0, 200);
  const current = Date.now();
  const recent = (attempts.get(key) || []).filter((timestamp) => current - timestamp < 15 * 60_000);
  if (recent.length >= 8) return false;
  recent.push(current);
  attempts.set(key, recent);
  if (attempts.size > 2000) {
    for (const [candidate, values] of attempts) {
      if (!values.some((timestamp) => current - timestamp < 15 * 60_000)) attempts.delete(candidate);
    }
  }
  return true;
}

export function clearAdminLoginAttempts(fingerprint) {
  attempts.delete(String(fingerprint || "unknown").slice(0, 200));
}

export function createAdminSession(user) {
  if (!SESSION_SIGNING_READY) throw new Error("ADMIN_SESSION_SIGNING_NOT_CONFIGURED");
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sid: crypto.randomUUID(),
    sub: user.username,
    name: user.displayName,
    role: user.role,
    iat: issuedAt,
    exp: issuedAt + SESSION_SECONDS,
  };
  const body = encode(payload);
  const token = `${body}.${sign(body)}`;
  const csrfToken = sign(`${payload.sid}:csrf`);
  const attributes = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_SECONDS}`];
  if (COOKIE_SECURE) attributes.push("Secure");
  return { cookie: attributes.join("; "), csrfToken, user: { username: payload.sub, displayName: payload.name, role: payload.role }, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

export function clearAdminCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}`;
}

export function getAdminSession(c) {
  if (!SESSION_SIGNING_READY) return null;
  const token = parseCookie(c.req.header("cookie"));
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const body = token.slice(0, separator);
  if (!safeEqual(sign(body), token.slice(separator + 1))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const current = Math.floor(Date.now() / 1000);
    if (payload.v !== 1 || !payload.sid || !payload.sub || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > current + 60 || payload.exp <= current || payload.exp - payload.iat > SESSION_SECONDS) return null;
    if (revokedSessions.has(payload.sid)) return null;
    const user = configuredUsers().find((candidate) => candidate.username === payload.sub && candidate.role === payload.role);
    if (!user) return null;
    return { username: payload.sub, displayName: payload.name, role: payload.role, sessionId: payload.sid, expiresAt: new Date(payload.exp * 1000).toISOString() };
  } catch {
    return null;
  }
}

export function revokeAdminSession(session) {
  if (!session?.sessionId) return false;
  const expiresAt = Date.parse(session.expiresAt || "");
  revokedSessions.set(session.sessionId, Number.isFinite(expiresAt) ? expiresAt : Date.now() + SESSION_SECONDS * 1000);
  const current = Date.now();
  for (const [sessionId, expiry] of revokedSessions) {
    if (expiry <= current) revokedSessions.delete(sessionId);
  }
  return true;
}

export function csrfFor(session) {
  return sign(`${session.sessionId}:csrf`);
}

export function requireAdmin(c, { roles = [], csrf = false } = {}) {
  const session = getAdminSession(c);
  if (!session) return { response: c.json({ code: "ADMIN_AUTH_REQUIRED", message: "管理员会话已失效，请重新登录" }, 401) };
  if (roles.length && !roles.includes(session.role)) return { response: c.json({ code: "ADMIN_FORBIDDEN", message: "当前角色无权执行该操作" }, 403) };
  if (csrf && !safeEqual(csrfFor(session), c.req.header("x-csrf-token"))) return { response: c.json({ code: "ADMIN_CSRF_REJECTED", message: "请求校验失败，请刷新后台后重试" }, 403) };
  return { session };
}

export function adminAuthReadiness() {
  const users = configuredUsers();
  const blockers = [];
  if (!SESSION_SIGNING_READY) blockers.push("ADMIN_SESSION_SECRET must be a separate 32+ character secret; insecure local mode must be explicitly enabled");
  if (PRODUCTION && !process.env.ADMIN_USERS_JSON) blockers.push("ADMIN_USERS_JSON with named RBAC accounts is required in production");
  if (!users.length) blockers.push("no administrator account is configured");
  if (process.env.DEPLOY_ENV === "staging" && !COOKIE_SECURE) blockers.push("ADMIN_COOKIE_SECURE=true is required for HTTPS staging administration");
  if (PRODUCTION && users.length < 2) blockers.push("at least two named administrators are required for independent publish approval");
  if (PRODUCTION) blockers.push("administrator MFA and durable cross-instance session revocation are not implemented");
  return { ready: blockers.length === 0, sessionSigningReady: SESSION_SIGNING_READY, configuredUsers: users.length, roles: [...new Set(users.map((user) => user.role))], blockers };
}
