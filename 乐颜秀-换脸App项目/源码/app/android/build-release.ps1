[CmdletBinding()]
param(
    [ValidateSet("Apk", "Aab", "Both")]
    [string]$Artifact = "Both",
    [switch]$VerificationOnly,
    [switch]$RequireSigning
)

$ErrorActionPreference = "Stop"
$androidDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $androidDir

function Require-PublicHttps([string]$Name, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Name is required for a release build."
    }
    try { $uri = [Uri]$Value } catch { throw "$Name must be an HTTPS URL." }
    $hostName = $uri.DnsSafeHost.ToLowerInvariant()
    $isPrivateIpv4 = $hostName -match '^(10|127)\.' -or
        $hostName -match '^192\.168\.' -or
        $hostName -match '^172\.(1[6-9]|2[0-9]|3[01])\.'
    $blocked = $uri.Scheme -ne "https" -or $uri.UserInfo -or
        $hostName -in @("localhost", "PRIVATE_IP", "::1") -or $isPrivateIpv4 -or
        $hostName.EndsWith(".invalid") -or $hostName.EndsWith(".example") -or $hostName.EndsWith(".test")
    if ($blocked) { throw "$Name must be a company-approved public HTTPS URL." }
}

if ($VerificationOnly) {
    if ($RequireSigning) { throw "VerificationOnly cannot be combined with RequireSigning." }
    $env:VITE_API_BASE = "https://api.leyanxiu.invalid"
    $env:VITE_PRIVACY_POLICY_URL = "https://legal.leyanxiu.invalid/privacy"
    $env:VITE_USER_AGREEMENT_URL = "https://legal.leyanxiu.invalid/terms"
    $env:ANDROID_REQUIRE_SIGNING = "false"
} else {
    Require-PublicHttps "VITE_API_BASE" $env:VITE_API_BASE
    Require-PublicHttps "VITE_PRIVACY_POLICY_URL" $env:VITE_PRIVACY_POLICY_URL
    Require-PublicHttps "VITE_USER_AGREEMENT_URL" $env:VITE_USER_AGREEMENT_URL
    $env:ANDROID_REQUIRE_SIGNING = $RequireSigning.IsPresent.ToString().ToLowerInvariant()
}

if ([string]::IsNullOrWhiteSpace($env:ANDROID_VERSION_CODE)) { throw "ANDROID_VERSION_CODE is required." }
if ([string]::IsNullOrWhiteSpace($env:ANDROID_VERSION_NAME)) { throw "ANDROID_VERSION_NAME is required." }
if ($env:ANDROID_VERSION_CODE -notmatch '^[1-9][0-9]*$') { throw "ANDROID_VERSION_CODE must be a positive integer." }

$env:CAPACITOR_BUILD_VARIANT = "release"
$env:VITE_APP_CHANNEL = "app"
$cacheRoot = if ($env:LEYANXIU_ANDROID_BUILD_CACHE) { $env:LEYANXIU_ANDROID_BUILD_CACHE } else { "D:\CodexBuildCaches" }
$env:GRADLE_USER_HOME = Join-Path $cacheRoot "leyanxiu-gradle"
$tempDir = Join-Path $cacheRoot "leyanxiu-tmp"
New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME, $tempDir | Out-Null
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=$tempDir"
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot" }

Push-Location $projectDir
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Web build failed." }
    & npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed." }
} finally {
    Pop-Location
}

$tasks = switch ($Artifact) {
    "Apk" { @("assembleRelease") }
    "Aab" { @("bundleRelease") }
    default { @("assembleRelease", "bundleRelease") }
}

Push-Location $androidDir
try {
    & .\gradlew.bat @tasks --no-daemon
    if ($LASTEXITCODE -ne 0) { throw "Android release build failed." }
} finally {
    Pop-Location
}

$apk = Get-ChildItem (Join-Path $androidDir "app\build\outputs\apk\release\*.apk") -ErrorAction SilentlyContinue
$aab = Get-ChildItem (Join-Path $androidDir "app\build\outputs\bundle\release\*.aab") -ErrorAction SilentlyContinue
Write-Host "Release artifacts:"
@($apk) + @($aab) | ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
    Write-Host "  $($_.FullName)"
    Write-Host "  SHA256 $hash"
}
if ($VerificationOnly) {
    Write-Warning "Verification-only artifacts use non-routable .invalid URLs and are not publishable."
}
