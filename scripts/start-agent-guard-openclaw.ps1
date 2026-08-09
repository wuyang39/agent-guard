param(
  [string]$RuntimeRoot = "",
  [int]$ApiPort = 3100,
  [int]$FrontendPort = 5173,
  [int]$SamplePort = 7001,
  [int]$GatewayPort = 18789,
  [switch]$NoBrowser,
  [switch]$PrintPlan
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$Path, [string]$BasePath) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Test-PortListening([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-HttpReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Wait-HttpReady([string]$Name, [string]$Url, [System.Diagnostics.Process]$Process, [string]$ErrorLog) {
  for ($i = 0; $i -lt 90; $i++) {
    if (Test-HttpReady $Url) { return }
    if ($Process.HasExited) {
      $tail = if (Test-Path -LiteralPath $ErrorLog) { [string]((Get-Content -LiteralPath $ErrorLog -Tail 20) -join "`n") } else { "" }
      throw "$Name exited before readiness. $tail"
    }
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
  }
  throw "$Name did not become ready at $Url. Check $ErrorLog"
}

function Wait-PortReady([string]$Name, [int]$Port, [System.Diagnostics.Process]$Process, [string]$ErrorLog) {
  for ($i = 0; $i -lt 360; $i++) {
    if (Test-PortListening $Port) { return }
    if ($Process.HasExited) {
      $tail = if (Test-Path -LiteralPath $ErrorLog) { [string]((Get-Content -LiteralPath $ErrorLog -Tail 20) -join "`n") } else { "" }
      throw "$Name exited before readiness. $tail"
    }
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
  }
  throw "$Name did not listen on port $Port. Check $ErrorLog"
}

function Get-OrCreateRuntimeToken([string]$Path) {
  $token = if (Test-Path -LiteralPath $Path -PathType Leaf) {
    [string](Get-Content -Raw -LiteralPath $Path).Trim()
  } else {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }
  if ($token -notmatch '^[A-Za-z0-9_-]{43}$') {
    throw "Portable runtime token file is invalid: $Path"
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, "$token`r`n", $encoding)
  }
  return $token
}

function Start-NodeService(
  [string]$Name,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$LogDirectory
) {
  $node = Get-Command node -CommandType Application -ErrorAction Stop
  $stdout = Join-Path $LogDirectory "$Name.stdout.log"
  $stderr = Join-Path $LogDirectory "$Name.stderr.log"
  $process = Start-Process -FilePath $node.Source `
    -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru
  return [pscustomobject]@{
    name = $Name
    process = $process
    stdout = $stdout
    stderr = $stderr
  }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $repoRoot "outputs" }
$RuntimeRoot = Resolve-FullPath $RuntimeRoot $repoRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "configs\openclaw-distribution.json") | ConvertFrom-Json
$forkRoot = Join-Path $RuntimeRoot ([string]$manifest.runtime.forkDirectory)
$environmentFile = Join-Path $RuntimeRoot ([string]$manifest.runtime.environmentFile)
$openClawCli = Join-Path $forkRoot "openclaw.mjs"
$guardLauncher = Join-Path $PSScriptRoot "openclaw-guard-launcher.ts"
$runtimeStateDir = Join-Path $RuntimeRoot "runtime"
$pidFile = Join-Path $runtimeStateDir "agent-guard-services.json"
$controlTokenFile = Join-Path $runtimeStateDir "agent-guard-control-token.txt"
$gatewayTokenFile = Join-Path $runtimeStateDir "openclaw-gateway-token.txt"
$logDir = Join-Path $RuntimeRoot "runs\portable-services"

$plan = [ordered]@{
  runtimeRoot = $RuntimeRoot
  environmentFile = $environmentFile
  openClawCli = $openClawCli
  sandboxImage = [string]$manifest.sandboxImage
  gatewayLifecycle = "per-run-detection-sandbox"
  supervisionGatewayLifecycle = "managed-guard-launcher"
  controlTokenFile = $controlTokenFile
  gatewayTokenFile = $gatewayTokenFile
  services = @(
    [ordered]@{ name = "gateway"; port = $GatewayPort },
    [ordered]@{ name = "sample"; port = $SamplePort },
    [ordered]@{ name = "backend"; port = $ApiPort },
    [ordered]@{ name = "frontend"; port = $FrontendPort }
  )
}
if ($PrintPlan) {
  $plan | ConvertTo-Json -Depth 6
  exit 0
}

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
  throw "Portable runtime is not bootstrapped. Run .\scripts\bootstrap-agent-guard-openclaw.ps1 first."
}
. $environmentFile

if (-not (Test-Path -LiteralPath $openClawCli -PathType Leaf)) {
  throw "Pinned OpenClaw CLI is missing: $openClawCli"
}
foreach ($port in @($GatewayPort, $SamplePort, $ApiPort, $FrontendPort)) {
  if (Test-PortListening $port) {
    throw "Port $port is already in use. Stop the existing service before starting this runtime."
  }
}

$env:API_PORT = [string]$ApiPort
$env:API_HOST = "127.0.0.1"
$env:SAMPLE_AGENT_PORT = [string]$SamplePort
$env:SAMPLE_AGENT_HOST = "127.0.0.1"
$env:VITE_AGENT_GUARD_API_BASE = "http://127.0.0.1:$ApiPort"
$env:VITE_OPENCLAW_CLI_PATH = $openClawCli
$env:AGENT_GUARD_DETECTION_IMAGE = [string]$manifest.sandboxImage
$env:AGENT_GUARD_OPENCLAW_ISOLATED_PROFILE = "1"

New-Item -ItemType Directory -Force -Path $runtimeStateDir, $logDir | Out-Null
$env:AGENT_GUARD_CONTROL_TOKEN = Get-OrCreateRuntimeToken $controlTokenFile
$env:OPENCLAW_GATEWAY_TOKEN = Get-OrCreateRuntimeToken $gatewayTokenFile
$env:OPENCLAW_GATEWAY_URL = "http://127.0.0.1:$GatewayPort"
$started = @()
try {
  Write-Host "[1/4] Starting supervised OpenClaw Gateway on 127.0.0.1:$GatewayPort..."
  $gatewayDisplayCommand = "node --import tsx $guardLauncher -- gateway run"
  Write-Host "      $gatewayDisplayCommand"
  $gateway = Start-NodeService "gateway" @(
    "--import", "tsx", $guardLauncher, "--",
    "gateway", "run", "--bind", "loopback", "--port", [string]$GatewayPort,
    "--token", $env:OPENCLAW_GATEWAY_TOKEN, "--allow-unconfigured"
  ) $repoRoot $logDir
  $started += $gateway
  Wait-PortReady "OpenClaw Gateway" $GatewayPort $gateway.process $gateway.stderr

  Write-Host "[2/4] Starting sample agent on 127.0.0.1:$SamplePort..."
  $sample = Start-NodeService "sample" @("scripts/sample-agent-server.mjs") $repoRoot $logDir
  $started += $sample
  Wait-HttpReady "Sample agent" "http://127.0.0.1:$SamplePort/health" $sample.process $sample.stderr

  Write-Host "[3/4] Starting Agent Guard API on 127.0.0.1:$ApiPort..."
  $backend = Start-NodeService "backend" @("--import", "tsx", "backend/src/server.ts") $repoRoot $logDir
  $started += $backend
  Wait-HttpReady "Agent Guard API" "http://127.0.0.1:$ApiPort/api/v1/system/status" $backend.process $backend.stderr

  Write-Host "[4/4] Starting frontend on 127.0.0.1:$FrontendPort..."
  $viteCli = Join-Path $repoRoot "node_modules\vite\bin\vite.js"
  $frontend = Start-NodeService "frontend" @(
    $viteCli,
    "--config", "frontend/vite.config.ts",
    "--host", "127.0.0.1",
    "--port", [string]$FrontendPort,
    "--strictPort"
  ) $repoRoot $logDir
  $started += $frontend
  Wait-HttpReady "Frontend" "http://127.0.0.1:$FrontendPort" $frontend.process $frontend.stderr

  $records = @($started | ForEach-Object {
    $_.process.Refresh()
    [ordered]@{
      name = $_.name
      pid = $_.process.Id
      startedAt = $_.process.StartTime.ToUniversalTime().ToString("o")
      stdout = $_.stdout
      stderr = $_.stderr
    }
  })
  $records | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $pidFile -Encoding utf8
} catch {
  foreach ($item in $started) {
    if (-not $item.process.HasExited) { Stop-Process -Id $item.process.Id -Force -ErrorAction SilentlyContinue }
  }
  throw
}

Write-Host ""
Write-Host "Agent Guard is ready." -ForegroundColor Green
Write-Host "Frontend: http://127.0.0.1:$FrontendPort"
Write-Host "API:      http://127.0.0.1:$ApiPort/api/v1/system/status"
Write-Host "OpenClaw: http://127.0.0.1:$GatewayPort"
Write-Host "Logs:     $logDir"
Write-Host "Stop:     .\scripts\stop-agent-guard-openclaw.ps1 -RuntimeRoot '$RuntimeRoot'"
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$FrontendPort" }
