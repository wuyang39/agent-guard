# install-openclaw-native-guard.ps1
# Agent Guard OpenClaw Native Tool Guard — 安装脚本
#
# 前置条件: OpenClaw 2026.7.1-agentguard.1 或官方稳定版 >= 2026.7.2,
#           Node.js >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0, Docker (可选)
# 用途: 安装 Agent Guard 监督插件到 OpenClaw 配置目录，启用原生工具 Hook
#
# 安全约束:
#   - 只接受 exact 2026.7.1-agentguard.1 fork，或官方稳定版 >= 2026.7.2
#   - CLI 与隔离配置目录必须显式提供，禁止 PATH/用户默认目录 fallback
#   - 总是备份原配置到 .agent-guard-backup/
#   - 卸载脚本独立提供

param(
  [string]$OpenClawCli,
  [string]$OpenClawHome,
  [string]$PluginSourceDir,
  [switch]$Uninstall,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$OFFICIAL_REQUIRED_OPENCLAW = @(2026, 7, 2)
$FORK_REQUIRED_OPENCLAW = @(2026, 7, 1)
$PLUGIN_ID = "agent-guard-supervision"
$PLUGIN_NAME = "Agent Guard Native Tool Supervision"

function Write-Step { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-OK { param([string]$Message) Write-Host "  ✓ $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ⚠ $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  ✗ $Message" -ForegroundColor Red; exit 1 }

# ---- Resolve OpenClaw ----
function Get-OpenClawVersion {
  try {
    $extension = [System.IO.Path]::GetExtension($script:ResolvedOpenClawCli).ToLowerInvariant()
    if ($extension -in @(".js", ".mjs", ".cjs")) {
      $nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
      $result = & $nodeCommand.Source $script:ResolvedOpenClawCli --version 2>&1
    } else {
      $result = & $script:ResolvedOpenClawCli --version 2>&1
    }
    if ($LASTEXITCODE -ne 0) { return $null }
    $raw = [string]($result -join "`n")
    if ($raw -match '(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?') {
      $matchedVersion = [string]$Matches[0]
      $prerelease = [string]$Matches[4]
      return [pscustomobject]@{
        Parts = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
        Raw = $raw
        IsAgentGuardFork = ($matchedVersion -ceq '2026.7.1-agentguard.1')
        IsOfficialStable = [string]::IsNullOrEmpty($prerelease)
      }
    }
    return $null
  } catch {
    return $null
  }
}

function Resolve-OpenClawCli {
  if ($OpenClawCli) { return $OpenClawCli }
  if ($env:OPENCLAW_CLI) { return $env:OPENCLAW_CLI }
  return $null
}

function Resolve-OpenClawConfigDir {
  if ($OpenClawHome) { return $OpenClawHome }
  if ($env:OPENCLAW_HOME) { return $env:OPENCLAW_HOME }
  if ($env:OPENCLAW_CONFIG_DIR) { return $env:OPENCLAW_CONFIG_DIR }
  return $null
}

function Get-OpenClawConfigDir {
  return $script:ResolvedOpenClawHome
}

function Get-OpenClawConfigPath {
  return Join-Path (Get-OpenClawConfigDir) "openclaw.json"
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, "$Content`r`n", $encoding)
}

function New-JsonObject {
  return [pscustomobject]@{}
}

function Set-JsonProperty {
  param($Object, [string]$Name, $Value)
  $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force
}

function Remove-JsonProperty {
  param($Object, [string]$Name)
  if ($Object -and $Object.PSObject.Properties[$Name]) {
    $Object.PSObject.Properties.Remove($Name)
  }
}

function Add-UniquePluginPath {
  param([System.Collections.ArrayList]$Paths, [string]$Candidate)
  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    Write-Fail "OpenClaw plugin path configuration is invalid; config was not modified."
  }
  $exists = $Paths | Where-Object {
    [string]::Equals([string]$_, $Candidate, [System.StringComparison]::OrdinalIgnoreCase)
  }
  if (-not $exists) { [void]$Paths.Add($Candidate) }
}

