param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$SourceIcon = (Join-Path $ProjectRoot "output\imagegen\leyanxiu-app-icon-source.png")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $SourceIcon -PathType Leaf)) {
    throw "Brand icon source was not found: $SourceIcon"
}

$resourceRoot = Join-Path $ProjectRoot "android\app\src\main\res"
$dark = [System.Drawing.Color]::FromArgb(255, 11, 11, 15)
$white = [System.Drawing.Color]::White
$muted = [System.Drawing.Color]::FromArgb(255, 178, 181, 193)
$loadedSource = [System.Drawing.Image]::FromFile($SourceIcon)
$brandSource = [System.Drawing.Bitmap]::new($loadedSource)
$loadedSource.Dispose()

function New-Graphics([System.Drawing.Bitmap]$bitmap) {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    return $graphics
}

function Save-Png([System.Drawing.Bitmap]$bitmap, [string]$path) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
    if ([System.IO.File]::Exists($path)) { [System.IO.File]::Delete($path) }
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Draw-BrandSource(
    [System.Drawing.Graphics]$graphics,
    [float]$x,
    [float]$y,
    [float]$size
) {
    $graphics.DrawImage($brandSource, [System.Drawing.RectangleF]::new($x, $y, $size, $size))
}

function New-Launcher([string]$path, [int]$size) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = New-Graphics $bitmap
    $graphics.Clear($dark)
    Draw-BrandSource $graphics 0 0 $size
    Save-Png $bitmap $path
    $graphics.Dispose()
    $bitmap.Dispose()
}

function New-Splash([string]$path, [int]$width, [int]$height) {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = New-Graphics $bitmap
    $graphics.Clear($dark)

    $shortSide = [Math]::Min($width, $height)
    $sourceSize = $shortSide * 0.40
    $sourceX = ($width - $sourceSize) / 2
    $sourceY = ($height * 0.43) - ($sourceSize / 2)
    Draw-BrandSource $graphics $sourceX $sourceY $sourceSize

    $nameFont = [System.Drawing.Font]::new("Microsoft YaHei UI", [Math]::Max(18, $shortSide * 0.075), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $tagFont = [System.Drawing.Font]::new("Microsoft YaHei UI", [Math]::Max(11, $shortSide * 0.03), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $whiteBrush = [System.Drawing.SolidBrush]::new($white)
    $mutedBrush = [System.Drawing.SolidBrush]::new($muted)
    $graphics.DrawString("乐颜秀", $nameFont, $whiteBrush, [System.Drawing.RectangleF]::new(0, $sourceY + $sourceSize * 0.92, $width, $shortSide * 0.12), $format)
    $graphics.DrawString("AI 影像创作", $tagFont, $mutedBrush, [System.Drawing.RectangleF]::new(0, $sourceY + $sourceSize * 1.18, $width, $shortSide * 0.07), $format)

    Save-Png $bitmap $path
    $mutedBrush.Dispose()
    $whiteBrush.Dispose()
    $format.Dispose()
    $tagFont.Dispose()
    $nameFont.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

$launcherSizes = [ordered]@{
    "mdpi" = 48
    "hdpi" = 72
    "xhdpi" = 96
    "xxhdpi" = 144
    "xxxhdpi" = 192
}
foreach ($density in $launcherSizes.Keys) {
    $size = $launcherSizes[$density]
    $folder = Join-Path $resourceRoot "mipmap-$density"
    New-Launcher (Join-Path $folder "ic_launcher.png") $size
    New-Launcher (Join-Path $folder "ic_launcher_round.png") $size
    New-Launcher (Join-Path $folder "ic_launcher_foreground.png") ([int]($size * 2.25))
}

Get-ChildItem -Path $resourceRoot -Recurse -Filter "splash.png" | ForEach-Object {
    $source = [System.Drawing.Image]::FromFile($_.FullName)
    $width = $source.Width
    $height = $source.Height
    $source.Dispose()
    New-Splash $_.FullName $width $height
}

$brandSource.Dispose()
Write-Host "Generated Android launcher and splash resources from $SourceIcon"
