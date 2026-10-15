import dns from "node:dns/promises";
import net from "node:net";

const PRODUCTION = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";

function explicitlyAllowed(hostname) {
  if (PRODUCTION) return false;
  return String(process.env.OUTBOUND_PRIVATE_HOST_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(hostname.toLowerCase());
}

function approvedHost(hostname) {
  const host = hostname.toLowerCase();
  return String(process.env.OUTBOUND_HOST_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry);
}

function privateAddress(address) {
  const normalized = String(address || "").toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  const ipv4 = mapped || (net.isIP(normalized) === 4 ? normalized : "");
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export async function assertSafeRemoteUrl(value, { purpose = "remote object" } = {}) {
  const raw = String(value || "");
  if (!raw || raw.length > 4096) throw new Error(`${purpose} URL 无效`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${purpose} URL 无效`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${purpose} 只允许 HTTP/HTTPS`);
  if (PRODUCTION && parsed.protocol !== "https:") throw new Error(`${purpose} 在生产环境必须使用 HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${purpose} URL 不允许包含登录凭据`);
  if (parsed.hash) throw new Error(`${purpose} URL 不允许包含片段标识`);
  if (PRODUCTION && parsed.port && parsed.port !== "443") throw new Error(`${purpose} 在生产环境不允许使用非标准端口`);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error(`${purpose} 不允许访问本机或局域网地址`);
  if (PRODUCTION && !approvedHost(hostname)) throw new Error(`${purpose} 主机不在生产出站白名单`);
  if (!explicitlyAllowed(hostname)) {
    const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error(`${purpose} 不允许访问本机或私网地址`);
  }
  return parsed.toString();
}
