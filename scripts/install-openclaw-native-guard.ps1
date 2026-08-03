# install-openclaw-native-guard.ps1
# Agent Guard OpenClaw Native Tool Guard — 安装脚本
#
# 前置条件: OpenClaw >= 2026.7.2, Node.js >= 20, Docker (可选)
# 用途: 安装 Agent Guard 监督插件到 OpenClaw 配置目录，启用原生工具 Hook
#
# 安全约束:
#   - 版本低于 2026.7.2 时不得修改用户 OpenClaw 配置
#   - 总是备份原配置到 .agent-guard-backup/
#   - 卸载脚本独立提供

param(
  [string]$OpenClawHome,
  [string]$PluginSourceDir,
  [switch]$Uninstall,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$REQUIRED_OPENCLAW = @(2026, 7, 2)
$PLUGIN_ID = "agent-guard-supervision"
$PLUGIN_NAME = "Agent Guard Native Tool Supervision"

function Write-Step { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-OK { param([string]$Message) Write-Host "  ✓ $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ⚠ $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  ✗ $Message" -ForegroundColor Red; exit 1 }

# ---- Resolve OpenClaw ----
function Get-OpenClawVersion {
  try {
    $result = & openclaw --version 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    if ($result -match '(\d+)\.(\d+)\.(\d+)') {
      return @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    }
    return $null
  } catch {
    return $null
  }
}

function Get-OpenClawConfigDir {
  if ($OpenClawHome) { return $OpenClawHome }
  if ($env:OPENCLAW_HOME) { return $env:OPENCLAW_HOME }
  if ($env:OPENCLAW_CONFIG_DIR) { return $env:OPENCLAW_CONFIG_DIR }
  return Join-Path $env:USERPROFILE ".openclaw"
}

function Get-OpenClawConfigPath {
  return Join-Path (Get-OpenClawConfigDir) "openclaw.json"
}

# ---- Main ----
Write-Host "Agent Guard OpenClaw Native Tool Guard Installer" -ForegroundColor Green
Write-Host "================================================`n"

# Check OpenClaw
Write-Step "Checking OpenClaw CLI..."
$version = Get-OpenClawVersion
if (-not $version) {
  Write-Fail "OpenClaw CLI not found. Install openclaw >= 2026.7.2 first."
}
$versionStr = "$($version[0]).$($version[1]).$($version[2])"
Write-OK "OpenClaw $versionStr detected."

# Version check
for ($i = 0; $i -lt 3; $i++) {
  if ($version[$i] -lt $REQUIRED_OPENCLAW[$i]) {
    if (-not $Force) {
      Write-Fail "OpenClaw $versionStr is below minimum $($REQUIRED_OPENCLAW -join '.'). Use -Force to override, but native guard may not function correctly."
    }
    Write-Warn "OpenClaw $versionStr is below minimum $($REQUIRED_OPENCLAW -join '.'). Continuing with -Force."
    break
  }
  if ($version[$i] -gt $REQUIRED_OPENCLAW[$i]) { break }
}

# Uninstall mode
if ($Uninstall) {
  Write-Step "Uninstalling $PLUGIN_NAME..."
  $configPath = Get-OpenClawConfigPath
  if (-not (Test-Path $configPath)) {
    Write-Warn "OpenClaw config not found at $configPath. Nothing to uninstall."
    exit 0
  }

  # Backup before modifying
  $backupDir = Join-Path (Get-OpenClawConfigDir) ".agent-guard-backup"
  $backupPath = Join-Path $backupDir "openclaw.json.$(Get-Date -Format 'yyyyMMddHHmmss').bak"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item $configPath $backupPath
  Write-OK "Config backed up to $backupPath"

  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  if ($config.plugins) {
    $config.plugins = @($config.plugins | Where-Object { $_.id -ne $PLUGIN_ID })
  }
  if ($config.pluginDirs) {
    $config.pluginDirs = @($config.pluginDirs | Where-Object { $_ -notmatch "agent-guard-supervision" })
  }
  $config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
  Write-OK "$PLUGIN_NAME uninstalled. Restart OpenClaw Gateway to apply."
  exit 0
}

# Install mode
Write-Step "Installing $PLUGIN_NAME..."

# Resolve plugin source
if (-not $PluginSourceDir) {
  $PluginSourceDir = Join-Path (Split-Path $PSScriptRoot -Parent) "plugins" "agent-guard-supervision" "dist"
}
if (-not (Test-Path (Join-Path $PluginSourceDir "index.js"))) {
  Write-Fail "Plugin dist not found at $PluginSourceDir\index.js. Build the plugin first: npm run build:openclaw-plugin"
}
Write-OK "Plugin dist found at $PluginSourceDir."

# Ensure config directory
$configDir = Get-OpenClawConfigDir
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$configPath = Get-OpenClawConfigPath

# Backup existing config
if (Test-Path $configPath) {
  $backupDir = Join-Path $configDir ".agent-guard-backup"
  $backupPath = Join-Path $backupDir "openclaw.json.$(Get-Date -Format 'yyyyMMddHHmmss').bak"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item $configPath $backupPath
  Write-OK "Config backed up to $backupPath"
}

# Load or create config
$config = @{}
if (Test-Path $configPath) {
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $config) { $config = @{} }
    # ConvertTo-Json loses nested object type; work with hashtable
    $json = Get-Content $configPath -Raw | ConvertFrom-Json
  } catch {
    Write-Warn "Could not parse existing config; creating fresh config."
    $config = @{}
  }
}

# Ensure plugins array
$plugins = @()
if ($config.plugins) {
  $plugins = @($config.plugins)
}

# Check if already installed
$existing = $plugins | Where-Object { $_.id -eq $PLUGIN_ID }
if ($existing) {
  Write-Warn "$PLUGIN_NAME is already registered. Use -Force to re-install."
  if (-not $Force) { exit 0 }
  $plugins = @($plugins | Where-Object { $_.id -ne $PLUGIN_ID })
}

# Add plugin entry
$pluginEntry = @{
  id = $PLUGIN_ID
  name = $PLUGIN_NAME
  enabled = $true
  path = $PluginSourceDir
  config = @{
    markerDir = Join-Path $configDir "agent-guard" "markers"
    spoolDir = Join-Path $configDir "agent-guard" "spool"
  }
}
$plugins += $pluginEntry

# Ensure pluginDirs
$pluginDirs = @()
if ($config.pluginDirs) {
  $pluginDirs = @($config.pluginDirs)
}
if ($PluginSourceDir -notin $pluginDirs) {
  $pluginDirs += $PluginSourceDir
}

# Save config
$config | Add-Member -MemberType NoteProperty -Name "plugins" -Value $plugins -Force
$config | Add-Member -MemberType NoteProperty -Name "pluginDirs" -Value $pluginDirs -Force

# Ensure agent-guard data dirs
$markerDir = Join-Path $configDir "agent-guard" "markers"
$spoolDir = Join-Path $configDir "agent-guard" "spool"
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null

# Write config
$configJson = $config | ConvertTo-Json -Depth 10
$configJson | Set-Content $configPath -Encoding UTF8

Write-OK "$PLUGIN_NAME installed successfully."
Write-OK "Config written to $configPath"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Restart OpenClaw Gateway"
Write-Host "  2. Verify: openclaw plugins list --json"
Write-Host "  3. Check status: openclaw gateway status"
Write-Host "  4. Run verification: npm run verify:native-guard"
Write-Host ""
Write-Host "Uninstall: .\scripts\install-openclaw-native-guard.ps1 -Uninstall"
exit 0
