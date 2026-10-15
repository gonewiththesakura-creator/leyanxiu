import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { decodeImageDataUrl } from '../media-validation.js';

// A fixed, documented mainland-China snapshot. Importing never reads credentials
// or starts a request. The caller must durably commit a one-use dispatch first.
export const QWEN_PHOTO_MODEL = 'qwen-image-edit-plus-2025-12-15';
export const QWEN_PHOTO_PROVIDER = 'aliyun-qwen-image';
export const QWEN_PHOTO_RESULT_POLICY = 'qwen-dashscope-result-url-v1';
// Documented examples, not an exhaustive service-owned bucket inventory.
export const QWEN_PHOTO_RESULT_HOSTS = Object.freeze([
  'dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com',
  'dashscope-result-hz.oss-cn-hangzhou.aliyuncs.com',
  'dashscope-result-bj.oss-cn-beijing.aliyuncs.com',
]);
const API_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const DEFAULT_API = `https://dashscope.aliyuncs.com${API_PATH}`;
const MAX_OUTPUT = 20 * 1024 * 1024;
const MAX_ERROR_BODY = 16 * 1024;
const diagnosticOperations = new Set(['transport', 'generate', 'download']);
const diagnosticStages = new Set(['request_validation', 'transport', 'dns', 'request', 'response_headers',
  'response_body', 'response_json', 'response_contract', 'result_url', 'output_decode']);
// Exact documented codes only: https://help.aliyun.com/zh/model-studio/error-code
// The code and UUID help manual investigation; none authorizes another request.
const providerCodes = new Set(['InvalidApiKey', 'invalid_api_key', 'AccessDenied', 'access_denied',
  'AccessDenied.Unpurchased', 'Model.AccessDenied', 'Workspace.AccessDenied', 'Endpoint.AccessDenied',
  'AllocationQuota.FreeTierOnly', 'Arrearage', 'ModelNotFound', 'model_not_found', 'model_not_supported',
  'WorkSpaceNotFound', 'NotFound', 'Throttling.BurstRate', 'limit_burst_rate',
  'Throttling.AllocationQuota', 'insufficient_quota', 'InvalidParameter', 'invalid_parameter_error',
  'invalid_request_error', 'InvalidParameter.DataInspection', 'DataInspectionFailed', 'data_inspection_failed',
  'InternalError', 'InternalError.Algo', 'InternalError.Algo.InvalidParameter', 'InternalError.Timeout',
  'InternalError.Configuration', 'InternalError.DataInspection', 'InternalError.TranslationFailed',
  'SystemError', 'ModelServiceFailed', 'RequestTimeOut', 'ResponseTimeout', 'ServiceUnavailable',
  'ModelUnavailable', 'GatewayTimeout.InputDownload']);
const requestId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function safeDiagnostic(value) {
  if (!value) return null;
  const { version, operation, stage, httpStatus, providerCode, requestId: providerRequestId } = value;
  if (version !== 1 || !diagnosticOperations.has(operation) || !diagnosticStages.has(stage)) return null;
  return Object.freeze({ version: 1, operation, stage,
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(providerCodes.has(providerCode) ? { providerCode } : {}),
    ...(requestId(providerRequestId) ? { requestId: providerRequestId } : {}),
    outcome: 'unknown', retryAllowed: false });
}
const diagnostic = (operation, stage, details = {}) => safeDiagnostic({ ...details, version: 1, operation, stage });
const fail = (code, details) => Object.assign(new Error(code), { code, ...(details ? { diagnostic: safeDiagnostic(details) } : {}) });
/** Private operational evidence only. Copy allowlisted fields, never serialize
 * the original Error, HTTP response, prompt or signed provider URL. This does
 * not establish whether inference ran, a charge occurred, or retry is safe. */
export function getPhotoProviderDiagnostic(error) {
  try { return safeDiagnostic(error?.diagnostic); } catch { return null; }
}
function errorFields(bytes, contentType) {
  if (contentType !== 'application/json' || !Buffer.isBuffer(bytes) || bytes.length > MAX_ERROR_BODY) return {};
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...(providerCodes.has(value.code) ? { providerCode: value.code } : {}),
      ...(requestId(value.request_id) ? { requestId: value.request_id } : {}) };
  } catch { return {}; }
}
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hosts = list => Array.isArray(list) && list.length > 0 && list.every(value => typeof value === 'string'
  && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) && !net.isIP(value) && !value.includes('..'));

/** Server configuration only; never take this value from a request or receipt.
 * https://help.aliyun.com/zh/model-studio/qwen-image-edit-api documents Beijing
 * workspace hosts and /api/v1 SDK bases, and retains the legacy Beijing host.
 * This candidate is limited to mainland Beijing. Keys from different regions
 * are not interchangeable; do not guess another endpoint or retry on failure.
 * A syntactically valid workspace host is not proof that a key can use it. */
