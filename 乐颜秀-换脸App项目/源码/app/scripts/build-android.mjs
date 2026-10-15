import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { quoteWindowsBatchArgument, resolveAndroidBuildProfile } from "./android-build-profile.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = resolveAndroidBuildProfile({ profile: process.argv[2] || "debug", sourceEnv: process.env, projectDir });
const { variant, env } = build;

const gradle = path.join(projectDir, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const capacitorCli = path.join(projectDir, "node_modules", "@capacitor", "cli", "bin", "capacitor");
const javaBin = path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
const javacBin = path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "javac.exe" : "javac");
if (!existsSync(javaBin) || !existsSync(javacBin)) throw new Error("JAVA_HOME 未指向可用的 JDK 21，请检查 java 与 javac 程序");
if (!existsSync(env.ANDROID_HOME) || !statSync(env.ANDROID_HOME).isDirectory()) throw new Error("ANDROID_HOME 未指向可用的 Android SDK 目录");
if (build.initScript && (!existsSync(build.initScript) || !statSync(build.initScript).isFile())) throw new Error("LEYANXIU_GRADLE_INIT_SCRIPT 文件不存在，请使用已核实的 Gradle 初始化脚本");
if (!existsSync(gradle)) throw new Error("Android 工程不存在，请先执行 npx cap add android");
const gradleCommand = process.platform === "win32" ? quoteWindowsBatchArgument(gradle) : gradle;
const gradleArgs = process.platform === "win32" ? build.gradleArgs.map(quoteWindowsBatchArgument) : build.gradleArgs;
for (const directory of [build.gradleUserHome, build.javaTemp, build.socketTemp].filter(Boolean)) mkdirSync(directory, { recursive: true });

function run(command, args, cwd = projectDir, shell = false) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [npmCli, "run", "build"]);
run(process.execPath, [capacitorCli, "sync", "android"]);
run(
  gradleCommand,
  gradleArgs,
  path.join(projectDir, "android"),
  process.platform === "win32",
);

const artifact = variant === "debug"
  ? path.join(projectDir, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk")
  : path.join(projectDir, "android", "app", "build", "outputs", "apk", "release", "app-release-unsigned.apk");

if (!existsSync(artifact)) throw new Error(`Gradle 已完成，但没有找到 APK: ${artifact}`);
console.log(`\nAndroid ${build.profile} (${variant}) APK: ${artifact}`);
