$ErrorActionPreference = 'Stop'
$dir = 'REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署'
$files = @('算法安全自评估报告B（语音合成·备案提交版）.docx', '拟公示内容B（语音合成·备案提交版）.docx', '算法安全自评估报告B（语音合成·备案提交版-含主体责任附件）.docx')

$wps = $null
foreach ($p in 'kwps.Application','wps.Application') { try { $wps = New-Object -ComObject $p; break } catch {} }
if (-not $wps) { throw 'no wps com' }
foreach ($f in $files) {
    $docx = Join-Path $dir $f
    $pdf = [System.IO.Path]::ChangeExtension($docx, '.pdf')
    $doc = $wps.Documents.Open($docx, $false, $true)
    $doc.ExportAsFixedFormat($pdf, 17)
    $doc.Close($false)
    Write-Output "PDF_OK: $pdf"
}
$wps.Quit()