function Assert-LegacyPluginEntry {
  param($Entry)
  if (-not $Entry -or $Entry -is [System.Array] -or $Entry -isnot [pscustomobject]) {
    Write-Fail "Legacy OpenClaw plugin entry is invalid; config was not modified."
  }
  $allowed = @("id", "enabled", "path", "config")
  foreach ($property in $Entry.PSObject.Properties) {
    if ($property.Name -notin $allowed) {
      Write-Fail "Legacy OpenClaw plugin entry contains unsupported fields; config was not modified."
    }
  }
  if ($Entry.id -isnot [string] -or $Entry.id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
    Write-Fail "Legacy OpenClaw plugin id is invalid; config was not modified."
  }
  if ($Entry.PSObject.Properties["enabled"] -and $Entry.enabled -isnot [bool]) {
    Write-Fail "Legacy OpenClaw plugin enabled state is invalid; config was not modified."
  }
  if ($Entry.PSObject.Properties["path"] -and
      ($Entry.path -isnot [string] -or [string]::IsNullOrWhiteSpace($Entry.path))) {
    Write-Fail "Legacy OpenClaw plugin path is invalid; config was not modified."
  }
  if ($Entry.PSObject.Properties["config"] -and
      ($Entry.config -is [System.Array] -or $Entry.config -isnot [pscustomobject])) {
    Write-Fail "Legacy OpenClaw plugin config is invalid; config was not modified."
  }
}

function Normalize-PluginSourceDir {
  if (-not $PluginSourceDir) {
    $script:PluginSourceDir = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) "plugins") "agent-guard-supervision"
  }
}

# ---- Main ----
Write-Host "Agent Guard OpenClaw Native Tool Guard Installer" -ForegroundColor Green
Write-Host "================================================`n"

# Resolve the complete target identity before any CLI call or filesystem write.
$script:ResolvedOpenClawCli = Resolve-OpenClawCli
if ([string]::IsNullOrWhiteSpace($script:ResolvedOpenClawCli)) {
  Write-Fail "OpenClaw CLI must be provided with -OpenClawCli or OPENCLAW_CLI; config was not modified."
}
$script:ResolvedOpenClawHome = Resolve-OpenClawConfigDir
if ([string]::IsNullOrWhiteSpace($script:ResolvedOpenClawHome)) {
  Write-Fail "Isolated OpenClaw config directory must be provided with -OpenClawHome, OPENCLAW_HOME, or OPENCLAW_CONFIG_DIR; config was not modified."
}

# Check OpenClaw
Write-Step "Checking OpenClaw CLI..."
$versionInfo = Get-OpenClawVersion
if (-not $versionInfo) {
  Write-Fail "The explicit OpenClaw CLI could not be executed. Use exactly 2026.7.1-agentguard.1 or an official stable version >= 2026.7.2."
}
$version = $versionInfo.Parts
$versionStr = "$($version[0]).$($version[1]).$($version[2])"
Write-OK "OpenClaw $versionStr detected."

if (-not $versionInfo.IsAgentGuardFork -and -not $versionInfo.IsOfficialStable) {
  Write-Fail "Unsupported OpenClaw prerelease. Use exactly 2026.7.1-agentguard.1 or an official stable version >= 2026.7.2."
}

# Version check
$requiredOpenClaw = if ($versionInfo.IsAgentGuardFork) {
  $FORK_REQUIRED_OPENCLAW
} else {
  $OFFICIAL_REQUIRED_OPENCLAW
}
for ($i = 0; $i -lt 3; $i++) {
  if ($version[$i] -lt $requiredOpenClaw[$i]) {
    Write-Fail "OpenClaw $versionStr is below minimum $($requiredOpenClaw -join '.'). -Force cannot bypass the native guard compatibility gate."
  }
  if ($version[$i] -gt $requiredOpenClaw[$i]) { break }
}

