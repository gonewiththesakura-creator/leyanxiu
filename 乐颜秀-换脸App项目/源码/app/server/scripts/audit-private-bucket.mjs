import fs from "node:fs";
import path from "node:path";
import OSS from "ali-oss";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PRIVATE_BUCKET_AUDIT_REPORT || path.join(root, "private-bucket-audit.json");
const required = ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "OSS_BUCKET", "OSS_REGION"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(JSON.stringify({ status: "blocked", blockers: [`missing credentials/config: ${missing.join(", ")}`] }, null, 2));
  process.exit(1);
}

const client = new OSS({ accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, region: process.env.OSS_REGION });
let marker = "";
let objectCount = 0;
let publicObjectCount = 0;
const publicObjects = [];
do {
  const page = await client.list({ prefix: process.env.OBJECT_PREFIX || "private/", marker, 'max-keys': 1000 });
  for (const object of page.objects || []) {
    objectCount += 1;
    try {
      const acl = await client.getACL(object.name);
      const grant = String(acl.acl || acl.permission || "").toLowerCase();
      if (grant.includes("public")) {
        publicObjectCount += 1;
        publicObjects.push(object.name);
      }
    } catch (error) {
      publicObjectCount += 1;
      publicObjects.push({ key: object.name, error: error.message });
    }
  }
  marker = page.isTruncated ? page.nextMarker : "";
} while (marker);

const report = { status: publicObjectCount === 0 ? "verified" : "blocked", bucket: process.env.OSS_BUCKET, prefix: process.env.OBJECT_PREFIX || "private/", objectCount, publicObjectCount, publicObjects, checkedAt: new Date().toISOString() };
fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (publicObjectCount) process.exitCode = 1;
