import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { quoteWindowsBatchArgument, resolveAndroidBuildProfile } from "../scripts/android-build-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "scripts", "build-android.mjs"), "utf8")
  + fs.readFileSync(path.join(root, "scripts", "android-build-profile.mjs"), "utf8");
const toolEnv = { JAVA_HOME: "C:\\toolchains\\jdk21", ANDROID_HOME: "C:\\toolchains\\android-sdk", LOCALAPPDATA: "C:\\Users\\test user\\AppData\\Local" };
const resolve = (profile, sourceEnv = {}) => resolveAndroidBuildProfile({ profile, sourceEnv: { ...toolEnv, ...sourceEnv }, projectDir: "D:\\work\\app", platform: "win32" });

test("Android builds reject missing App endpoint before writing assets or invoking Gradle", () => {
  assert.doesNotMatch(source, /47\.114\.36\.20/);
  assert.doesNotMatch(source, /tcloudbase\.com/);
  assert.match(source, /VITE_CLOSED_TEST_INVITE_REQUIRED/);
  for (const variant of ["debug", "release"]) {
    const env = { ...process.env };
    delete env.VITE_API_BASE;
    const result = spawnSync(process.execPath, [path.join(root, "scripts/build-android.mjs"), variant], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /显式设置 VITE_API_BASE/);
    assert.doesNotMatch(result.stdout, /vite|Gradle|npm run/);
  }
});

test("account command pins the verified endpoint, real flags and policy URLs without mutating the caller", () => {
  const sourceEnv = { ...toolEnv };
  const original = { ...sourceEnv };
  const build = resolveAndroidBuildProfile({ profile: "account", sourceEnv, projectDir: "D:\\work\\app", platform: "win32" });
  assert.deepEqual(sourceEnv, original);
  assert.equal(build.variant, "debug");
  assert.equal(build.env.CAPACITOR_BUILD_VARIANT, "debug");
  assert.equal(build.env.VITE_API_BASE, "https://REDACTED_COMPANY_INFRASTRUCTURE");
  assert.equal(build.env.VITE_PRIVACY_POLICY_URL, "https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/privacy.html");
  assert.equal(build.env.VITE_USER_AGREEMENT_URL, "https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/terms.html");
  assert.equal(build.env.VITE_APP_ACCOUNT_ONLY, "true");
  assert.equal(build.env.VITE_CLOSED_TEST_INVITE_REQUIRED, "true");
  assert.equal(build.env.VITE_APP_CHANNEL, "app");
  assert.equal(build.env.VITE_USE_MOCK, "false");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts["android:apk:account"], "node scripts/build-android.mjs account");
});

test("account builds reject conflicting inherited environment instead of silently changing destinations or capabilities", () => {
  for (const [name, value] of Object.entries({
    VITE_API_BASE: "https://old-api.invalid", VITE_APP_ACCOUNT_ONLY: "false", VITE_CLOSED_TEST_INVITE_REQUIRED: "false",
    VITE_APP_CHANNEL: "mini", VITE_USE_MOCK: "true", VITE_PRIVACY_POLICY_URL: "https://old-api.invalid/privacy",
    VITE_USER_AGREEMENT_URL: "https://old-api.invalid/terms",
  })) assert.throws(() => resolve("account", { [name]: value }), error => error.message.includes(name) && error.message.includes("冲突"));
  assert.throws(() => resolve("account", { VITE_ACCOUNT_ONLY: "true" }), /使用 VITE_APP_ACCOUNT_ONLY/);
  assert.equal(resolve("account", { VITE_API_BASE: " https://REDACTED_COMPANY_INFRASTRUCTURE/ " }).env.VITE_API_BASE, "https://REDACTED_COMPANY_INFRASTRUCTURE");
});

test("normal debug remains explicit and can target a deliberate local service", () => {
  assert.throws(() => resolve("debug"), /显式设置 VITE_API_BASE/);
  assert.throws(() => resolve("release"), /显式设置 VITE_API_BASE/);
  const build = resolve("debug", { VITE_API_BASE: "http://127.0.0.1:8787/" });
  assert.equal(build.env.VITE_API_BASE, "http://127.0.0.1:8787");
  assert.equal(build.env.VITE_APP_ACCOUNT_ONLY, undefined);
  assert.equal(build.env.VITE_CLOSED_TEST_INVITE_REQUIRED, "true");
  assert.throws(() => resolve("unknown"), /debug\|release\|account/);
});

test("release rejects insecure, private, placeholder and credential-bearing endpoints and policies", () => {
  const legal = { VITE_PRIVACY_POLICY_URL: "https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/privacy.html", VITE_USER_AGREEMENT_URL: "https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/terms.html" };
  for (const api of ["http://REDACTED_COMPANY_INFRASTRUCTURE", "https://localhost", "https://127.1", "https://PRIVATE_IP", "https://PRIVATE_IP",
    "https://PRIVATE_IP", "https://169.254.1.1", "https://100.64.1.1", "https://[::1]", "https://[::ffff:127.0.0.1]",
    "https://service.invalid", "https://example.com", "https://REDACTED_USER:REDACTED_PASSWORD@REDACTED_COMPANY_INFRASTRUCTURE", "https://REDACTED_COMPANY_INFRASTRUCTURE/#fragment", "not a url"]) {
    assert.throws(() => resolve("release", { ...legal, VITE_API_BASE: api }), undefined, api);
  }
  for (const name of Object.keys(legal)) {
    assert.throws(() => resolve("release", { ...legal, VITE_API_BASE: "https://REDACTED_COMPANY_INFRASTRUCTURE", [name]: "" }), new RegExp(name));
    assert.throws(() => resolve("release", { ...legal, VITE_API_BASE: "https://REDACTED_COMPANY_INFRASTRUCTURE", [name]: "http://REDACTED_COMPANY_INFRASTRUCTURE/policy" }), new RegExp(name));
  }
  const release = resolve("release", { ...legal, VITE_API_BASE: "https://REDACTED_COMPANY_INFRASTRUCTURE" });
  assert.equal(release.variant, "release");
  assert.equal(release.gradleArgs[0], "assembleRelease");
  assert.equal(release.env.VITE_CLOSED_TEST_INVITE_REQUIRED, "false");
});

