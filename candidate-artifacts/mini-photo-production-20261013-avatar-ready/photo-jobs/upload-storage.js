import { createHash } from 'node:crypto';
import OSS from 'ali-oss';

const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
const validKey = key => {
  if (!/^private\/mini-photo-input\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(key || '')) throw fail('PHOTO_UPLOAD_STORAGE_KEY_INVALID');
};

/** Existing private OSS byte storage, separate immutable prefix, no public URL.
 * Credentials are explicit server dependencies. No .env loading or network at construction.
 */
export function createPhotoUploadOssStorage({ credential, bucket, region, client } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '') || !/^cn-[a-z]+(?:-[a-z]+)?$/.test(region || '')) throw fail('PHOTO_UPLOAD_STORAGE_CONFIG_REQUIRED');
  if (!client && (!credential?.accessKeyId || !credential?.accessKeySecret)) throw fail('PHOTO_UPLOAD_STORAGE_CREDENTIAL_REQUIRED');
  const sdk = client || new OSS({ accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret,
    ...(credential.securityToken ? { stsToken: credential.securityToken } : {}), bucket, region: `oss-${region}`, secure: true, retryMax: 0 });
  const type = headers => String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  return {
    async put(key, bytes, { contentType, timeoutMs }) {
      validKey(key);
      if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > 2097152 || !allowed.has(contentType)) throw fail('PHOTO_UPLOAD_STORAGE_IMAGE_INVALID');
      await sdk.put(key, bytes, { timeout: timeoutMs, headers: { 'Content-Type': contentType,
        'Cache-Control': 'private, no-store', 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true',
        'x-oss-meta-sha256': hash(bytes) } });
    },
    async read(key, { timeoutMs } = {}) {
      validKey(key);
      try {
        const head = await sdk.head(key, { timeout: timeoutMs });
        const length = Number(head.res?.headers?.['content-length']);
        const contentType = type(head.res?.headers);
        if (!Number.isSafeInteger(length) || length < 16 || length > 2097152 || !allowed.has(contentType)) throw fail('PHOTO_UPLOAD_STORAGE_IMAGE_INVALID');
        // HEAD checks the bound first. GET verifies actual bytes; metadata SHA
        // alone cannot prove the object matches the frozen request.
        const response = await sdk.get(key, { timeout: timeoutMs, headers: { Range: 'bytes=0-2097152' } });
        const bytes = response.content;
        if (!Buffer.isBuffer(bytes) || bytes.length !== length || type(response.res?.headers) !== contentType) throw fail('PHOTO_UPLOAD_STORAGE_IMAGE_INVALID');
        return { found: true, bytes, contentType, byteLength: bytes.length, sha256: hash(bytes) };
      } catch (error) {
        if (error?.code === 'NoSuchKey' || error?.status === 404) return { found: false };
        throw fail('PHOTO_UPLOAD_STORAGE_UNCONFIRMED');
      }
    },
    async delete(key, { timeoutMs } = {}) { validKey(key); await sdk.delete(key, { timeout: timeoutMs }); },
  };
}

/** Destructive port restricted to ONE explicitly selected immutable prefix.
 * No list, arbitrary URL, byte upload or recursive deletion capability is exposed.
 */
export function createPhotoCleanupOssStorage({ kind, credential, bucket, region, client } = {}) {
  if (!['source', 'moderation'].includes(kind) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '')
    || !/^cn-[a-z]+(?:-[a-z]+)?$/.test(region || '')) throw fail('PHOTO_UPLOAD_CLEANUP_STORAGE_CONFIG_REQUIRED');
  if (!client && (!credential?.accessKeyId || !credential?.accessKeySecret)) throw fail('PHOTO_UPLOAD_STORAGE_CREDENTIAL_REQUIRED');
  const sdk = client || new OSS({ accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret,
    ...(credential.securityToken ? { stsToken: credential.securityToken } : {}), bucket, region: `oss-${region}`, secure: true, retryMax: 0 });
  const keyCheck = key => {
    const prefix = kind === 'source' ? 'mini-photo-input' : 'photo-moderation';
    if (!new RegExp(`^private/${prefix}/[a-f0-9]{32}\\.(jpg|png|webp)$`).test(key || '')) throw fail('PHOTO_UPLOAD_CLEANUP_KEY_INVALID');
  };
  return {
    async delete(key, { timeoutMs }) {
      keyCheck(key);
      try {
        const result = await sdk.delete(key, { timeout: timeoutMs });
        if (![200, 204].includes(result?.res?.status)) throw fail('PHOTO_UPLOAD_CLEANUP_DELETE_UNCONFIRMED');
        return { acknowledged: true };
      } catch { throw fail('PHOTO_UPLOAD_CLEANUP_DELETE_UNCONFIRMED'); }
    },
    async inspect(key, { timeoutMs }) {
      keyCheck(key);
      try {
        const result = await sdk.head(key, { timeout: timeoutMs });
        if (result?.res?.status !== 200) throw fail('PHOTO_UPLOAD_CLEANUP_HEAD_UNCONFIRMED');
        return { found: true };
      } catch (error) {
        // Installed ali-oss maps an authenticated HEAD 404 to NoSuchKey.
        // This is only this observation; not proof against a future/late PUT.
        if (error?.code === 'NoSuchKey' && error.status === 404) return { found: false };
        throw fail('PHOTO_UPLOAD_CLEANUP_HEAD_UNCONFIRMED');
      }
    },
  };
}
