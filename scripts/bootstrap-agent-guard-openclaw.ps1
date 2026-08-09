param(
  [string]$RuntimeRoot = "",
  [string]$ProfileRoot = "",
  [switch]$PrintPlan,
  [switch]$CheckPrerequisites,
  [switch]$SkipAgentGuardDependencies,
  [switch]$SkipDockerPull,
  [switch]$SkipForkBuild
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$Path, [string]$BasePath) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Invoke-Checked([string]$Command, [string[]]$Arguments, [string]$FailureMessage) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code $LASTEXITCODE)"
  }
}

function Resolve-Application([string[]]$Names) {
  foreach ($name in $Names) {
    $matches = @(Get-Command $name -CommandType Application -ErrorAction SilentlyContinue)
    if ($matches.Count -gt 0) {
      return [string]$matches[0].Path
    }
  }
  throw "Required executable was not found: $($Names -join ', ')"
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Quote-PowerShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-BuildStampHead([string]$ForkRoot) {
  $stampPath = Join-Path $ForkRoot "dist\.buildstamp"
  if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) { return $null }
  try {
    return [string]((Get-Content -Raw -LiteralPath $stampPath | ConvertFrom-Json).head)
  } catch {
    return $null
  }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $repoRoot "outputs" }
$RuntimeRoot = Resolve-FullPath $RuntimeRoot $repoRoot

$manifestPath = Join-Path $repoRoot "configs\openclaw-distribution.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -cne "agent-guard-openclaw-distribution-1") {
  throw "Unsupported OpenClaw distribution manifest."
}
$forkRepository = [string]$manifest.fork.repository
$forkBranch = [string]$manifest.fork.branch
$forkCommit = [string]$manifest.fork.commit
$forkVersion = [string]$manifest.fork.version
$sandboxImage = [string]$manifest.sandboxImage

$forkRoot = Join-Path $RuntimeRoot ([string]$manifest.runtime.forkDirectory)
$profileRoot = if ($ProfileRoot) {
  Resolve-FullPath $ProfileRoot $repoRoot
} else {
  $userProfile = [Environment]::GetFolderPath("UserProfile")
  if ([string]::IsNullOrWhiteSpace($userProfile)) { $userProfile = $HOME }
  Join-Path (Join-Path $userProfile ".agent-guard") ([string]$manifest.runtime.profileDirectory)
}
$profileRoot = [System.IO.Path]::GetFullPath($profileRoot)
$environmentFile = Join-Path $RuntimeRoot ([string]$manifest.runtime.environmentFile)
$openClawCli = Join-Path $forkRoot "openclaw.mjs"
$inspectorCli = Join-Path $forkRoot "dist\cli\native-guard-inspector.js"
$configPath = Join-Path $profileRoot "openclaw.json"
$stateDir = Join-Path $profileRoot "state"
$workspaceDir = Join-Path $profileRoot "workspace"

$plan = [ordered]@{
  runtimeRoot = $RuntimeRoot
  forkRoot = $forkRoot
  profileRoot = $profileRoot
  environmentFile = $environmentFile
  forkRepository = $forkRepository
  forkBranch = $forkBranch
  forkCommit = $forkCommit
  forkVersion = $forkVersion
  sandboxImage = $sandboxImage
}
if ($PrintPlan) {
  $plan | ConvertTo-Json -Depth 5
  exit 0
}

$nodePath = Resolve-Application @("node.exe", "node")
$npmPath = Resolve-Application @("npm.cmd", "npm")
$gitPath = Resolve-Application @("git.exe", "git")
$dockerPath = Resolve-Application @("docker.exe", "docker")
$corepackPath = Resolve-Application @("corepack.cmd", "corepack")
if ($CheckPrerequisites) {
  [ordered]@{
    node = $nodePath
    npm = $npmPath
    git = $gitPath
    docker = $dockerPath
    corepack = $corepackPath
  } | ConvertTo-Json
  exit 0
}

Write-Host "Agent Guard portable OpenClaw bootstrap" -ForegroundColor Cyan
Write-Host "Runtime: $RuntimeRoot"

$nodeVersion = [version]((& $nodePath -p "process.versions.node").Trim())
$nodeSupported =
  ($nodeVersion.Major -eq 22 -and $nodeVersion -ge [version]"22.22.3") -or
  ($nodeVersion.Major -eq 24 -and $nodeVersion -ge [version]"24.15.0") -or
  ($nodeVersion.Major -eq 25 -and $nodeVersion -ge [version]"25.9.0") -or
  ($nodeVersion.Major -gt 25)
