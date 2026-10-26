# Builds Fleet's installer, dist\fleet-windows-x64-setup.exe, from dist\fleet-windows-x64.exe (npm run
# build) and the Windows Terminal release pinned in terminal.json, downloaded and checked first.
# Needs Inno Setup 6 (iscc). The Release workflow runs it; on your machine, from apps\fleet:
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1 [-Version 1.2.3]
param([string]$Version = '0.0.0')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$pin = Get-Content (Join-Path $PSScriptRoot 'terminal.json') -Raw | ConvertFrom-Json
$work = Join-Path $PSScriptRoot 'work'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory $work | Out-Null
try {
  $zip = Join-Path $work 'terminal.zip'
  $url = "https://github.com/microsoft/terminal/releases/download/v$($pin.version)/Microsoft.WindowsTerminal_$($pin.version)_x64.zip"
  Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $pin.sha256) {
    throw "Windows Terminal $($pin.version) doesn't match its checksum in terminal.json."
  }
  Expand-Archive $zip (Join-Path $work 'unpacked')
  $terminal = (Get-ChildItem (Join-Path $work 'unpacked') -Directory | Select-Object -First 1).FullName
  # Portable mode: its settings live in settings\ beside it, apart from an installed Windows Terminal's.
  New-Item -ItemType File (Join-Path $terminal '.portable') -Force | Out-Null

  $iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
  if (-not $iscc) { $iscc = (Resolve-Path "${env:ProgramFiles(x86)}\Inno Setup *\ISCC.exe" | Select-Object -Last 1).Path }
  & $iscc /Q "/DVersion=$Version" "/DTerminal=$terminal" (Join-Path $PSScriptRoot 'Fleet.iss')
  if ($LASTEXITCODE) { throw "iscc failed ($LASTEXITCODE)" }
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
