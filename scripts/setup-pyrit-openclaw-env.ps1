[CmdletBinding()]
param(
  [string]$Endpoint = "",
  [string]$Model = "deepseek-v4-pro",
  [string]$KeyEnvName = "",
  [string]$OpenClawProviderKeyEnvName = "DEEPSEEK_API_KEY",
  [switch]$Required
)

$ErrorActionPreference = "Stop"

function First-NonEmpty {
  param([string[]]$Values)
  foreach ($value in $Values) {
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value
    }
  }
  return ""
}

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port
  )
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $task = $client.ConnectAsync($HostName, $Port)
    $connected = $task.Wait(700)
    if ($connected) {
      $client.Close()
      return $true
    }
    $client.Close()
    return $false
  } catch {
    return $false
  }
}

$defaultPyritOpenClawEndpoint = "http://127.0.0.1:3100/api/v1/pyrit/openclaw/v1"
$resolvedEndpoint = First-NonEmpty @(
  $Endpoint,
  $env:AGENT_GUARD_LLM_ENDPOINT,
  $env:OPENAI_CHAT_ENDPOINT,
  $env:AGENT_GUARD_PYRIT_OPENAI_CHAT_ENDPOINT,
  $env:AGENT_GUARD_PYRIT_OPENCLAW_CHAT_ENDPOINT,
  $env:OPENCLAW_CHAT_ENDPOINT,
  $env:DEEPSEEK_ENDPOINT
)

$endpointWasDefaulted = $false
if ([string]::IsNullOrWhiteSpace($resolvedEndpoint)) {
  $resolvedEndpoint = $defaultPyritOpenClawEndpoint
  $endpointWasDefaulted = $true
}

if ($resolvedEndpoint -match "/api/v1/openclaw/realtime/mcp/?$") {
  $message = "OPENAI_CHAT_ENDPOINT must be an OpenAI-compatible chat base URL. The Agent Guard realtime MCP endpoint is not a model endpoint: $resolvedEndpoint"
  if ($Required) {
    throw $message
  }
  Write-Warning $message
}

$resolvedKey = First-NonEmpty @(
  $(if ($KeyEnvName) { [Environment]::GetEnvironmentVariable($KeyEnvName) } else { "" }),
  $env:AGENT_GUARD_LLM_API_KEY,
  $env:AGENT_GUARD_LLM_KEY,
  $env:OPENAI_CHAT_KEY,
  $env:AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY,
  $env:DEEPSEEK_API_KEY,
  $env:DeepSeek_API_2
)

if ([string]::IsNullOrWhiteSpace($resolvedKey)) {
  $message = "Missing OPENAI_CHAT_KEY. Set OPENAI_CHAT_KEY, AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY, a provider key such as DEEPSEEK_API_KEY, or pass -KeyEnvName <YOUR_LOCAL_KEY_ENV>. DeepSeek_API_2 is only a local example name."
  if ($Required) {
    throw $message
  }
  Write-Warning $message
} else {
  $env:OPENAI_CHAT_KEY = $resolvedKey
  $env:AGENT_GUARD_LLM_API_KEY = $resolvedKey
  if ($OpenClawProviderKeyEnvName -and -not [Environment]::GetEnvironmentVariable($OpenClawProviderKeyEnvName)) {
    Set-Item -Path "env:$OpenClawProviderKeyEnvName" -Value $resolvedKey
  }
}

$env:AGENT_GUARD_LLM_ENABLED = "1"
$env:AGENT_GUARD_LLM_MODE = "openai_compatible"
$env:AGENT_GUARD_LLM_ENDPOINT = $resolvedEndpoint
$env:OPENAI_CHAT_ENDPOINT = $resolvedEndpoint
$env:AGENT_GUARD_PYRIT_OPENCLAW_CHAT_ENDPOINT = $resolvedEndpoint
$env:AGENT_GUARD_LLM_MODEL = $Model
$env:OPENAI_CHAT_MODEL = $Model
$env:DEEPSEEK_MODEL = $Model

Write-Host "Agent Guard PyRIT runtime env prepared for this PowerShell process."
Write-Host "AGENT_GUARD_LLM_ENDPOINT=$resolvedEndpoint"
Write-Host "AGENT_GUARD_LLM_MODEL=$Model"
Write-Host "OPENAI_CHAT_ENDPOINT=$resolvedEndpoint"
Write-Host "OPENAI_CHAT_MODEL=$Model"
Write-Host ("OPENAI_CHAT_KEY=" + ($(if ([string]::IsNullOrWhiteSpace($resolvedKey)) { "missing" } else { "set" })))
if ($OpenClawProviderKeyEnvName) {
  Write-Host ("$OpenClawProviderKeyEnvName=" + ($(if ([Environment]::GetEnvironmentVariable($OpenClawProviderKeyEnvName)) { "set" } else { "missing" })))
}

if ($endpointWasDefaulted) {
  Write-Warning "Endpoint defaulted to the Agent Guard PyRIT/OpenClaw OpenAI-compatible shim $defaultPyritOpenClawEndpoint. Start Agent Guard API before running required model-backed tests."
}

try {
  $uri = [System.Uri]$resolvedEndpoint
  if ($uri.Host -in @("127.0.0.1", "localhost") -and -not (Test-TcpPort -HostName $uri.Host -Port $uri.Port)) {
    $message = "No local TCP listener detected at $($uri.Host):$($uri.Port). Start Agent Guard API/OpenClaw runtime or provide a reachable endpoint."
    if ($Required) {
      throw $message
    }
    Write-Warning $message
  }
} catch {
  if ($Required) {
    throw
  }
  Write-Warning "Could not validate endpoint reachability: $($_.Exception.Message)"
}

Write-Host "Run in the same shell after dot-sourcing this script:"
Write-Host "  npm run verify:a-pyrit-runtime"
Write-Host "  npm run a:pyrit-runtime"
Write-Host ""
Write-Host "To persist these variables for subsequent commands, call the script with a leading dot:"
Write-Host "  . .\scripts\setup-pyrit-openclaw-env.ps1"
