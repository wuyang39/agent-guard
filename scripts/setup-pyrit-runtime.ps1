param(
  [string]$VenvPath = ".venv\pyrit"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvFullPath = Join-Path $ProjectRoot $VenvPath
$PythonExe = Join-Path $VenvFullPath "Scripts\python.exe"
$VendorPath = Join-Path $ProjectRoot "third_party\pyrit_adapted"

if (-not (Test-Path $PythonExe)) {
  python -m venv $VenvFullPath
}

& $PythonExe -m pip install --upgrade pip setuptools wheel
& $PythonExe -m pip install -e $VendorPath

Write-Host "PyRIT runtime installed in $VenvFullPath"
