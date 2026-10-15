$ErrorActionPreference = 'Stop'
$docx = 'REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\算法安全自评估报告（备案提交版-含主体责任附件）.docx'
$pdf = [System.IO.Path]::ChangeExtension($docx, '.pdf')
$wps = $null
foreach ($p in 'kwps.Application','wps.Application') { try { $wps = New-Object -ComObject $p; break } catch {} }
$wps.Visible = $false
$doc = $wps.Documents.Open($docx, $false, $true)
try { $doc.ExportAsFixedFormat($pdf, 17) } catch { $doc.SaveAs2($pdf, 17) }
$doc.Close($false); $wps.Quit()
Write-Output 'PDF_OK'