if (-not $nodeSupported) {
  throw "Unsupported Node.js $nodeVersion. Use >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0."
}

Invoke-Checked $dockerPath @("version", "--format", "{{.Server.Version}}") "Docker daemon is unavailable"
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

if (-not $SkipAgentGuardDependencies) {
  Write-Host "[1/6] Installing Agent Guard dependencies..."
  Push-Location $repoRoot
  try {
    Invoke-Checked $npmPath @("ci", "--no-audit", "--no-fund") "Agent Guard dependency installation failed"
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[1/6] Agent Guard dependency installation skipped."
}

Write-Host "[2/6] Resolving exact OpenClaw fork..."
$forkGitDir = Join-Path $forkRoot ".git"
if (-not (Test-Path -LiteralPath $forkGitDir)) {
  if (Test-Path -LiteralPath $forkRoot) {
    $existing = @(Get-ChildItem -LiteralPath $forkRoot -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
      throw "Fork target exists but is not a Git checkout: $forkRoot"
    }
  }
  Invoke-Checked $gitPath @(
    "clone",
    "--filter=blob:none",
    "--single-branch",
    "--branch", $forkBranch,
    $forkRepository,
    $forkRoot
  ) "OpenClaw fork clone failed"
}

$forkHead = (& $gitPath -C $forkRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "OpenClaw fork HEAD could not be read." }
if ($forkHead -cne $forkCommit) {
  $dirty = [string]((& $gitPath -C $forkRoot status --porcelain) -join "`n")
  if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw "OpenClaw fork has local changes and cannot switch to the pinned commit: $forkRoot"
  }
  $remoteHeadLine = [string]((& $gitPath @("ls-remote", $forkRepository, "refs/heads/$forkBranch")) -join "")
  if ($LASTEXITCODE -ne 0 -or -not $remoteHeadLine.StartsWith("$forkCommit`t")) {
    throw "Published OpenClaw branch no longer resolves to the pinned commit."
  }
  Invoke-Checked $gitPath @(
    "-C", $forkRoot,
    "fetch", "--depth", "1",
    $forkRepository,
    $forkBranch
  ) "OpenClaw fork fetch failed"
  Invoke-Checked $gitPath @(
    "-C", $forkRoot,
    "checkout", "--detach", $forkCommit
  ) "OpenClaw fork checkout failed"
}
$forkHead = (& $gitPath -C $forkRoot rev-parse HEAD).Trim()
if ($forkHead -cne $forkCommit) {
  throw "OpenClaw fork HEAD mismatch: expected $forkCommit, got $forkHead"
}

$needsDependencies = -not (Test-Path -LiteralPath (Join-Path $forkRoot "node_modules"))
$buildHead = Get-BuildStampHead $forkRoot
$needsBuild =
  $buildHead -cne $forkCommit -or
  -not (Test-Path -LiteralPath $inspectorCli -PathType Leaf)
