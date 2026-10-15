/**
 * 任务台账 · 可插拔存储
 * 背景：云托管容器的本地磁盘是临时的，重启/重新部署 tasks.json 会丢，
 *       正在轮询的任务元数据（模板ID、背景URL）丢了就永远 RUNNING。
 *
 * 两种模式（通过 TASKS_BACKEND 显式选择，避免错误凭据污染启动）：
 *  1. 阿里云 OSS（TASKS_BACKEND=oss）
 *  2. 本地 tasks.json 文件（默认，TASKS_BACKEND=file）
 *
 * 读写策略：启动时全量载入内存，之后读走内存、写整本异步落库（500ms 防抖），
 * 轮询接口的高频读不碰远端。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OSS from "ali-oss";
import { logSecurity, safeError } from "./security-log.js";

const TASKS_FILE = process.env.TASKS_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "tasks.json");
const DEFAULT_OSS_KEY = "server/tasks.json";

/**
 * Validate the object key used for the task ledger.
 *
 * This is configuration, not user input, but a malformed key can make two
 * CloudBase services overwrite each other's ledger or escape the intended
 * prefix. Keep the accepted form deliberately small and portable.
 */
export function validateTasksOssKey(value) {
  const key = String(value ?? "");
  if (!key) throw new Error("TASKS_OSS_KEY must not be empty");
  if (key.trim() !== key) throw new Error("TASKS_OSS_KEY must not contain surrounding whitespace");
  if (key.startsWith("/") || key.endsWith("/")) throw new Error("TASKS_OSS_KEY must not start or end with '/'");
  if (key.includes("\\")) throw new Error("TASKS_OSS_KEY must not contain '\\'");
  if (key.includes("..")) throw new Error("TASKS_OSS_KEY must not contain '..'");
  if (key.includes("//")) throw new Error("TASKS_OSS_KEY must not contain empty path segments");
  if (key.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("TASKS_OSS_KEY contains an invalid path segment");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) {
    throw new Error("TASKS_OSS_KEY may contain only ASCII letters, digits, '.', '-', '_' and '/'");
  }
  return key;
}

const OSS_KEY = validateTasksOssKey(process.env.TASKS_OSS_KEY ?? DEFAULT_OSS_KEY);
let ossClient = null;
export let TASKS_BACKEND = "file";
const REQUESTED_BACKEND = String(process.env.TASKS_BACKEND || "file").toLowerCase();
const PRODUCTION = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
let persistenceError = null;

function makeOss() {
  return new OSS({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
    region: process.env.OSS_REGION,
  });
}

/** 启动时调用一次，返回内存台账对象 */
export async function initTasks() {
  if (!new Set(["file", "oss"]).has(REQUESTED_BACKEND)) {
    throw new Error(`不支持的 TASKS_BACKEND=${REQUESTED_BACKEND}；仅允许 file 或 oss`);
  }

  // 1) 阿里云 OSS（必须显式开启；业务 AK 不代表拥有该 bucket）
  if (REQUESTED_BACKEND === "oss") {
    if (!process.env.ALIYUN_ACCESS_KEY_ID || !process.env.ALIYUN_ACCESS_KEY_SECRET || !process.env.OSS_BUCKET || !process.env.OSS_REGION) {
      throw new Error("TASKS_BACKEND=oss requires explicit OSS credentials, bucket and region");
    }
    try {
      ossClient = makeOss();
      const res = await ossClient.get(OSS_KEY);
      const tasks = JSON.parse(res.content.toString("utf-8"));
      TASKS_BACKEND = "oss";
      logSecurity("info", "tasks.oss_loaded", { count: Object.keys(tasks).length });
      return tasks;
    } catch (e) {
      if (e && e.code === "NoSuchKey") {
        TASKS_BACKEND = "oss";
        logSecurity("info", "tasks.oss_initialized", {});
        return {};
      }
      if (PRODUCTION || process.env.ALLOW_TASK_STORAGE_FALLBACK !== "true") throw e;
      logSecurity("warn", "tasks.oss_fallback", safeError(e));
      ossClient = null;
    }
  }
  // 2) 本地文件
  const tasks = fs.existsSync(TASKS_FILE)
    ? JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"))
    : {};
  logSecurity("info", "tasks.file_loaded", {});
  return tasks;
}

let ossWriteChain = Promise.resolve();

export function taskStoreStatus() {
  const blockers = [];
  if (!["file", "oss"].includes(REQUESTED_BACKEND)) blockers.push(`unsupported TASKS_BACKEND=${REQUESTED_BACKEND}`);
  if (REQUESTED_BACKEND === "oss" && (!process.env.ALIYUN_ACCESS_KEY_ID || !process.env.ALIYUN_ACCESS_KEY_SECRET || !process.env.OSS_BUCKET || !process.env.OSS_REGION)) {
    blockers.push("TASKS_BACKEND=oss requires explicit OSS credentials, bucket and region");
  }
  if (persistenceError) blockers.push("task persistence is degraded after an OSS write failure");
  return { ready: blockers.length === 0, requestedBackend: REQUESTED_BACKEND, activeBackend: TASKS_BACKEND, blockers };
}

/** 写入/更新任务；调用方必须等待持久化成功后才能向客户端确认状态。 */
export async function saveTask(taskId, data, memTasks) {
  if (ossClient) {
    const snapshot = Buffer.from(JSON.stringify(memTasks));
    const operation = ossWriteChain.then(() => ossClient.put(OSS_KEY, snapshot));
    ossWriteChain = operation.catch(() => {});
    try {
      await operation;
      persistenceError = null;
    } catch (error) {
      persistenceError = safeError(error);
      logSecurity("error", "tasks.oss_write_failed", persistenceError);
      throw error;
    }
    return;
  }
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  const temporary = `${TASKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(memTasks), { mode: 0o600 });
  fs.renameSync(temporary, TASKS_FILE);
}
