param(
  [string]$RuntimeRoot = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $repoRoot "outputs" }
if (-not [System.IO.Path]::IsPathRooted($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $repoRoot $RuntimeRoot
}
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$pidFile = Join-Path $RuntimeRoot "runtime\agent-guard-services.json"

if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
  Write-Host "No portable Agent Guard service registry found."
  exit 0
}

$parsedRecords = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
$records = if ($parsedRecords -is [System.Array]) {
  @($parsedRecords | ForEach-Object { $_ })
} else {
  @($parsedRecords)
}
foreach ($record in $records) {
  $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
  if (-not $process) {
    Write-Host "$($record.name): already stopped."
    continue
  }
  $actualStart = $process.StartTime.ToUniversalTime().ToString("o")
  if ($actualStart -cne [string]$record.startedAt) {
    Write-Warning "$($record.name): PID $($record.pid) was reused; leaving it untouched."
    continue
  }
  $processTable = @(Get-CimInstance Win32_Process)
  $descendants = @()
  $frontier = @([int]$process.Id)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($parentId in $frontier) {
      $children = @($processTable | Where-Object { [int]$_.ParentProcessId -eq $parentId })
      foreach ($child in $children) {
        $descendants += [int]$child.ProcessId
        $next += [int]$child.ProcessId
      }
    }
    $frontier = $next
  }
  $uniqueDescendants = @($descendants | Select-Object -Unique)
  [Array]::Reverse($uniqueDescendants)
  foreach ($childId in $uniqueDescendants) {
    Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $process.Id -Force
  $process.WaitForExit(10000) | Out-Null
  Write-Host "$($record.name): stopped PID $($record.pid)."
}
Remove-Item -LiteralPath $pidFile -Force