if ($SkipForkBuild -and $needsBuild) {
  throw "Pinned OpenClaw fork is not built; remove -SkipForkBuild."
}
if ($needsDependencies -or $needsBuild) {
  Write-Host "[3/6] Installing and building the OpenClaw fork..."
  Push-Location $forkRoot
  try {
    Invoke-Checked $corepackPath @("pnpm", "install", "--frozen-lockfile") "OpenClaw dependency installation failed"
    if ($needsBuild) {
      Invoke-Checked $nodePath @("scripts/build-all.mjs", "gatewayWatch") "OpenClaw fork build failed"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[3/6] Pinned OpenClaw build already available."
}
if ((Get-BuildStampHead $forkRoot) -cne $forkCommit) {
  throw "OpenClaw buildstamp does not match the pinned fork commit."
}

if (-not $SkipDockerPull) {
  Write-Host "[4/6] Pulling immutable sandbox image..."
  Invoke-Checked $dockerPath @("pull", $sandboxImage) "Sandbox image pull failed"
} else {
  Write-Host "[4/6] Sandbox image pull skipped."
}
$repoDigests = @(& $dockerPath @("image", "inspect", $sandboxImage, "--format", "{{range .RepoDigests}}{{println .}}{{end}}"))
if ($LASTEXITCODE -ne 0 -or $repoDigests -notcontains $sandboxImage) {
  throw "The exact GHCR sandbox digest is not available locally."
}

Write-Host "[5/6] Building and installing the Agent Guard plugin..."
Push-Location $repoRoot
try {
  Invoke-Checked $npmPath @("run", "build:openclaw-plugin") "Agent Guard plugin build failed"
} finally {
  Pop-Location
}
New-Item -ItemType Directory -Force -Path $profileRoot, $stateDir, $workspaceDir | Out-Null
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  Write-Utf8NoBom $configPath "{}`r`n"
}
$workspaceReadme = Join-Path $workspaceDir "README.md"
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $workspaceReadme -Force

$env:OPENCLAW_CLI = $openClawCli
$env:OPENCLAW_HOME = $profileRoot
$env:OPENCLAW_CONFIG_PATH = $configPath
$env:OPENCLAW_STATE_DIR = $stateDir
$env:OPENCLAW_WORKSPACE_DIR = $workspaceDir
$env:OPENCLAW_WORKSPACE = $workspaceDir
$env:TEST_OPENCLAW_AGENTGUARD_CLI = $inspectorCli
$env:AGENT_GUARD_OPENCLAW_ISOLATED_PROFILE = "1"
$env:AGENT_GUARD_DETECTION_IMAGE = $sandboxImage
$env:VITE_OPENCLAW_CLI_PATH = $openClawCli

Push-Location $repoRoot
try {
  & (Join-Path $PSScriptRoot "install-openclaw-native-guard.ps1") `
    -OpenClawCli $openClawCli `
    -OpenClawHome $profileRoot `
    -PluginSourceDir (Join-Path $repoRoot "plugins\agent-guard-supervision") `
    -Force
  if ($LASTEXITCODE -ne 0) { throw "Agent Guard plugin installation failed." }
} finally {
  Pop-Location
}

Write-Host "[6/6] Writing reusable environment and verifying artifacts..."
$environmentLines = @(
  "# Generated by bootstrap-agent-guard-openclaw.ps1. Contains no credentials.",
  "`$env:OPENCLAW_CLI = $(Quote-PowerShellLiteral $openClawCli)",
  "`$env:OPENCLAW_HOME = $(Quote-PowerShellLiteral $profileRoot)",
  "`$env:OPENCLAW_CONFIG_PATH = $(Quote-PowerShellLiteral $configPath)",
  "`$env:OPENCLAW_STATE_DIR = $(Quote-PowerShellLiteral $stateDir)",
  "`$env:OPENCLAW_WORKSPACE_DIR = $(Quote-PowerShellLiteral $workspaceDir)",
  "`$env:OPENCLAW_WORKSPACE = $(Quote-PowerShellLiteral $workspaceDir)",
  "`$env:TEST_OPENCLAW_AGENTGUARD_CLI = $(Quote-PowerShellLiteral $inspectorCli)",
  "`$env:AGENT_GUARD_OPENCLAW_ISOLATED_PROFILE = '1'",
  "`$env:AGENT_GUARD_DETECTION_IMAGE = $(Quote-PowerShellLiteral $sandboxImage)",
  "`$env:VITE_OPENCLAW_CLI_PATH = $(Quote-PowerShellLiteral $openClawCli)"
)
Write-Utf8NoBom $environmentFile (($environmentLines -join "`r`n") + "`r`n")

$versionOutput = [string]((& $nodePath $openClawCli --version 2>&1) -join "`n")
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch [regex]::Escape($forkVersion)) {
  throw "Pinned OpenClaw CLI version verification failed."
}
$inspectorOutput = [string]((& $nodePath $inspectorCli --version 2>&1) -join "`n")
if ($LASTEXITCODE -ne 0 -or $inspectorOutput -notmatch "agentguard") {
  throw "Pinned OpenClaw inspector verification failed."
}
$pluginOutput = [string]((& $nodePath $openClawCli plugins list --json 2>&1) -join "`n")
if ($LASTEXITCODE -ne 0 -or $pluginOutput -notmatch "agent-guard-supervision") {
  throw "Agent Guard plugin inventory verification failed."
}

Write-Host ""
Write-Host "Bootstrap complete." -ForegroundColor Green
Write-Host "Environment: $environmentFile"
Write-Host "Configure a model once if needed:"
Write-Host "  . '$environmentFile'"
Write-Host "  node `$env:OPENCLAW_CLI configure"
Write-Host "Start the system:"
Write-Host "  .\scripts\start-agent-guard-openclaw.ps1 -RuntimeRoot '$RuntimeRoot'"
