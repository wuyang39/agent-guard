param(
  [string]$RuntimeRoot = "",
  [string]$ProviderKeyEnvName = "DEEPSEEK_API_KEY",
  [string]$ExampleLocalKeyEnvName = "DeepSeek_API_2"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $RuntimeRoot) {
  $RuntimeRoot = Join-Path (Resolve-Path (Join-Path $repoRoot "..")) "openclaw-runtime"
}
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$openClawCli = Join-Path $RuntimeRoot "openclaw-local.cmd"
$openClawHome = Join-Path $RuntimeRoot "home"
$openClawWorkspace = Join-Path $RuntimeRoot "workspace"
$logDir = Join-Path $repoRoot "outputs\runs"

if (-not (Test-Path $openClawCli)) {
  throw "OpenClaw runtime wrapper not found: $openClawCli"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$env:OPENCLAW_CLI = $openClawCli
$env:OPENCLAW_HOME = $openClawHome
$env:OPENCLAW_WORKSPACE = $openClawWorkspace
$env:OPENCLAW_TIMEOUT_MS = "15000"
$env:HTTP_PROXY = ""
$env:HTTPS_PROXY = ""
$env:ALL_PROXY = ""
$env:http_proxy = ""
$env:https_proxy = ""
$env:all_proxy = ""
$env:NO_PROXY = "*"
$env:no_proxy = "*"

if ($ProviderKeyEnvName -and -not [Environment]::GetEnvironmentVariable($ProviderKeyEnvName)) {
  $providerKey = ""
  if ($ExampleLocalKeyEnvName) {
    $providerKey = [Environment]::GetEnvironmentVariable($ExampleLocalKeyEnvName)
    if (-not $providerKey) {
      $providerKey = [Environment]::GetEnvironmentVariable($ExampleLocalKeyEnvName, "User")
    }
  }
  if ($providerKey) {
    Set-Item -Path "env:$ProviderKeyEnvName" -Value $providerKey
  }
}

function Test-PortListening([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-HiddenPowerShell([string]$Command) {
  Start-Process -FilePath powershell `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $Command) `
    -WindowStyle Hidden | Out-Null
}

Write-Host "Agent Guard + project OpenClaw runtime"
Write-Host "Repo:          $repoRoot"
Write-Host "OpenClaw CLI:  $openClawCli"
Write-Host "OpenClaw HOME: $openClawHome"
Write-Host ""

if (-not (Test-PortListening 18789)) {
  $gatewayLog = Join-Path $logDir "openclaw-gateway.log"
  $gatewayErr = Join-Path $logDir "openclaw-gateway.err.log"
  $gatewayCommand = @"
`$env:OPENCLAW_HOME='$openClawHome';
`$env:OPENCLAW_WORKSPACE='$openClawWorkspace';
`$env:OPENCLAW_NO_ONBOARD='1';
`$env:HTTP_PROXY='';
`$env:HTTPS_PROXY='';
`$env:ALL_PROXY='';
`$env:http_proxy='';
`$env:https_proxy='';
`$env:all_proxy='';
`$env:NO_PROXY='*';
`$env:no_proxy='*';
Set-Location '$RuntimeRoot';
.\openclaw-local.cmd gateway run --port 18789 --bind loopback *> '$gatewayLog' 2> '$gatewayErr'
"@
  Write-Host "[1/4] Starting OpenClaw gateway on 127.0.0.1:18789..."
  Start-HiddenPowerShell $gatewayCommand
  for ($i = 0; $i -lt 30 -and -not (Test-PortListening 18789); $i++) {
    Start-Sleep -Seconds 1
  }
  if (-not (Test-PortListening 18789)) {
    throw "OpenClaw gateway did not become ready. Check $gatewayLog and $gatewayErr"
  }
} else {
  Write-Host "[1/4] OpenClaw gateway already listening on 127.0.0.1:18789."
}

if (-not (Test-PortListening 5173)) {
  $frontendLog = Join-Path $logDir "demo-frontend.log"
  $frontendErr = Join-Path $logDir "demo-frontend.err.log"
  $frontendCommand = @"
`$env:OPENCLAW_CLI='$openClawCli';
`$env:OPENCLAW_HOME='$openClawHome';
`$env:OPENCLAW_WORKSPACE='$openClawWorkspace';
`$env:HTTP_PROXY='';
`$env:HTTPS_PROXY='';
`$env:ALL_PROXY='';
`$env:http_proxy='';
`$env:https_proxy='';
`$env:all_proxy='';
`$env:NO_PROXY='*';
`$env:no_proxy='*';
Set-Location '$repoRoot';
npm run frontend *> '$frontendLog' 2> '$frontendErr'
"@
  Write-Host "[2/4] Starting frontend on http://127.0.0.1:5173..."
  Start-HiddenPowerShell $frontendCommand
} else {
  Write-Host "[2/4] Frontend already listening on http://127.0.0.1:5173."
}

Write-Host "[3/4] Opening frontend..."
Start-Process "http://127.0.0.1:5173"

Write-Host "[4/4] Starting P2 backend/sample demo in this terminal..."
Write-Host "Press Ctrl+C to stop Agent Guard backend/sample. Background frontend/gateway can be stopped from Task Manager or by closing their processes."
Write-Host ""

Set-Location $repoRoot
npm run demo:p2