export function checkedQwenPhotoApiEndpoint(value = DEFAULT_API) {
  if (typeof value !== 'string' || !value.length || value.length > 512
    || /[^\x21-\x7e]|\\/.test(value)) throw fail('PHOTO_PROVIDER_ENDPOINT_REJECTED');
  const source = value.includes('://') ? value : `https://${value}`;
  // Inspect the original authority/path before URL parsing can discard a port,
  // normalize dot segments, decode an encoded host or accept Unicode lookalikes.
  const parts = /^https:\/\/([^/?#]+)([^?#]*)$/.exec(source);
  if (!parts) throw fail('PHOTO_PROVIDER_ENDPOINT_REJECTED');
  const [, hostname, pathname] = parts;
  const workspace = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cn-beijing\.maas\.aliyuncs\.com$/.test(hostname);
  if (!(hostname === 'dashscope.aliyuncs.com' || workspace)
    || !['', '/', '/api/v1', '/api/v1/', API_PATH, `${API_PATH}/`].includes(pathname)) {
    throw fail('PHOTO_PROVIDER_ENDPOINT_REJECTED');
  }
  return new URL(`https://${hostname}${API_PATH}`);
}

function checkedUrl(value, allowed) {
  if (typeof value !== 'string' || value.length > 4096) throw fail('PHOTO_PROVIDER_URL_REJECTED');
  let url;
  try { url = new URL(value); } catch { throw fail('PHOTO_PROVIDER_URL_REJECTED'); }
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.port || url.username || url.password || url.hash
    || /[\u0000-\u0020\u007f\\]/.test(value)) throw fail('PHOTO_PROVIDER_URL_REJECTED');
  return url;
}

/** The API FAQ documents dynamic dashscope-* result buckets, not a fixed list:
 * https://help.aliyun.com/zh/model-studio/qwen-image-edit-api
 * This validates address syntax only, NOT bucket ownership or a signed receipt.
 * Call only for a result returned by our fixed TLS-verified DashScope API, or
 * that same server-persisted receipt. Never expose it as a user-URL fetch port.
 * The download transport still permits only the one exact validated hostname,
 * resolves/pins public IPv4 once, verifies TLS and never follows redirects. */
export function checkedQwenPhotoResultUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw fail('PHOTO_PROVIDER_URL_REJECTED');
  let parsed;
  try { parsed = new URL(value); } catch { throw fail('PHOTO_PROVIDER_URL_REJECTED'); }
  const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
  // Requiring canonical authority rejects encoded/unicode host lookalikes and
  // explicit :443 as well as credentials, trailing dots and extra DNS labels.
  if (authority !== parsed.hostname) throw fail('PHOTO_PROVIDER_URL_REJECTED');
  const match = /^(dashscope-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.(oss-accelerate|oss-cn-[a-z]{2,24}(?:-[1-9][0-9]?)?)\.aliyuncs\.com$/.exec(parsed.hostname);
  if (!match || match[1].length > 63 || match[2] === 'oss-cn-internal') throw fail('PHOTO_PROVIDER_URL_REJECTED');
  return checkedUrl(value, [parsed.hostname]);
}

function publicV4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

/** Bounded HTTPS, one request, no redirects/retries. Resolve once and pin that
 * public IPv4 into the socket lookup while TLS still validates the real host.
 * Dependencies exist only for deterministic offline transport tests. */
export function createPhotoHttpsTransport({ resolve = dns.lookup, request = https.request } = {}) {
  return async ({ url: raw, allowedHosts, method = 'GET', body, headers = {}, timeoutMs = 30_000, maxBytes = MAX_OUTPUT }) => {
    if (!hosts(allowedHosts) || !['GET', 'POST'].includes(method) || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 10 || timeoutMs > 180_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 16 || maxBytes > MAX_OUTPUT
      || (body !== undefined && (!Buffer.isBuffer(body) || body.length > 3 * 1024 * 1024))) throw fail('PHOTO_PROVIDER_REQUEST_INVALID');
    const url = checkedUrl(raw, allowedHosts);
    const content = body && Buffer.from(body);
    return new Promise((accept, reject) => {
      let done = false; let req; let res; let stage = 'dns'; let httpStatus;
      const finish = (error, value, fields = {}) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error) { req?.destroy(); res?.destroy(); reject(fail(error, diagnostic('transport', stage, { httpStatus, ...fields }))); }
        else accept(value);
      };
      const timer = setTimeout(() => finish('PHOTO_PROVIDER_TIMEOUT'), timeoutMs);
      Promise.resolve().then(async () => {
        const addresses = await resolve(url.hostname, { all: true, family: 4, verbatim: true });
        if (done) return;
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => item.family !== 4 || !publicV4(item.address))) {
          finish('PHOTO_PROVIDER_DNS_REJECTED'); return;
        }
        const address = addresses[0].address;
        stage = 'request';
        req = request(url, { method, agent: false, family: 4, servername: url.hostname, rejectUnauthorized: true,
          headers: { ...headers, 'Accept-Encoding': 'identity', ...(content ? { 'Content-Length': String(content.length) } : {}) },
          lookup: (_hostname, options, callback) => options?.all
            ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
        }, response => {
          res = response;
          if (done) { res.destroy(); return; }
          stage = 'response_headers'; httpStatus = res.statusCode;
          const responseType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          const failedHttp = res.statusCode !== 200;
          if ((res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
            || (failedHttp && responseType !== 'application/json')) {
            finish('PHOTO_PROVIDER_HTTP_UNCONFIRMED'); return;
          }
          const limit = failedHttp ? Math.min(maxBytes, MAX_ERROR_BODY) : maxBytes;
          const declared = res.headers['content-length'];
          if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > limit)) {
            finish('PHOTO_PROVIDER_RESPONSE_TOO_LARGE'); return;
          }
          stage = 'response_body';
          let length = 0; const chunks = [];
          res.on('data', chunk => {
            if (done) return;
            const bytes = Buffer.from(chunk); length += bytes.length;
            if (length > limit) { finish('PHOTO_PROVIDER_RESPONSE_TOO_LARGE'); return; }
            chunks.push(bytes);
          });
          res.on('end', () => {
            if (declared !== undefined && Number(declared) !== length) { finish('PHOTO_PROVIDER_RESPONSE_INCOMPLETE'); return; }
            const bytes = Buffer.concat(chunks, length);
            if (failedHttp) { finish('PHOTO_PROVIDER_HTTP_UNCONFIRMED', undefined, errorFields(bytes, responseType)); return; }
            finish(null, { status: 200, contentType: responseType, bytes });
          });
          res.on('error', () => finish('PHOTO_PROVIDER_NETWORK_UNCONFIRMED'));
          res.on('aborted', () => finish('PHOTO_PROVIDER_RESPONSE_INCOMPLETE'));
        });
        req.on('error', () => finish('PHOTO_PROVIDER_NETWORK_UNCONFIRMED'));
        req.end(content);
      }).catch(() => finish('PHOTO_PROVIDER_NETWORK_UNCONFIRMED'));
    });
  };
}

