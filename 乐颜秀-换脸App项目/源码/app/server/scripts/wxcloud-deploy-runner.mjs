import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const MAX_PAYLOAD_BYTES = 1024 * 1024;

async function readPayload() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PAYLOAD_BYTES) throw new Error("wxcloud deploy payload is too large");
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.args) || payload.args.some((value) => typeof value !== "string")) {
    throw new Error("wxcloud deploy payload is invalid");
  }
  return payload;
}

const payload = await readPayload();
const cliRoot = path.resolve(path.dirname(String(payload.wxcloudBin || "")), "..");
const commandPath = path.join(cliRoot, "lib", "commands", "run", "deploy.js");
if (!fs.existsSync(commandPath)) throw new Error("wxcloud deploy command module was not found");
const require = createRequire(path.join(cliRoot, "package.json"));
const RunDeployCommand = require("./lib/commands/run/deploy.js").default;
const { readLoginState } = require("./lib/utils/auth.js");
const { initCloudAPI } = require("./lib/api/adapter.js");
if (!RunDeployCommand || typeof RunDeployCommand.run !== "function") throw new Error("wxcloud deploy command module is incompatible");
const { appid } = await readLoginState();
initCloudAPI(appid);
try {
  await RunDeployCommand.run(payload.args, cliRoot);
} catch (error) {
  if (error?.oclif?.exit !== 0) throw error;
}
