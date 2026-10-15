import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const releaseMode = process.argv.includes("--release");
const verificationOnlyMode = releaseMode && process.argv.includes("--verification-only");
const formalSeverity = releaseMode ? "BLOCK" : "WARN";
const externalReleaseSeverity = verificationOnlyMode ? "WARN" : "BLOCK";
const apiArgument = process.argv.find((value) => value.startsWith("--api-base="));
const apiBase = (apiArgument?.slice("--api-base=".length) || process.env.VITE_API_BASE || (verificationOnlyMode ? "https://api.leyanxiu.invalid" : "")).trim();
const privacyArgument = process.argv.find((value) => value.startsWith("--privacy-url="));
const agreementArgument = process.argv.find((value) => value.startsWith("--agreement-url="));
const privacyUrl = (privacyArgument?.slice("--privacy-url=".length) || process.env.VITE_PRIVACY_POLICY_URL || (verificationOnlyMode ? "https://legal.leyanxiu.invalid/privacy" : "")).trim();
const agreementUrl = (agreementArgument?.slice("--agreement-url=".length) || process.env.VITE_USER_AGREEMENT_URL || (verificationOnlyMode ? "https://legal.leyanxiu.invalid/terms" : "")).trim();
const versionCodeArgument = process.argv.find((value) => value.startsWith("--version-code="));
const versionNameArgument = process.argv.find((value) => value.startsWith("--version-name="));
const expectedVersionCode = (versionCodeArgument?.slice("--version-code=".length) || process.env.ANDROID_VERSION_CODE || "1").trim();
const expectedVersionName = (versionNameArgument?.slice("--version-name=".length) || process.env.ANDROID_VERSION_NAME || "1.0.0").trim();

function parsedUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function cspDirective(html, name) {
  return html.match(new RegExp(`${name}\\s+([^;"]+)`, "i"))?.[1] || "";
}

function isPublicHttpsUrl(value) {
  const parsed = parsedUrl(value);
  if (!parsed || parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return !(
    host === "localhost"
    || host === "PRIVATE_IP"
    || /^(?:10|127)\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host)
    || host === "::1"
    || /(?:^|\.)example\.(?:com|net|org)$/.test(host)
    || host.endsWith(".invalid")
    || host.endsWith(".example")
    || host.endsWith(".test")
  );
}
function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
}

function filesUnder(relativePath, predicate = () => true) {
  const start = path.join(root, relativePath);
  if (!fs.existsSync(start)) return [];
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (predicate(absolutePath)) result.push(absolutePath);
    }
  };
  visit(start);
  return result;
}

function sourceText() {
  return filesUnder("src", (file) => /\.(?:ts|tsx)$/.test(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function fileSha256(relativePath) {
  const absolutePath = path.join(root, relativePath);
  return fs.existsSync(absolutePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")
    : "";
}

function newestVersionDirectory(parent, requiredFile) {
  if (!parent || !fs.existsSync(parent)) return "";
  return fs.readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(parent, entry.name, requiredFile)))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
    .map((entry) => path.join(parent, entry.name))[0] || "";
}

function androidBuildToolsDirectory() {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk"),
  ].filter(Boolean);
  for (const sdkRoot of roots) {
    const buildTools = newestVersionDirectory(path.join(sdkRoot, "build-tools"), process.platform === "win32" ? "aapt.exe" : "aapt");
    if (buildTools) return buildTools;
  }
  return "";
}

function javaExecutable() {
  const binary = process.platform === "win32" ? "java.exe" : "java";
  const directCandidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", binary),
  ].filter(Boolean);
  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    for (const vendor of ["Microsoft", "Java", "Eclipse Adoptium"]) {
      const vendorRoot = path.join(programFiles, vendor);
      const jdkRoot = newestVersionDirectory(vendorRoot, path.join("bin", binary));
      if (jdkRoot) return path.join(jdkRoot, "bin", binary);
    }
  }
  return binary;
}

function runTool(command, args) {
  try {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      output: `${result.stdout || ""}\n${result.stderr || ""}`.trim(),
      status: result.status,
    };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error), status: null };
  }
}

function readZipEntry(archivePath, entryName) {
  const archive = fs.readFileSync(archivePath);
  const minimumEocdSize = 22;
  const start = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - minimumEocdSize; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory not found");
  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local header");
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`Unsupported ZIP compression method ${method}`);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

const checks = [];
function add(id, severity, passed, title, evidence, remediation) {
  checks.push({ id, severity, passed: Boolean(passed), title, evidence, remediation });
}

