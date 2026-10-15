import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import OSS from "ali-oss";

export const COMPLIANCE_OSS_KEY = "server/stage/compliance.json";
const MAX_BYTES = 32 * 1024 * 1024;
const OBJECT_FIELDS = ["users", "sessions", "orders", "paymentEvents", "entitlements", "moderation", "authChallenges", "reports"];
const ARRAY_FIELDS = ["consents", "ledger", "audits", "supplierDeletions", "usageEvents"];

export function validateComplianceBytes(value) {
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("COMPLIANCE_INVALID_SIZE");
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!parsed || parsed.schemaVersion !== 1) throw new Error("COMPLIANCE_INVALID_SCHEMA");
  for (const field of OBJECT_FIELDS) {
    if (parsed[field] !== undefined && (!parsed[field] || typeof parsed[field] !== "object" || Array.isArray(parsed[field]))) throw new Error("COMPLIANCE_INVALID_SCHEMA");
    if (parsed[field] && Object.values(parsed[field]).some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("COMPLIANCE_INVALID_ROW");
  }
  for (const field of ARRAY_FIELDS) {
    if (parsed[field] !== undefined && !Array.isArray(parsed[field])) throw new Error("COMPLIANCE_INVALID_SCHEMA");
    if (parsed[field]?.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("COMPLIANCE_INVALID_ROW");
  }
  if (!parsed.users || !parsed.sessions || !Array.isArray(parsed.ledger)) throw new Error("COMPLIANCE_INVALID_SCHEMA");
  return bytes;
}

export class CompliancePersistence {
  constructor({ client, file }) {
    this.client = client; this.file = file; this.failed = false; this.chain = Promise.resolve(); this.pending = 0;
  }
  assertHealthy() { if (this.failed) throw Object.assign(new Error("业务账本持久化异常，已暂停操作"), { code: "COMPLIANCE_PERSISTENCE_UNAVAILABLE" }); }
  async restore() {
    try {
      let bytes;
      try { bytes = validateComplianceBytes((await this.client.get(COMPLIANCE_OSS_KEY)).content); }
      catch (error) {
        if (error.code !== "NoSuchKey") throw error;
        if (fs.existsSync(this.file)) {
          this.enqueue(validateComplianceBytes(fs.readFileSync(this.file)));
          await this.flush();
        }
        return;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${crypto.randomUUID()}.restore`;
      try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, this.file); }
      finally { fs.rmSync(temporary, { force: true }); }
    } catch (error) { this.failed = true; throw error; }
  }
  enqueue(value) {
    this.assertHealthy();
    const bytes = validateComplianceBytes(value);
    this.pending += 1;
    this.chain = this.chain.then(async () => {
      this.assertHealthy();
      await this.client.put(COMPLIANCE_OSS_KEY, bytes, { headers: { "x-oss-object-acl": "private" } });
    }).catch(() => { this.failed = true; }).finally(() => { this.pending -= 1; });
  }
  async flush() {
    // Include writes enqueued while the caller was waiting for a preceding snapshot.
    let previous;
    do { previous = this.chain; await previous; } while (previous !== this.chain);
    this.assertHealthy();
  }
  readiness() { return { ready: !this.failed, backend: "oss-single-instance-snapshot", durable: !this.failed && this.pending === 0, pending: this.pending, productionSupported: false, singleInstanceOnly: true }; }
}

export async function initializeCompliancePersistence(file) {
  const backend = process.env.COMPLIANCE_BACKEND || "file";
  if (backend === "file") return null;
  if (backend !== "oss" || process.env.DEPLOY_ENV !== "staging") throw new Error("COMPLIANCE_OSS_ONLY_SUPPORTS_SINGLE_INSTANCE_STAGING");
  for (const key of ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "OSS_BUCKET", "OSS_REGION"]) if (!process.env[key]) throw new Error("COMPLIANCE_OSS_NOT_CONFIGURED");
  const client = new OSS({ secure: true, accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, region: process.env.OSS_REGION, timeout: 60000 });
  const persistence = new CompliancePersistence({ client, file });
  await persistence.restore();
  return persistence;
}
