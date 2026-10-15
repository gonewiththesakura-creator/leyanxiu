$ErrorActionPreference = 'Stop'
$dir = 'REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署'
$files = @('技术服务合作协议模板（4家厂商）.docx', '乐颜秀备案冲刺-老板操作手册.docx')
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
