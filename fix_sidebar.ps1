$lines = [System.IO.File]::ReadAllLines('C:\UGit\nowen-note\frontend\src\components\Sidebar.tsx')
$newLines = [System.Collections.ArrayList]::new()
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($i -eq 642) { continue }
    [void]$newLines.Add($lines[$i])
}
[System.IO.File]::WriteAllLines('C:\UGit\nowen-note\frontend\src\components\Sidebar.tsx', $newLines)
Write-Host "Done. Removed line 643 (0-indexed 642). New line count: $($newLines.Count)"
