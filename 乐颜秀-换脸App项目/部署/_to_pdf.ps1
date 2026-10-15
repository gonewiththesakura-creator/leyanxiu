$ErrorActionPreference = 'Stop'
$dir = 'REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署'
$files = @('算法安全自评估报告（备案提交版）.docx', '拟公示内容（备案提交版）.docx')

$wps = $null
foreach ($progId in 'kwps.Application', 'wps.Application') {
    try { $wps = New-Object -ComObject $progId; break } catch {}
}
if ($null -eq $wps) { Write-Output 'NO_WPS_COM'; exit 1 }
$wps.Visible = $false

foreach ($f in $files) {
    $docx = Join-Path $dir $f
    $pdf = [System.IO.Path]::ChangeExtension($docx, '.pdf')
    $doc = $wps.Documents.Open($docx, $false, $true)
    try {
        $doc.ExportAsFixedFormat($pdf, 17)
    } catch {
        $doc.SaveAs2($pdf, 17)
    }
    $doc.Close($false)
    Write-Output ("PDF_OK: " + $pdf)
}
$wps.Quit()
