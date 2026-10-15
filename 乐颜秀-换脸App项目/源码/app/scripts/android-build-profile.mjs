import path from "node:path";

const ACCOUNT_ENV = Object.freeze({
  VITE_API_BASE: "https://REDACTED_COMPANY_INFRASTRUCTURE",
  VITE_PRIVACY_POLICY_URL: "https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/privacy.html",
  VITE_USER_AGREEMENT_URL: "https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/terms.html",
  VITE_APP_ACCOUNT_ONLY: "true",
  VITE_CLOSED_TEST_INVITE_REQUIRED: "true",
  VITE_APP_CHANNEL: "app",
  VITE_USE_MOCK: "false",
});

function validUrl(value, name, publicHttps = false) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} 必须是有效的 App HTTP(S) 地址`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name} 必须是无账号信息及片段的 HTTP(S) 地址`);
  }
  if (publicHttps) {
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const unsafeHost = !host.includes(".") || host.includes(":")
      || /^(?:0|10|127|169\.254|192\.168)\./.test(host)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
      || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
      || /(?:^|\.)(?:localhost|local|invalid|example|test)$/.test(host)
      || /(?:^|\.)example\.(?:com|net|org)$/.test(host);
    if (parsed.protocol !== "https:" || unsafeHost) throw new Error(`release ${name} 必须使用公网 HTTPS 地址，拒绝本机、私网和示例地址`);
  }
  return value;
}

function javaProperty(name, value, platform) {
  if (/["\r\n\0]/.test(value)) throw new Error(`${name} 临时目录包含不支持的字符`);
  const normalized = platform === "win32" ? value.replaceAll("\\", "/") : value;
  // JAVA_TOOL_OPTIONS is parsed by the JVM, not by the shell. Keep a path with
  // spaces inside one property token, including on machines with spaced usernames.
  return `-D${name}="${normalized}"`;
}

export function quoteWindowsBatchArgument(value) {
  if (/["%\r\n\0]/.test(value)) throw new Error("Windows 构建路径或参数不能包含引号、百分号或换行");
  return `"${value}"`;
}

// Pure: no environment mutation, directory creation, Web build, or Gradle launch.
export function resolveAndroidBuildProfile({ profile = "debug", sourceEnv = {}, projectDir, platform = process.platform }) {
  if (!["debug", "release", "account"].includes(profile)) throw new Error("用法: node scripts/build-android.mjs <debug|release|account>");
  const variant = profile === "account" ? "debug" : profile;
  const env = { ...sourceEnv };
  if (profile === "account") {
    if (String(sourceEnv.VITE_ACCOUNT_ONLY || "").trim()) throw new Error("账号测试使用 VITE_APP_ACCOUNT_ONLY，请移除未使用的 VITE_ACCOUNT_ONLY");
    for (const [name, expected] of Object.entries(ACCOUNT_ENV)) {
      const supplied = String(sourceEnv[name] || "").trim();
      const actual = name === "VITE_API_BASE" ? supplied.replace(/\/$/, "") : supplied;
      if (actual && actual !== expected) throw new Error(`account 构建配置冲突：${name}；请清除旧环境值或使用已核实的账号测试配置`);
      env[name] = expected;
    }
  }
  const apiBase = String(env.VITE_API_BASE || "").trim().replace(/\/$/, "");
  if (!apiBase) throw new Error("所有 Android 构建必须显式设置 VITE_API_BASE 为已核实的 App 服务地址；禁止默认连接历史环境");
  validUrl(apiBase, "VITE_API_BASE", variant === "release");
  if (variant === "release") {
    for (const name of ["VITE_PRIVACY_POLICY_URL", "VITE_USER_AGREEMENT_URL"]) {
      if (!String(env[name] || "").trim()) throw new Error(`release 构建必须通过 ${name} 配置公司批准的 HTTPS 链接`);
      validUrl(String(env[name]).trim(), name, true);
    }
  }
  for (const name of ["JAVA_HOME", "ANDROID_HOME"]) {
    if (!String(sourceEnv[name] || "").trim()) throw new Error(`Android 构建需要显式设置 ${name}，分别指向本机 JDK 21 与 Android SDK；不会使用其他电脑的工具链目录`);
    env[name] = String(sourceEnv[name]).trim();
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  const cache = String(sourceEnv.LEYANXIU_ANDROID_BUILD_CACHE || paths.join(paths.parse(projectDir).root, "CodexBuildCaches"));
  const javaTemp = paths.join(cache, "leyanxiu-tmp");
  const gradleUserHome = sourceEnv.GRADLE_USER_HOME || paths.join(cache, "leyanxiu-gradle");
  // Resolve before replacing TEMP/TMP: that cache directory may be too long for
  // Windows JDK Unix-domain sockets used during Gradle daemon startup.
  let socketTemp = String(sourceEnv.LEYANXIU_JAVA_SOCKET_TMPDIR || "").trim();
  if (!socketTemp && platform === "win32" && sourceEnv.LOCALAPPDATA) socketTemp = paths.join(sourceEnv.LOCALAPPDATA, "Temp");
  if (platform === "win32" && !socketTemp) throw new Error("Windows 构建需要 LOCALAPPDATA 或显式 LEYANXIU_JAVA_SOCKET_TMPDIR 指向短临时目录");
  if (socketTemp && !paths.isAbsolute(socketTemp)) throw new Error("LEYANXIU_JAVA_SOCKET_TMPDIR 必须是绝对目录");
  Object.assign(env, {
    VITE_API_BASE: apiBase,
    VITE_APP_CHANNEL: "app",
    VITE_CLOSED_TEST_INVITE_REQUIRED: env.VITE_CLOSED_TEST_INVITE_REQUIRED || (variant === "debug" ? "true" : "false"),
    CAPACITOR_BUILD_VARIANT: variant,
    GRADLE_USER_HOME: gradleUserHome,
    TEMP: javaTemp, TMP: javaTemp,
    JAVA_TOOL_OPTIONS: [sourceEnv.JAVA_TOOL_OPTIONS, javaProperty("java.io.tmpdir", javaTemp, platform),
      socketTemp && javaProperty("jdk.net.unixdomain.tmpdir", socketTemp, platform)].filter(Boolean).join(" "),
  });
  const gradleArgs = [variant === "debug" ? "assembleDebug" : "assembleRelease", "--no-daemon", "--stacktrace", "--max-workers=1",
    `-Dorg.gradle.jvmargs=${sourceEnv.LEYANXIU_GRADLE_JVMARGS || "-Xmx768m -Dfile.encoding=UTF-8"}`];
  const initScript = String(sourceEnv.LEYANXIU_GRADLE_INIT_SCRIPT || "").trim();
  if (initScript) {
    if (!paths.isAbsolute(initScript)) throw new Error("LEYANXIU_GRADLE_INIT_SCRIPT 必须是已核实脚本的绝对路径");
    gradleArgs.push("--init-script", initScript);
  }
  return { profile, variant, env, gradleArgs, gradleUserHome, javaTemp, socketTemp, initScript };
}