const packageJsonText = read("package.json");
const capacitorConfig = read("capacitor.config.ts") || read("capacitor.config.json");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const debugManifest = read("android/app/src/debug/AndroidManifest.xml");
const strings = read("android/app/src/main/res/values/strings.xml");
const gradle = read("android/app/build.gradle") || read("android/app/build.gradle.kts");
const mainActivity = read("android/app/src/main/java/com/yibohuaxia/leyanxiu/MainActivity.java");
const mediaStorePlugin = read("android/app/src/main/java/com/yibohuaxia/leyanxiu/GalleryMediaStorePlugin.java");
const deviceIdentityPlugin = read("android/app/src/main/java/com/yibohuaxia/leyanxiu/DeviceIdentityPlugin.java");
const releaseBuildScript = read("android/build-release.ps1");
const androidGitignore = read("android/.gitignore");
const androidVariables = read("android/variables.gradle");
const networkSecurity = read("android/app/src/main/res/xml/network_security_config.xml");
const debugNetworkSecurity = read("android/app/src/debug/res/xml/network_security_config_debug.xml");
const indexHtml = read("index.html");
const distIndexHtml = read("dist/index.html");
const androidAssetIndexHtml = read("android/app/src/main/assets/public/index.html");
const distScriptText = filesUnder("dist", (file) => file.endsWith(".js"))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const distBundleText = `${distIndexHtml}\n${distScriptText}`;
const apiClient = read("src/lib/api.ts");
const nativeSource = read("src/lib/native.ts");
const appSource = read("src/App.tsx");
const flowSource = read("src/views/Flow.tsx");
const shareSource = read("src/views/Share.tsx");
const templateSource = read("src/data/templates.ts");
const serverSource = read("server/index.js");
const allSource = sourceText();
const fileProviderPaths = read("android/app/src/main/res/xml/file_paths.xml");
const launcherForeground = read("android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml");
const defaultLauncherArtwork = /M66\.94,46\.02/.test(launcherForeground);
const releaseApkCandidates = [
  path.join(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
  path.join(root, "android", "app", "build", "outputs", "apk", "release", "app-release-unsigned.apk"),
];
const expectedArtifact = releaseMode
  ? releaseApkCandidates.find((candidate) => fs.existsSync(candidate)) || releaseApkCandidates[0]
  : path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const expectedBundle = path.join(root, "android", "app", "build", "outputs", "bundle", "release", "app-release.aab");
const buildInputs = [
  path.join(root, "index.html"),
  path.join(root, "capacitor.config.ts"),
  ...filesUnder("src"),
  ...filesUnder("public"),
  ...filesUnder("android/app/src"),
].filter((file) => fs.existsSync(file));
const latestBuildInputMs = Math.max(0, ...buildInputs.map((file) => fs.statSync(file).mtimeMs));
const artifactOnDisk = fs.existsSync(expectedArtifact) && fs.statSync(expectedArtifact).size > 500_000;
const artifactExists = artifactOnDisk
  && fs.statSync(expectedArtifact).mtimeMs >= latestBuildInputMs;
let artifactToolPath = expectedArtifact;
let auditTemporaryDirectory = "";
if (artifactOnDisk && /[^\x00-\x7F]/.test(expectedArtifact)) {
  auditTemporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-apk-audit-"));
  artifactToolPath = path.join(auditTemporaryDirectory, path.basename(expectedArtifact));
  fs.copyFileSync(expectedArtifact, artifactToolPath);
  process.on("exit", () => {
    fs.rmSync(auditTemporaryDirectory, { recursive: true, force: true });
  });
}
const objectRouteStart = serverSource.indexOf('app.get("/api/objects/:objectId"');
const objectRouteRemainder = objectRouteStart < 0 ? "" : serverSource.slice(objectRouteStart + 10);
const nextRouteOffset = objectRouteRemainder.search(/\r?\napp\./);
const objectRouteEnd = nextRouteOffset < 0 ? -1 : objectRouteStart + 10 + nextRouteOffset;
const objectRoute = objectRouteStart < 0
  ? ""
  : serverSource.slice(objectRouteStart, objectRouteEnd < 0 ? undefined : objectRouteEnd);

let packageJson = {};
try {
  packageJson = JSON.parse(packageJsonText || "{}");
} catch {
  // The package parse check below will report the problem.
}
const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };

const appIdMatch = capacitorConfig.match(/appId\s*:\s*["']([^"']+)["']/);
const appNameMatch = capacitorConfig.match(/appName\s*:\s*["']([^"']+)["']/);
const applicationIdMatch = gradle.match(/applicationId\s*(?:=\s*)?["']([^"']+)["']/);
const namespaceMatch = gradle.match(/namespace\s*(?:=\s*)?["']([^"']+)["']/);
const configuredVersionCode = (process.env.ANDROID_VERSION_CODE || "1").trim();
const configuredVersionName = (process.env.ANDROID_VERSION_NAME || "1.0.0").trim();
const versionCodeUsesEnvironment = /ANDROID_VERSION_CODE/.test(gradle) && /versionCode\s+versionCodeText\.toInteger\(\)/.test(gradle);
const versionNameUsesEnvironment = /ANDROID_VERSION_NAME/.test(gradle) && /versionName\s+versionNameValue/.test(gradle);
const minSdkMatch = androidVariables.match(/minSdkVersion\s*=\s*(\d+)/) || gradle.match(/minSdkVersion\s*(?:=\s*)?(\d+)/);
const targetSdkMatch = androidVariables.match(/targetSdkVersion\s*=\s*(\d+)/) || gradle.match(/targetSdkVersion\s*(?:=\s*)?(\d+)/);

const buildToolsDirectory = androidBuildToolsDirectory();
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const aaptPath = buildToolsDirectory && path.join(buildToolsDirectory, `aapt${executableSuffix}`);
const zipalignPath = buildToolsDirectory && path.join(buildToolsDirectory, `zipalign${executableSuffix}`);
const apksignerJar = buildToolsDirectory && path.join(buildToolsDirectory, "lib", "apksigner.jar");
const unavailableToolResult = { ok: false, output: "Android SDK build tool unavailable", status: null };
const aaptBadging = artifactOnDisk && aaptPath
  ? runTool(aaptPath, ["dump", "badging", artifactToolPath])
  : unavailableToolResult;
const aaptPermissions = artifactOnDisk && aaptPath
  ? runTool(aaptPath, ["dump", "permissions", artifactToolPath])
  : unavailableToolResult;
const signerVerification = artifactOnDisk && apksignerJar && fs.existsSync(apksignerJar)
  ? runTool(javaExecutable(), ["-jar", apksignerJar, "verify", "--verbose", "--print-certs", artifactToolPath])
  : unavailableToolResult;
const zipalignVerification = artifactOnDisk && zipalignPath
  ? runTool(zipalignPath, ["-c", "-P", "16", "-v", "4", artifactToolPath])
  : unavailableToolResult;