Normalize-PluginSourceDir

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
  $backupPath = Join-Path $backupDir "openclaw.json.$(Get-Date -Format 'yyyyMMddHHmmssfff').bak"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item $configPath $backupPath
  Write-OK "Config backed up to $backupPath"

  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  if ($config.plugins -and $config.plugins.load -and $config.plugins.load.paths) {
    $remainingPaths = @($config.plugins.load.paths | Where-Object {
      -not [string]::Equals([string]$_, $PluginSourceDir, [System.StringComparison]::OrdinalIgnoreCase)
    })
    Set-JsonProperty $config.plugins.load "paths" $remainingPaths
  }
  if ($config.plugins -and $config.plugins.entries) {
    Remove-JsonProperty $config.plugins.entries $PLUGIN_ID
  }
  Remove-JsonProperty $config "pluginDirs"
  Write-Utf8NoBom $configPath ($config | ConvertTo-Json -Depth 100)
  Write-OK "$PLUGIN_NAME uninstalled. Restart OpenClaw Gateway to apply."
  exit 0
}

# Install mode
Write-Step "Installing $PLUGIN_NAME..."

# Validate plugin package root
$manifestPath = Join-Path $PluginSourceDir "openclaw.plugin.json"
$pluginEntryPath = Join-Path (Join-Path $PluginSourceDir "dist") "index.js"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $pluginEntryPath -PathType Leaf)) {
  Write-Fail "Plugin package not found at $PluginSourceDir. Expected openclaw.plugin.json and dist\index.js. Build the plugin first: npm run build:openclaw-plugin"
}
Write-OK "Plugin package found at $PluginSourceDir."

# Ensure config directory
$configDir = Get-OpenClawConfigDir
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$configPath = Get-OpenClawConfigPath

# Backup existing config
if (Test-Path $configPath) {
  $backupDir = Join-Path $configDir ".agent-guard-backup"
  $backupPath = Join-Path $backupDir "openclaw.json.$(Get-Date -Format 'yyyyMMddHHmmssfff').bak"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item $configPath $backupPath
  Write-OK "Config backed up to $backupPath"
}

# Load or create config
$config = New-JsonObject
if (Test-Path $configPath) {
  $existingConfig = Get-Content $configPath -Raw
  if (-not [string]::IsNullOrWhiteSpace($existingConfig)) {
    try {
      $config = $existingConfig | ConvertFrom-Json
      if (-not $config) { $config = New-JsonObject }
    } catch {
      Write-Fail "Existing OpenClaw config is invalid; config was not modified."
    }
  }
}

# Ensure OpenClaw plugin schema objects and migrate the former array shape.
$paths = [System.Collections.ArrayList]::new()
if ($config.PSObject.Properties["pluginDirs"]) {
  if ($config.pluginDirs -isnot [System.Array]) {
    Write-Fail "Legacy OpenClaw pluginDirs is invalid; config was not modified."
  }
  foreach ($legacyPath in $config.pluginDirs) {
    if ($legacyPath -isnot [string]) {
      Write-Fail "Legacy OpenClaw pluginDirs is invalid; config was not modified."
    }
    Add-UniquePluginPath $paths $legacyPath
  }
}

