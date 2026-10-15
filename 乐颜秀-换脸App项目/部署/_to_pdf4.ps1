$ErrorActionPreference = 'Stop'
$docx = 'REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\深度合成备案材料B（语音合成）.docx'
$pdf = [System.IO.Path]::ChangeExtension($docx, '.pdf')
$wps = $null
foreach ($p in 'kwps.Application','wps.Application') { try { $wps = New-Object -ComObject $p; break } catch {} }
if (-not $wps) { throw 'no wps com' }
$doc = $wps.Documents.Open($docx, $false, $true)
$doc.ExportAsFixedFormat($pdf, 17)
$doc.Close($false)
$wps.Quit()
Write-Output 'PDF_OK'