const apkPackageName = aaptBadging.output.match(/package:\s+name='([^']+)'/)?.[1] || "";
const apkVersionCode = aaptBadging.output.match(/package:[^\n]+versionCode='([^']+)'/)?.[1] || "";
const apkVersionName = aaptBadging.output.match(/package:[^\n]+versionName='([^']+)'/)?.[1] || "";
const apkMinSdk = aaptBadging.output.match(/sdkVersion:'([^']+)'/)?.[1] || "";
const apkTargetSdk = aaptBadging.output.match(/targetSdkVersion:'([^']+)'/)?.[1] || "";
const apkApplicationLabel = aaptBadging.output.match(/application-label:'([^']+)'/)?.[1] || "";
const debugCertificateDetected = /Android Debug/i.test(signerVerification.output);
const forbiddenPackagedPermissions = [
  "MANAGE_EXTERNAL_STORAGE",
  "READ_MEDIA_IMAGES",
  "READ_MEDIA_VIDEO",
  "RECORD_AUDIO",
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "READ_CONTACTS",
].filter((permission) => aaptPermissions.output.includes(`android.permission.${permission}`));
let packagedIndexHtml = "";
let packagedIndexError = "";
if (artifactOnDisk) {
  try {
    packagedIndexHtml = readZipEntry(expectedArtifact, "assets/public/index.html").toString("utf8");
  } catch (error) {
    packagedIndexError = error instanceof Error ? error.message : String(error);
  }
}