if ($config.plugins -is [System.Array]) {
  $plugins = New-JsonObject
  $load = New-JsonObject
  $entries = New-JsonObject
  foreach ($legacyEntry in $config.plugins) {
    Assert-LegacyPluginEntry $legacyEntry
    if ($entries.PSObject.Properties[[string]$legacyEntry.id]) {
      Write-Fail "Legacy OpenClaw plugin ids are duplicated; config was not modified."
    }
    $entry = New-JsonObject
    if ($legacyEntry.PSObject.Properties["enabled"]) {
      Set-JsonProperty $entry "enabled" ([bool]$legacyEntry.enabled)
    }
    if ($legacyEntry.PSObject.Properties["config"]) {
      Set-JsonProperty $entry "config" $legacyEntry.config
    }
    Set-JsonProperty $entries ([string]$legacyEntry.id) $entry
    if ($legacyEntry.PSObject.Properties["path"]) {
      Add-UniquePluginPath $paths ([string]$legacyEntry.path)
    }
  }
} elseif (-not $config.plugins) {
  $plugins = New-JsonObject
  $load = New-JsonObject
  $entries = New-JsonObject
} elseif ($config.plugins -is [pscustomobject]) {
  $plugins = $config.plugins
  if ($plugins.load -and $plugins.load -isnot [pscustomobject]) {
    Write-Fail "OpenClaw plugins.load is invalid; config was not modified."
  }
  if ($plugins.entries -and $plugins.entries -isnot [pscustomobject]) {
    Write-Fail "OpenClaw plugins.entries is invalid; config was not modified."
  }
  $load = if ($plugins.load) { $plugins.load } else { New-JsonObject }
  $entries = if ($plugins.entries) { $plugins.entries } else { New-JsonObject }
  if ($load.PSObject.Properties["paths"]) {
    if ($load.paths -isnot [System.Array]) {
      Write-Fail "OpenClaw plugins.load.paths is invalid; config was not modified."
    }
    foreach ($existingPath in $load.paths) {
      if ($existingPath -isnot [string]) {
        Write-Fail "OpenClaw plugins.load.paths is invalid; config was not modified."
      }
      Add-UniquePluginPath $paths $existingPath
    }
  }
} else {
  Write-Fail "OpenClaw plugins configuration is invalid; config was not modified."
}

if ($entries.PSObject.Properties[$PLUGIN_ID]) {
  Write-Warn "$PLUGIN_NAME is already registered. Use -Force to re-install."
  if (-not $Force) { exit 0 }
}

# Add plugin entry and package root
$pluginEntry = [ordered]@{
  enabled = $true
  config = [ordered]@{
    markerDir = Join-Path (Join-Path $configDir "agent-guard") "markers"
    spoolDir = Join-Path (Join-Path $configDir "agent-guard") "spool"
  }
}
Set-JsonProperty $entries $PLUGIN_ID $pluginEntry
Add-UniquePluginPath $paths $PluginSourceDir

# Save config
Set-JsonProperty $load "paths" @($paths.ToArray())
Set-JsonProperty $plugins "load" $load
Set-JsonProperty $plugins "entries" $entries
Set-JsonProperty $config "plugins" $plugins
Remove-JsonProperty $config "pluginDirs"

# Ensure agent-guard data dirs
$markerDir = Join-Path (Join-Path $configDir "agent-guard") "markers"
$spoolDir = Join-Path (Join-Path $configDir "agent-guard") "spool"
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null

# Write config
$configJson = $config | ConvertTo-Json -Depth 100
Write-Utf8NoBom $configPath $configJson

Write-OK "$PLUGIN_NAME installed successfully."
Write-OK "Config written to $configPath"
Write-Host ""
$resolvedCliExtension = [System.IO.Path]::GetExtension($script:ResolvedOpenClawCli).ToLowerInvariant()
$cliCommandDisplay = if ($resolvedCliExtension -in @(".js", ".mjs", ".cjs")) {
  "node `"$script:ResolvedOpenClawCli`""
} else {
  "`"$script:ResolvedOpenClawCli`""
}
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Restart OpenClaw Gateway"
Write-Host "  2. Verify with the same explicit CLI: $cliCommandDisplay plugins list --json"
Write-Host "  3. Check status with the same explicit CLI and isolated profile"
Write-Host "  4. Run verification: npm run verify:native-guard"
Write-Host ""
Write-Host "Uninstall: .\scripts\install-openclaw-native-guard.ps1 -OpenClawCli <path> -OpenClawHome <isolated-profile> -Uninstall"
exit 0