export function createQwenPhotoProvider({ apiKey, baseUrl = DEFAULT_API, transport = createPhotoHttpsTransport(), timeoutMs = 180_000 } = {}) {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(apiKey)
    || typeof transport !== 'function' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 10 || timeoutMs > 180_000) throw fail('PHOTO_PROVIDER_CONFIG_REQUIRED');
  const endpoint = checkedQwenPhotoApiEndpoint(baseUrl);
  return {
    async generate({ input, spec } = {}) {
      // Copy once before awaiting. The pipeline additionally compares against its
      // database snapshot; no client-provided prompt/model reaches this port.
      let frozen;
      try { frozen = structuredClone(spec); } catch { throw fail('PHOTO_PROVIDER_SPEC_REJECTED'); }
      const p = frozen?.effectParameters;
      if (frozen?.provider !== QWEN_PHOTO_PROVIDER || frozen?.model !== QWEN_PHOTO_MODEL || !p
        || !Object.keys(p).every(key => ['prompt', 'negativePrompt', 'size', 'seed', 'n', 'watermark', 'promptExtend'].includes(key))
        || typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.length > 1000
        || typeof p.negativePrompt !== 'string' || p.negativePrompt.length > 500
        || p.n !== 1 || p.watermark !== true || p.promptExtend !== false
        || !['1024*1024', '960*1280', '1280*960'].includes(p.size)
        || (p.seed !== undefined && (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 2147483647))) throw fail('PHOTO_PROVIDER_SPEC_REJECTED');
      if (!Buffer.isBuffer(input?.bytes) || input.bytes.length < 16 || input.bytes.length > 2 * 1024 * 1024
        || !['image/png', 'image/jpeg', 'image/webp'].includes(input.contentType)
        || input.byteLength !== input.bytes.length || input.sha256 !== sha(input.bytes)) throw fail('PHOTO_PROVIDER_INPUT_REJECTED');
      const bytes = Buffer.from(input.bytes);
      const source = `data:${input.contentType};base64,${bytes.toString('base64')}`;
      // Official data-URI input avoids issuing any remotely accessible source URL.
      // The shared context separately checks ownership, consent, expiry and SHA.
      try { decodeImageDataUrl(source, { maxBytes: 2 * 1024 * 1024, maxSide: 8192, maxPixels: 40_000_000 }); }
      catch { throw fail('PHOTO_PROVIDER_INPUT_REJECTED'); }
      const body = Buffer.from(JSON.stringify({ model: QWEN_PHOTO_MODEL,
        input: { messages: [{ role: 'user', content: [{ image: source }, { text: p.prompt }] }] },
        parameters: { n: 1, watermark: true, prompt_extend: false, size: p.size, negative_prompt: p.negativePrompt,
          ...(p.seed !== undefined ? { seed: p.seed } : {}) } }));
      let result, response;
      try {
        response = await transport({ url: endpoint.toString(), allowedHosts: [endpoint.hostname], method: 'POST', body,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          timeoutMs, maxBytes: 1024 * 1024 });
      } catch (error) {
        const evidence = getPhotoProviderDiagnostic(error);
        throw fail('PHOTO_PROVIDER_OUTCOME_UNCONFIRMED', diagnostic('generate', evidence?.stage || 'transport', evidence || {}));
      }
      if (response?.status !== 200 || response.contentType !== 'application/json' || !Buffer.isBuffer(response.bytes)
        || response.bytes.length > 1024 * 1024) throw fail('PHOTO_PROVIDER_OUTCOME_UNCONFIRMED', diagnostic('generate', 'response_headers', {
          httpStatus: response?.status, ...errorFields(response?.bytes, response?.contentType) }));
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)); }
      catch { throw fail('PHOTO_PROVIDER_OUTCOME_UNCONFIRMED', diagnostic('generate', 'response_json', { httpStatus: 200 })); }
      const choices = result?.output?.choices;
      const parts = choices?.[0]?.message?.content;
      if (result?.code || !identifier(result?.request_id) || !Array.isArray(choices) || choices.length !== 1
        || choices[0].finish_reason !== 'stop' || choices[0].message?.role !== 'assistant'
        || !Array.isArray(parts) || parts.length !== 1 || typeof parts[0]?.image !== 'string'
        || result?.usage?.image_count !== 1 || ![result.usage.width, result.usage.height].every(n => Number.isSafeInteger(n) && n >= 512 && n <= 2048)
        || result.usage.width * result.usage.height > 2048 * 2048) throw fail('PHOTO_PROVIDER_RESPONSE_UNCONFIRMED', diagnostic('generate', 'response_contract', {
          httpStatus: 200, ...errorFields(response.bytes, response.contentType) }));
      let url;
      try { url = checkedQwenPhotoResultUrl(parts[0].image).toString(); }
      catch { throw fail('PHOTO_PROVIDER_URL_REJECTED', diagnostic('generate', 'result_url', { httpStatus: 200, requestId: result.request_id })); }
      return { provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, requestId: result.request_id, url };
    },
    async readGenerated({ url: raw } = {}) {
      const parsed = checkedQwenPhotoResultUrl(raw);
      const url = parsed.toString();
      let response;
      try { response = await transport({ url, allowedHosts: [parsed.hostname], method: 'GET',
        headers: { Accept: 'image/png' }, timeoutMs: 30_000, maxBytes: MAX_OUTPUT }); }
      catch (error) {
        const evidence = getPhotoProviderDiagnostic(error);
        throw fail('PHOTO_PROVIDER_OUTPUT_UNCONFIRMED', diagnostic('download', evidence?.stage || 'transport', evidence || {}));
      }
      if (response?.status !== 200 || response.contentType !== 'image/png' || !Buffer.isBuffer(response.bytes)
        || response.bytes.length > MAX_OUTPUT) throw fail('PHOTO_PROVIDER_OUTPUT_UNCONFIRMED', diagnostic('download', 'response_headers', { httpStatus: response?.status }));
      const bytes = Buffer.from(response.bytes);
      try { const info = decodeImageDataUrl(`data:image/png;base64,${bytes.toString('base64')}`,
        { maxBytes: MAX_OUTPUT, maxSide: 2048, maxPixels: 2048 * 2048 });
        if (info.width < 512 || info.height < 512) throw fail('PHOTO_PROVIDER_OUTPUT_UNCONFIRMED'); }
      catch { throw fail('PHOTO_PROVIDER_OUTPUT_UNCONFIRMED', diagnostic('download', 'output_decode', { httpStatus: 200 })); }
      return { bytes, contentType: 'image/png', byteLength: bytes.length, sha256: sha(bytes) };
    },
  };
}