test("Windows socket directory uses original LOCALAPPDATA before TEMP becomes the longer build cache", () => {
  const sourceEnv = { ...toolEnv, TEMP: "D:\\very-long-build-cache\\temporary", TMP: "D:\\very-long-build-cache\\temporary",
    LEYANXIU_ANDROID_BUILD_CACHE: "D:\\long cache path\\nested\\android-cache", JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" };
  const build = resolve("account", sourceEnv);
  assert.equal(build.socketTemp, "C:\\Users\\test user\\AppData\\Local\\Temp");
  assert.equal(build.env.TEMP, "D:\\long cache path\\nested\\android-cache\\leyanxiu-tmp");
  assert.notEqual(build.env.TEMP, build.socketTemp);
  assert.ok(build.env.JAVA_TOOL_OPTIONS.includes('-Djdk.net.unixdomain.tmpdir="C:/Users/REDACTED_USER user/AppData/Local/Temp"'));
  assert.ok(build.env.JAVA_TOOL_OPTIONS.includes('-Djava.io.tmpdir="D:/long cache path/nested/android-cache/leyanxiu-tmp"'));
  assert.ok(build.env.JAVA_TOOL_OPTIONS.startsWith("-Dfile.encoding=UTF-8 "));
  assert.equal(sourceEnv.TEMP, "D:\\very-long-build-cache\\temporary");
});

test("explicit short socket directory and optional verified Gradle init script are passed only to children", () => {
  const build = resolve("account", { LEYANXIU_JAVA_SOCKET_TMPDIR: "C:\\short tmp", LEYANXIU_GRADLE_INIT_SCRIPT: "C:\\verified cache\\kotlin.init.gradle" });
  assert.equal(build.socketTemp, "C:\\short tmp");
  assert.ok(build.env.JAVA_TOOL_OPTIONS.includes('-Djdk.net.unixdomain.tmpdir="C:/short tmp"'));
  assert.deepEqual(build.gradleArgs.slice(-2), ["--init-script", "C:\\verified cache\\kotlin.init.gradle"]);
  assert.ok(build.gradleArgs.includes("--max-workers=1"));
  assert.ok(build.gradleArgs.includes("-Dorg.gradle.jvmargs=-Xmx768m -Dfile.encoding=UTF-8"));
  assert.equal(resolve("account").initScript, "");
  assert.equal(resolve("account").gradleArgs.includes("--init-script"), false);
  assert.throws(() => resolve("account", { LEYANXIU_GRADLE_INIT_SCRIPT: "relative.gradle" }), /绝对路径/);
  assert.throws(() => resolve("account", { LEYANXIU_JAVA_SOCKET_TMPDIR: "relative" }), /绝对目录/);
  assert.throws(() => resolve("account", { LOCALAPPDATA: "" }), /LOCALAPPDATA/);
  assert.throws(() => resolve("account", { LEYANXIU_JAVA_SOCKET_TMPDIR: 'C:\\bad"path' }), /不支持的字符/);
});

test("missing JDK or SDK fails clearly with no old-machine defaults", () => {
  for (const name of ["JAVA_HOME", "ANDROID_HOME"]) {
    assert.throws(() => resolve("account", { [name]: "" }), new RegExp(name));
  }
  assert.doesNotMatch(source, /C:\\\\Users\\\\JT/);
  const env = { ...process.env, JAVA_HOME: path.join(root, "output", "missing-fixture-jdk"), ANDROID_HOME: path.join(root, "output", "missing-fixture-sdk"), VITE_API_BASE: "https://REDACTED_COMPANY_INFRASTRUCTURE" };
  const result = spawnSync(process.execPath, [path.join(root, "scripts/build-android.mjs"), "debug"], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JAVA_HOME 未指向可用的 JDK 21/);
  assert.doesNotMatch(result.stdout, /vite|Gradle|npm run/);
});

test("Windows batch arguments retain spaces and reject shell-expanded path characters", () => {
  assert.equal(quoteWindowsBatchArgument("C:\\tool chain & cache\\init.gradle"), '"C:\\tool chain & cache\\init.gradle"');
  assert.equal(quoteWindowsBatchArgument("-Dorg.gradle.jvmargs=-Xmx768m -Dfile.encoding=UTF-8"), '"-Dorg.gradle.jvmargs=-Xmx768m -Dfile.encoding=UTF-8"');
  for (const value of ['bad"path', "C:\\%USERPROFILE%\\init.gradle", "bad\npath"]) assert.throws(() => quoteWindowsBatchArgument(value));
});
