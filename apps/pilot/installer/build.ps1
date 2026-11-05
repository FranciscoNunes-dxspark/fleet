# Builds Pilot's installer, dist\pilot-windows-x64-setup.exe, from dist\pilot-windows-x64.exe (npm run
# build). Needs Inno Setup 6 (iscc). The Release workflow runs it; on your machine, from apps\pilot:
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1 [-Version 1.2.3]
param([string]$Version = '0.0.0')
$ErrorActionPreference = 'Stop'

$exe = Join-Path $PSScriptRoot '..\dist\pilot-windows-x64.exe'
if (-not (Test-Path $exe)) { throw "No $exe: run npm run build first." }
$iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $iscc) { $iscc = (Resolve-Path "${env:ProgramFiles(x86)}\Inno Setup *\ISCC.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1).Path }
if (-not $iscc) { throw 'Inno Setup 6 is needed: choco install innosetup, or https://jrsoftware.org/isdl.php' }
& $iscc /Q "/DVersion=$Version" (Join-Path $PSScriptRoot 'Pilot.iss')
if ($LASTEXITCODE) { throw "iscc failed ($LASTEXITCODE)" }
