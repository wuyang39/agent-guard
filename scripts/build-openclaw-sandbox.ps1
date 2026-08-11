param(
  [string]$Tag = "openclaw-sandbox:bookworm-slim"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$contextDir = Join-Path $repoRoot "docker\openclaw-sandbox"
$dockerfile = Join-Path $contextDir "Dockerfile"

if (-not (Test-Path -LiteralPath $dockerfile -PathType Leaf)) {
  throw "OpenClaw sandbox Dockerfile is missing."
}

& docker version --format "{{.Server.Version}}" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Docker daemon is unavailable."
}

& docker build --pull=false --tag $Tag --file $dockerfile $contextDir
if ($LASTEXITCODE -ne 0) {
  throw "OpenClaw sandbox image build failed."
}

$image = (& docker image inspect $Tag --format "{{json .}}" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or -not $image.Id -or $image.Id -notmatch '^sha256:[0-9a-f]{64}$') {
  throw "Built sandbox image has no immutable image ID."
}

$lastSlash = $Tag.LastIndexOf('/')
$lastColon = $Tag.LastIndexOf(':')
$repository = if ($lastColon -gt $lastSlash) { $Tag.Substring(0, $lastColon) } else { $Tag }
$digestRef = @($image.RepoDigests) |
  Where-Object { $_ -is [string] -and $_.StartsWith("$repository@sha256:") } |
  Select-Object -First 1

if (-not $digestRef) {
  throw "Docker did not expose a local repository digest. Enable the containerd image store, or push and pull the image through a registry before acceptance."
}

Write-Output "AGENT_GUARD_DETECTION_IMAGE=$digestRef"