add("APK-001", "BLOCK", Boolean(capacitorConfig && manifest && gradle), "Capacitor Android project exists", "capacitor.config and android/app files must all exist", "Run the Capacitor Android project generation and commit reproducible source files.");
add("APK-002", "BLOCK", Boolean(appIdMatch && /^(?:[a-z][a-z0-9_]*\.){2,}[a-z][a-z0-9_]*$/.test(appIdMatch[1]) && !/(?:example|myapp|test)/i.test(appIdMatch[1])), "Stable non-placeholder application id", appIdMatch?.[1] || "missing", "Obtain company approval before publishing; changing applicationId later creates a different app.");
add("APK-003", "BLOCK", appNameMatch?.[1] === "乐颜秀" && strings.includes("乐颜秀"), "Application label is 乐颜秀", `config=${appNameMatch?.[1] || "missing"}`, "Set both Capacitor appName and Android string resource.");
add("APK-004", "BLOCK", Boolean(appIdMatch && applicationIdMatch && namespaceMatch && appIdMatch[1] === applicationIdMatch[1] && appIdMatch[1] === namespaceMatch[1]), "Capacitor id, applicationId and namespace agree", `capacitor=${appIdMatch?.[1] || "missing"}; applicationId=${applicationIdMatch?.[1] || "missing"}; namespace=${namespaceMatch?.[1] || "missing"}`, "Use one approved reverse-DNS id everywhere.");
add(
  "APK-005",
  "BLOCK",
  versionCodeUsesEnvironment && versionNameUsesEnvironment && /^[1-9]\d*$/.test(configuredVersionCode) && Boolean(configuredVersionName),
  "Android version metadata is injected per release",
  `versionCode=${configuredVersionCode}; versionName=${configuredVersionName}; environment-backed=${versionCodeUsesEnvironment && versionNameUsesEnvironment}`,
  "Set ANDROID_VERSION_CODE to a monotonically increasing integer and ANDROID_VERSION_NAME to the approved public version for every release.",
);
add("APK-006", "BLOCK", artifactExists, `${releaseMode ? "Release" : "Debug test"} APK artifact exists and is current`, expectedArtifact, releaseMode ? "Build the current release APK; an unsigned verification artifact is not publishable until company signing is injected." : "Run npm run android:apk:debug and confirm the resulting APK is larger than 500 KB.");
add("APK-007", formalSeverity, !releaseMode || /signingConfigs\s*\{|signingConfig\s+signingConfigs\./.test(gradle), "Release signing is configured outside source-controlled secrets", "android/app/build.gradle", "Use a company-controlled keystore supplied through secure CI/local environment variables; never commit the keystore or passwords.");
add("APK-008", "BLOCK", Boolean(distIndexHtml && androidAssetIndexHtml && distIndexHtml === androidAssetIndexHtml), "Capacitor Android assets match the latest web build", "dist/index.html compared with android/app/src/main/assets/public/index.html", "Run npm build followed by cap sync android before assembling the APK.");
const apkMetadataMatches = Boolean(
  aaptBadging.ok
  && apkPackageName === appIdMatch?.[1]
  && apkVersionCode === configuredVersionCode
  && apkVersionName === configuredVersionName
  && apkMinSdk === minSdkMatch?.[1]
  && apkTargetSdk === targetSdkMatch?.[1]
  && apkApplicationLabel === "乐颜秀"
);
add("APK-009", "BLOCK", !artifactOnDisk || apkMetadataMatches, "Built APK metadata matches the reviewed Android project", artifactOnDisk ? `package=${apkPackageName || "unreadable"}; version=${apkVersionName || "?"} (${apkVersionCode || "?"}); sdk=${apkMinSdk || "?"}-${apkTargetSdk || "?"}; label=${apkApplicationLabel || "?"}` : "deferred until APK exists", "Install Android SDK build-tools and rebuild; do not distribute an artifact whose package, version, SDK or label differs from reviewed source.");
const unsignedVerificationApk = releaseMode && expectedArtifact.endsWith("-unsigned.apk");
const acceptableArtifactSignature = !releaseMode
  ? signerVerification.ok && debugCertificateDetected
  : unsignedVerificationApk
    ? verificationOnlyMode && !signerVerification.ok
    : signerVerification.ok && !debugCertificateDetected;
add("APK-010", "BLOCK", !artifactOnDisk || acceptableArtifactSignature, "Built APK has the signature required for the selected audit mode", artifactOnDisk ? (unsignedVerificationApk ? `${verificationOnlyMode ? "accepted verification artifact" : "UNSIGNED AND NOT PUBLISHABLE"}: app-release-unsigned.apk` : signerVerification.output.split(/\r?\n/).find((line) => /certificate DN/i.test(line)) || signerVerification.output.slice(0, 240) || "signature unreadable") : "deferred until APK exists", "Use the debug certificate only for local testing, --verification-only only for structural review, and the company release certificate for publication.");
add("APK-011", "BLOCK", !artifactOnDisk || zipalignVerification.ok, "Built APK passes 16 KB page-aware ZIP alignment", artifactOnDisk ? (zipalignVerification.ok ? "zipalign -c -P 16 -v 4 passed" : zipalignVerification.output.slice(-500)) : "deferred until APK exists", "Rebuild with the supported Android Gradle plugin/build-tools and verify zipalign before distribution.");
add("APK-012", "BLOCK", !artifactOnDisk || Boolean(packagedIndexHtml && packagedIndexHtml === androidAssetIndexHtml && !/__API_CONNECT_SOURCE__/.test(packagedIndexHtml)), "Built APK contains the exact reviewed and resolved web entry point", artifactOnDisk ? (packagedIndexError || "assets/public/index.html compared byte-for-byte") : "deferred until APK exists", "Run the web build and Capacitor sync before assembling; reject stale or unresolved packaged assets.");
add("APK-013", "BLOCK", !artifactOnDisk || (aaptPermissions.ok && forbiddenPackagedPermissions.length === 0), "Built APK declares no unexpected sensitive runtime permission", artifactOnDisk ? (forbiddenPackagedPermissions.join(", ") || "no forbidden packaged permission found") : "deferred until APK exists", "Remove unnecessary media, audio, location, contact or all-files permissions from the merged manifest and rebuild.");
const bundleOnDisk = fs.existsSync(expectedBundle) && fs.statSync(expectedBundle).size > 500_000;
const signingEnvironmentBacked = ["ANDROID_RELEASE_STORE_FILE", "ANDROID_RELEASE_STORE_PASSWORD", "ANDROID_RELEASE_KEY_ALIAS", "ANDROID_RELEASE_KEY_PASSWORD"]
  .every((name) => gradle.includes(name));
const signingSecretsEmbedded = /storePassword\s+["'][^"']+["']|keyPassword\s+["'][^"']+["']/.test(gradle);
add("APK-014", releaseMode ? "BLOCK" : "WARN", !releaseMode || bundleOnDisk, "Release Android App Bundle exists for store upload", expectedBundle, "Build bundleRelease and upload the signed AAB rather than a debug APK.");
add("APK-015", "BLOCK", signingEnvironmentBacked && !signingSecretsEmbedded && androidGitignore.includes("*.jks") && androidGitignore.includes("*.keystore"), "Company signing is injected without source-controlled secrets", "Gradle environment variables and Android gitignore inspected", "Use all four ANDROID_RELEASE_* variables; keep the company keystore outside the checkout and never commit passwords.");
add("APK-016", "BLOCK", /assembleRelease/.test(releaseBuildScript) && /bundleRelease/.test(releaseBuildScript) && /RequireSigning/.test(releaseBuildScript), "Reproducible APK and AAB release commands exist", "android/build-release.ps1", "Keep one fail-closed script that builds web assets, syncs Capacitor, and creates both artifacts.");

const developmentBackendEndpoint = /47\.114\.36\.20|http:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2)(?::\d+)?\/api(?:[/'"`\\]|$)/i;
const apiOrigin = parsedUrl(apiBase)?.origin || "";
const releaseCspReady = Boolean(
  distIndexHtml
  && /Content-Security-Policy/i.test(distIndexHtml)
  && !/__API_CONNECT_SOURCE__/.test(distIndexHtml)
  && (!apiOrigin || distIndexHtml.includes(apiOrigin))
  && !/http:\/\//i.test(distIndexHtml),
);
const connectDirective = cspDirective(distIndexHtml, "connect-src");
const imageDirective = cspDirective(distIndexHtml, "img-src");
const mediaDirective = cspDirective(distIndexHtml, "media-src");
const packagedConnectOrigins = [...connectDirective.matchAll(/https?:\/\/[^\s;"']+/gi)].map((match) => match[0]);
const packagedResourceOriginsReady = packagedConnectOrigins.every(
  (origin) => imageDirective.includes(origin) && mediaDirective.includes(origin),
);
const packagedHttpHosts = packagedConnectOrigins
  .map((origin) => parsedUrl(origin))
  .filter((url) => url?.protocol === "http:")
  .map((url) => url.hostname);
const debugCleartextReady = packagedHttpHosts.every(
  (host) => /usesCleartextTraffic\s*=\s*"true"/.test(debugManifest) && debugNetworkSecurity.includes(`>${host}<`),
);

add("NET-001", releaseMode ? externalReleaseSeverity : "BLOCK", !releaseMode || isPublicHttpsUrl(apiBase), "Release API base is an explicit public HTTPS origin", apiBase || "missing --api-base/VITE_API_BASE", "Build release with the company-approved HTTPS API domain; localhost, private IPs, plain HTTP and placeholder domains are rejected.");
add("NET-002", "BLOCK", !releaseMode || !developmentBackendEndpoint.test(distBundleText), "Release bundle has no development backend URL", apiBase || "API base not supplied", "Use the public API domain at build time and rebuild before capacitor sync.");
add("NET-003", "BLOCK", /usesCleartextTraffic\s*=\s*"false"/.test(manifest) && !/cleartextTrafficPermitted\s*=\s*"true"/.test(networkSecurity), "Release WebView rejects cleartext traffic", manifest ? "manifest/network security inspected" : "manifest missing", "Set usesCleartextTraffic=false; keep any HTTP emulator exception in a debug-only source set.");
add("NET-004", "BLOCK", /android\.permission\.INTERNET/.test(manifest), "Internet permission exists", "AndroidManifest.xml", "Add android.permission.INTERNET.");
add("NET-005", "BLOCK", /CORS_ORIGIN/.test(serverSource) && /PUBLIC_BASE_URL/.test(serverSource), "Backend exposes configurable CORS and public URL controls", "server/index.js", "Production must set PUBLIC_BASE_URL=https://... and allow the exact Capacitor origin, normally https://localhost.");
add("NET-006", formalSeverity, releaseMode ? releaseCspReady : /Content-Security-Policy/i.test(indexHtml), "Packaged HTML defines a resolved restrictive CSP", releaseMode ? "dist/index.html" : "index.html", "Build first, then confirm dist/index.html has no unresolved placeholder or HTTP source and permits only the approved API origin.");
add("NET-007", "BLOCK", !distIndexHtml || packagedResourceOriginsReady, "Every packaged API origin is permitted for both image and video results", packagedConnectOrigins.length ? packagedConnectOrigins.join(", ") : "No explicit packaged API origin found", "Add the API-origin placeholder to img-src and media-src as well as connect-src, then rebuild. Otherwise debug HTTP image results render blank even when API calls succeed.");
add("NET-008", "BLOCK", releaseMode ? packagedHttpHosts.length === 0 : debugCleartextReady, "Any packaged HTTP test host is scoped to debug network policy", packagedHttpHosts.join(", ") || "No packaged HTTP host", "Keep cleartext disabled in main/release and allow only the exact debug test host in src/debug network_security_config_debug.xml.");
const webViewReleaseHardened = mainActivity.includes("WebView.setWebContentsDebuggingEnabled(isDebuggable)")
  && /MIXED_CONTENT_NEVER_ALLOW/.test(mainActivity)
  && /MIXED_CONTENT_ALWAYS_ALLOW/.test(mainActivity)
  && /FLAG_DEBUGGABLE/.test(mainActivity);
add("NET-009", "BLOCK", webViewReleaseHardened, "Release disables WebView debugging and mixed content at runtime", "MainActivity uses the application debuggable flag for both controls", "Fail closed in release: set WebContentsDebuggingEnabled(false) and MIXED_CONTENT_NEVER_ALLOW whenever the application is not debuggable.");

const permissionTags = [...manifest.matchAll(/<uses-permission\b[^>]*>/g)].map((match) => match[0]);
const forbiddenPermissions = permissionTags.flatMap((tag) => {
  const name = tag.match(/android:name\s*=\s*"android\.permission\.([A-Z_]+)"/)?.[1];
  if (!name) return [];
  if (name === "READ_EXTERNAL_STORAGE" && /android:maxSdkVersion\s*=\s*"(?:[1-2]?\d)"/.test(tag)) return [];
  if (name === "WRITE_EXTERNAL_STORAGE" && /android:maxSdkVersion\s*=\s*"(?:[1-2]?\d)"/.test(tag)) return [];
  return ["MANAGE_EXTERNAL_STORAGE", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "RECORD_AUDIO", "ACCESS_FINE_LOCATION", "READ_CONTACTS"].includes(name) ? [name] : [];
});
add("PERM-001", "BLOCK", forbiddenPermissions.length === 0, "No unnecessary broad Android permissions", forbiddenPermissions.join(", ") || "none found", "Use the system photo picker/MediaStore/FileProvider and request only the capability selected by the user.");
add("PERM-002", "BLOCK", /android\.permission\.CAMERA/.test(manifest), "Camera permission supports Direct photo capture", "UI exposes a Direct photo button", "Declare CAMERA and request it only after the user taps Direct photo; provide a denial fallback to the system gallery.");
add("PERM-003", "WARN", !/<uses-feature[^>]+android\.hardware\.camera[^>]+required\s*=\s*"true"/.test(manifest), "Camera is not a mandatory install-time feature", "AndroidManifest.xml", "Declare camera feature required=false, or omit the feature declaration, so gallery-only devices remain supported.");
add("PERM-004", formalSeverity, !/<external-path[^>]+path\s*=\s*"\."/.test(fileProviderPaths), "FileProvider does not expose the whole external-storage tree", "android/app/src/main/res/xml/file_paths.xml", "Share cache files through cache-path, or scope external-path to the exact 乐颜秀 directory; never expose path=\".\".");

const readLegacyMax = manifest.match(/READ_EXTERNAL_STORAGE"[^>]+maxSdkVersion="(\d+)"/)?.[1];
const writeLegacyMax = manifest.match(/WRITE_EXTERNAL_STORAGE"[^>]+maxSdkVersion="(\d+)"/)?.[1];
const noModernMediaRead = !/READ_MEDIA_(?:IMAGES|VIDEO|VISUAL_USER_SELECTED)/.test(manifest);
add("PERM-005", "BLOCK", readLegacyMax === "28" && writeLegacyMax === "28" && noModernMediaRead && !/requestLegacyExternalStorage/.test(manifest), "Photo selection and gallery save use minimum Android 7-15 permissions", `READ max=${readLegacyMax || "none"}; WRITE max=${writeLegacyMax || "none"}; no Android 13 media read=${noModernMediaRead}`, "Use the system picker on Android 10+ and request legacy storage only on Android 7-9.");

add("PRIV-001", formalSeverity, !/getServerEntitlements\(\)/.test(appSource) || /privacy(?:Accepted|Consent|Gate)|hasAcceptedPrivacy/i.test(appSource + allSource), "No network or identifier access occurs before first-launch privacy choice", "App currently calls entitlement/session logic during mount unless a privacy gate is present", "Show the approved privacy summary and policy links first; initialize network/SDKs only after acceptance.");
add("PRIV-002", formalSeverity, !/window\.confirm\(/.test(apiClient), "Sensitive consent is not a browser confirm dialog", "src/lib/api.ts", "Use a versioned in-app consent page with purpose, data type, supplier, retention, reject path and policy links before upload.");
add("PRIV-003", "BLOCK", !/channel:\s*["']h5["']/.test(apiClient) && /channel:\s*["']app["']|getPlatformChannel|isNativePlatform/i.test(apiClient + allSource), "Android sessions are identified as app channel", "src/lib/api.ts", "Send channel=app from the APK.");
add("PRIV-004", releaseMode ? externalReleaseSeverity : "WARN", isPublicHttpsUrl(privacyUrl) && (!releaseMode || distScriptText.includes(privacyUrl)), "Approved privacy-policy URL is configured and embedded in release", privacyUrl || "missing --privacy-url/VITE_PRIVACY_POLICY_URL", "Publish the company-approved policy over HTTPS, pass it at build and audit time, then rebuild before Capacitor sync.");
add("PRIV-005", releaseMode ? externalReleaseSeverity : "WARN", isPublicHttpsUrl(agreementUrl) && (!releaseMode || distScriptText.includes(agreementUrl)), "Approved user-agreement URL is configured and embedded in release", agreementUrl || "missing --agreement-url/VITE_USER_AGREEMENT_URL", "Publish the company-approved agreement over HTTPS, pass it at build and audit time, then rebuild before Capacitor sync.");
const hasGenericSupplierPlaceholder = /生产环境披露的影像服务商|页面披露的影像服务商/.test(apiClient + flowSource);
add("PRIV-006", formalSeverity, !hasGenericSupplierPlaceholder, "Face-processing consent names the actual third-party processor(s)", hasGenericSupplierPlaceholder ? "Generic supplier placeholder text is still present" : "No generic supplier placeholder found", "Before consent, display the exact approved processor legal name, processing purpose, data types, region and retention; record the actual routed supplier server-side rather than trusting a generic client label.");
const deviceKeyAuthContract = /RELEASE_CHANNEL\s*===\s*["']android-app["'][^\n]+AUTH_MODE\s*!==\s*["']device_key["']/.test(read("server/auth.js"))
  && /\/api\/auth\/device\/challenge/.test(apiClient)
  && /\/api\/auth\/device\/verify/.test(apiClient);
add("AUTH-001", formalSeverity, !releaseMode || deviceKeyAuthContract, "Public Android authentication matches production backend policy", deviceKeyAuthContract ? "Android client and production backend both use challenge-based device_key authentication" : "Android production identity contract is incomplete", "Require AUTH_MODE=device_key for the Android release channel and complete a server-issued, one-time challenge/verify exchange before issuing a session.");

add("FILE-001", "BLOCK", /type=["']file["'][^>]+accept=["']image\/\*["']/.test(flowSource) && /capture=["']user["']/.test(flowSource), "Gallery and front-camera entry points exist", "src/views/Flow.tsx", "Verify both paths on physical devices; do not rely on desktop browser testing.");
add("FILE-002", "WARN", !/20\s*\*\s*1024\s*\*\s*1024/.test(flowSource) || /createImageBitmap|ImageResizer|Camera\.getPhoto/i.test(allSource), "Large photos are decoded without avoidable WebView memory spikes", "Current browser path accepts up to 20 MB and decodes via HTML Image", "Downsample natively or reject extreme pixel dimensions before full decode; test 48 MP HEIC/JPEG and low-memory devices.");
const savesToPublicDocuments = /Directory\.Documents/.test(allSource);
const usesMediaStore = /GalleryMediaStore\.save/.test(nativeSource)
  && /MediaStore\.(?:Images|Video)\.Media/.test(mediaStorePlugin)
  && /RELATIVE_PATH/.test(mediaStorePlugin)
  && /IS_PENDING/.test(mediaStorePlugin);
const legacyDocumentSaveReady = !savesToPublicDocuments
  || Number(minSdkMatch?.[1] || 999) >= 30
  || /requestLegacyExternalStorage\s*=\s*"true"/.test(manifest)
  || usesMediaStore;
add("FILE-003", "BLOCK", legacyDocumentSaveReady, "Claimed Android versions can save completed works", `minSdk=${minSdkMatch?.[1] || "unknown"}; Directory.Documents=${savesToPublicDocuments}`, "For Android 10 and below, either implement a MediaStore/native save path, add the narrowly scoped Android 10 legacy compatibility required by the plugin, or raise minSdk and disclose the supported versions.");
add("FILE-004", "BLOCK", usesMediaStore && /MediaScannerConnection\.scanFile/.test(mediaStorePlugin), "Completed images and videos are published to the system gallery", "MediaStore on Android 10-15 and public media plus scanner on Android 7-9", "Save app-owned temporary files through MediaStore and remove them after publishing; do not rely on app Documents.");

const nativeShare = /@capacitor\/share/.test(packageJsonText) && /Share\.share/.test(allSource) && /shareNativeMedia/.test(flowSource + shareSource);
const nativeFilesystem = /@capacitor\/filesystem/.test(packageJsonText) && /Filesystem\./.test(allSource) && /saveNativeMedia/.test(flowSource + shareSource);
add("SHARE-001", "BLOCK", nativeShare, "Share button invokes Android Sharesheet", "Web-only clipboard/download is not platform sharing", "Download to an app-controlled file and invoke the native Android sharesheet; do not claim direct platform publishing.");
add("SHARE-002", "BLOCK", nativeFilesystem, "Save uses a native Android path instead of relying only on HTML anchor download", "HTML a.download is ignored or inconsistent for cross-origin media in WebView", "Use native filesystem/MediaStore handling, progress, permission errors and a visible saved-location result; retaining a guarded H5 fallback is acceptable.");
add("SHARE-003", "WARN", !/target=["']_blank["']/.test(allSource) || /@capacitor\/browser|Browser\.open/.test(packageJsonText + allSource), "Policy links have explicit native external-browser handling", "target=_blank alone is inconsistent in a packaged WebView", "Open approved policy URLs through the Capacitor Browser plugin or a strict allowlisted handler.");
const shareRewardFragment = flowSource.match(/发给亲朋好友看看[\s\S]{0,400}/)?.[0] || "";
add("SHARE-008", "BLOCK", /validatedExternalHttpsUrl/.test(nativeSource) && /parsed\.protocol\s*!==\s*["']https:/.test(nativeSource) && /parsed\.username/.test(nativeSource), "Native external links reject unsafe protocols and embedded credentials", "src/lib/native.ts", "Parse every external URL and allow only HTTPS without user-info before opening the system browser.");
add("SHARE-004", "BLOCK", !/\+1次/.test(shareRewardFragment) || /LOCAL_DEMO_MODE/.test(shareRewardFragment), "Native share UI does not promise an unimplemented reward", /\+1次/.test(shareRewardFragment) ? "Result share button advertises +1 credit" : "No unconditional reward claim", "Show the +1 credit badge only in demo mode or after a server-verifiable reward flow exists; opening the Android Sharesheet alone does not prove publishing.");
add("SHARE-005", "BLOCK", !/FileTransfer\.downloadFile/.test(nativeSource) || /Filesystem\.mkdir/.test(nativeSource), "Native downloads create their parent directory before first use", "Save/share paths use nested directories", "Create the parent folder recursively before resolving the destination URI and downloading; first-use saves must not depend on an existing directory.");
const nativeDerivesMediaExtension = /mediaFileExtension|mediaFileName/.test(nativeSource)
  && /await\s+mediaFileName|mediaFileExtension\(/.test(nativeSource);
const h5DerivesMediaExtension = !/a\.download\s*=\s*[`"'][^`"']*\$\{kind\s*===\s*["']video["']\s*\?\s*["']mp4["']\s*:\s*["']jpg["']/.test(flowSource)
  || /mediaFileName|mediaFileExtension/.test(flowSource);
add("SHARE-006", "BLOCK", nativeDerivesMediaExtension && h5DerivesMediaExtension, "Saved and shared image extensions follow the actual media type", `native inference=${nativeDerivesMediaExtension}; H5 inference=${h5DerivesMediaExtension}`, "Infer png/jpeg/webp from the data-URI MIME type, response Content-Type or trusted URL path; keep file extension and share MIME type consistent.");
const resultStateKeepsAssetId = /name:\s*["']result["'][^}]*assetId\??:\s*string/.test(appSource)
  && /assetId:\s*result\.assetId/.test(appSource)
  && /assetId=\{view\.assetId\}/.test(appSource);
const frontendCanRefreshAssetUrl = /\/api\/assets\/\$\{encodeURIComponent\(assetId\)\}\/url/.test(apiClient)
  && /assetId/.test(flowSource);
add("SHARE-007", "BLOCK", resultStateKeepsAssetId && frontendCanRefreshAssetUrl, "Result save/share can refresh an expired signed media URL", `result state keeps assetId=${resultStateKeepsAssetId}; refresh path=${frontendCanRefreshAssetUrl}`, "Carry result.assetId into the result view and request /api/assets/:assetId/url immediately before native save/share; signed URLs are intentionally short-lived.");

add("NAV-001", "BLOCK", /@capacitor\/app/.test(packageJsonText) && /backButton/.test(allSource), "Android system Back follows the in-app navigation stack", "App state is not a browser router", "Close the top modal first, then go to the prior view, and exit only from a root tab.");
const hasChildOwnedOverlay = /showShare|settingsOpen/.test(allSource);
const childOverlayCanConsumeBack = /registerNativeBack|native[-_: ]back|backRequest|consumeBack/i.test(allSource);
add("NAV-002", "BLOCK", !hasChildOwnedOverlay || childOverlayCanConsumeBack, "System Back closes an open share/settings overlay before navigating", hasChildOwnedOverlay ? "Child views own overlay state" : "No child-owned overlay found", "Add a small native-back handler registry/event so the visible child overlay consumes Back before App changes the top-level view or exits.");
add("LIFE-001", "BLOCK", /appStateChange/.test(allSource), "Backgrounding pauses active video/audio", "No lifecycle listener found", "Pause active media on background and verify that returning to the app does not start hidden audio.");
const hasLongRunningPolling = /pollTask\(/.test(apiClient);
const persistsPendingTask = /localStorage|Preferences\./.test(apiClient) && /pending[^\n]{0,24}task|task[^\n]{0,24}pending/i.test(apiClient);
add("LIFE-002", formalSeverity, !hasLongRunningPolling || persistsPendingTask, "Pending generation can recover after Android kills the process", hasLongRunningPolling ? "pollTask exists but no persisted pending task was detected" : "No long-running polling", "Persist taskId, template and return view; on restart query the existing task instead of creating and charging for another one.");
const deviceIdentityReady = /KeyProperties\.KEY_ALGORITHM_EC/.test(deviceIdentityPlugin)
  && /ECGenParameterSpec\(["']secp256r1/.test(deviceIdentityPlugin)
  && /AndroidKeyStore/.test(deviceIdentityPlugin)
  && /SHA256withECDSA/.test(deviceIdentityPlugin)
  && /getNativeDevicePublicKey/.test(nativeSource)
  && /signNativeDeviceChallenge/.test(nativeSource);
add("AUTH-002", "BLOCK", deviceIdentityReady, "Android device identity uses a non-exportable P-256 Keystore key", "DeviceIdentity plugin exposes only SPKI public key and ES256 challenge signing", "Keep the private key in Android Keystore; bind anonymous accounts with a server-issued one-time challenge and reject replay.");
add("UI-001", "BLOCK", /@capacitor\/status-bar/.test(packageJsonText) && /StatusBar\./.test(allSource), "Status bar is configured for edge-to-edge and readable icons", "Android 15+ edge-to-edge requires deliberate handling", "Set overlay/color/icon style and verify safe areas on both dark and light screens.");
add("UI-002", "BLOCK", /screenOrientation\s*=\s*"portrait"/.test(manifest), "Activity is locked to the supported portrait layout", "Product requirement is portrait cards", "Lock the main activity to portrait, or fully support rotation and state restoration.");
add("UI-003", "WARN", /viewport-fit=cover/.test(indexHtml), "Viewport opts into safe-area layout", "index.html", "Include viewport-fit=cover and test cutout plus gesture-navigation insets.");

add("MEDIA-001", "BLOCK", /previewSoundBlocked/.test(flowSource) && /\.play\(\).*catch/s.test(flowSource), "Autoplay failure has a muted fallback and user sound control", "Android may legally block unmuted autoplay", "Keep this fallback; automatic audible playback cannot be guaranteed on every device and policy state.");
add("MEDIA-002", "BLOCK", /Content-Range/i.test(objectRoute) && /Accept-Ranges/i.test(objectRoute) && /c\.req\.header\(["']range["']\)/i.test(objectRoute) && /206/.test(objectRoute), "Private media endpoint supports HTTP byte ranges", "/api/objects currently appears to return the whole object", "Implement Range/206/Content-Range/Accept-Ranges and test seek/replay for generated MP4 files.");
const activePreviewPaths = [...templateSource.matchAll(/previewVideo:\s*["']\/([^"']+\.mp4)["']/g)].map((match) => match[1]);
const incompatiblePreviews = activePreviewPaths.filter((relativePath) => {
  const absolutePath = path.join(root, "public", relativePath);
  if (!fs.existsSync(absolutePath)) return true;
  const data = fs.readFileSync(absolutePath);
  const atoms = data.toString("latin1");
  const moov = atoms.indexOf("moov");
  const mdat = atoms.indexOf("mdat");
  return moov < 0 || mdat < 0 || moov > mdat || !atoms.includes("avc1") || !atoms.includes("mp4a");
});
add("MEDIA-003", "BLOCK", activePreviewPaths.length > 0 && incompatiblePreviews.length === 0, "Active bundled previews are Android-compatible fast-start H.264/AAC MP4", incompatiblePreviews.join(", ") || `${activePreviewPaths.length} active preview(s) inspected`, "Provide every referenced preview and encode as fast-start H.264 yuv420p plus AAC; verify again on physical devices.");

add("ERR-001", "WARN", /@capacitor\/network/.test(packageJsonText) || /addEventListener\(["'](?:online|offline)["']/.test(allSource), "Offline state is visible and retryable", "No explicit network-state handler found", "Show offline/retry UI and do not misreport network failures as exhausted credits.");
add("ERR-002", "WARN", /ErrorBoundary|getDerivedStateFromError|componentDidCatch/.test(allSource), "Unexpected render errors have a recovery screen", "No React error boundary found", "Add a top-level recovery view with restart and support details.");
add("SEC-001", "BLOCK", /allowBackup\s*=\s*"false"|dataExtractionRules|fullBackupContent/.test(manifest), "Backup policy protects local identifiers and session material", "AndroidManifest.xml", "Disable backup or provide explicit extraction rules that exclude tokens, identifiers and WebView storage.");

const adaptiveIconFiles = filesUnder("android/app/src/main/res", (file) => /mipmap-anydpi.*ic_launcher.*\.xml$/.test(file.replaceAll("\\", "/")));
const adaptiveIconXml = adaptiveIconFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const splashHash = fileSha256("android/app/src/main/res/drawable-port-xxxhdpi/splash.png");
const looksLikeDefaultSplash = splashHash === "3db071a03b2f8ffe0dfd4170fc59842d53cd15bba5e88af59401d58efabf7827";
add("BRAND-001", formalSeverity, adaptiveIconFiles.length > 0 && !defaultLauncherArtwork, "Launcher icon is adaptive and not the generated Android default", defaultLauncherArtwork ? "Default Android robot/teal-grid artwork detected" : `${adaptiveIconFiles.length} adaptive icon resource(s)`, "Replace all generated launcher densities with the approved 乐颜秀 foreground/background artwork and visually inspect launcher masks.");
add("BRAND-002", formalSeverity, Boolean(splashHash && !looksLikeDefaultSplash), "Launch screen uses approved 乐颜秀 artwork", splashHash || "splash missing", "Replace the generated Capacitor splash images and check portrait cold start on a physical device.");
add("BRAND-003", formalSeverity, /<monochrome\b/.test(adaptiveIconXml), "Android 13 themed monochrome icon is supplied", "mipmap-anydpi-v26 launcher XML", "Add the approved monochrome layer so themed icons do not fall back inconsistently.");

const failedBlockers = checks.filter((check) => check.severity === "BLOCK" && !check.passed);
const failedWarnings = checks.filter((check) => check.severity === "WARN" && !check.passed);

console.log(`Android ${releaseMode ? (verificationOnlyMode ? "release verification-only" : "release publication") : "development"} readiness: ${failedBlockers.length ? "NO-GO" : "GO"}`);
console.log(`Blockers: ${failedBlockers.length}; warnings: ${failedWarnings.length}; checks: ${checks.length}\n`);
for (const check of checks) {
  const status = check.passed ? "PASS" : check.severity;
  console.log(`[${status}] ${check.id} ${check.title}`);
  if (!check.passed) {
    console.log(`  Evidence: ${check.evidence}`);
    console.log(`  Fix: ${check.remediation}`);
  }
}

if (failedBlockers.length) process.exitCode = 1;
