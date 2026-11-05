# Installs Pilot on Windows without the setup program: the newest release, checked against the
# release's SHA256SUMS.txt, into %LOCALAPPDATA%\Programs\Pilot (where the setup puts it), added to your
# PATH. The repository is private, so it downloads through gh signed in (gh auth login), or with a
# token in GITHUB_TOKEN (or GH_TOKEN) that can read it. Run it again to update, or use `pilot update`.
#   powershell -ExecutionPolicy Bypass -File pilot-install.ps1 [-Version 0.1.2]
param([string]$Version = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'FranciscoNunes-dxspark/fleet'
$Dir = if ($env:PILOT_INSTALL_DIR) { $env:PILOT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Pilot' }
$File = 'pilot-windows-x64.exe'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Pilot is built for 64-bit Windows.' }

$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
$gh = $null
if ($env:PILOT_INSTALL_VIA -ne 'token') {
  $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
  if ($gh) { & $gh auth token *> $null; if ($LASTEXITCODE) { $gh = $null } }
}
if (-not $gh -and -not $token) { throw "The repository is private: sign in with gh (gh auth login) or set GITHUB_TOKEN to a token that can read $Repo." }

function Api([string]$path) {
  if ($gh) { return (& $gh api "repos/$Repo/$path" | Out-String | ConvertFrom-Json) }
  return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/$path" -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'pilot-install' }
}
function Download($asset, [string]$to) {
  if ($gh) {
    # Not gh api: PowerShell's > would re-encode the binary as text. gh writes the file itself.
    & $gh release download $script:tag --repo $Repo --pattern $asset.name --dir (Split-Path $to) --clobber
    if ($LASTEXITCODE) { throw "gh couldn't download $($asset.name)" }
  } else {
    Invoke-WebRequest -Uri $asset.url -OutFile $to -UseBasicParsing -Headers @{ Authorization = "Bearer $token"; Accept = 'application/octet-stream'; 'User-Agent' = 'pilot-install' }
  }
}

# The release: the version asked for, else the newest pilot-v… that isn't a draft or a pre-release.
if ($Version) {
  $script:tag = "pilot-v$($Version.TrimStart('v'))"
} else {
  $script:tag = (Api 'releases?per_page=100' | Where-Object { $_.tag_name -like 'pilot-v*' -and -not $_.draft -and -not $_.prerelease } |
    Sort-Object { [version]($_.tag_name -replace '^pilot-v', '') } -Descending | Select-Object -First 1).tag_name
  if (-not $script:tag) { throw "No Pilot release found in $Repo." }
}
$release = Api "releases/tags/$script:tag"
$exeAsset = $release.assets | Where-Object name -eq $File
$sumAsset = $release.assets | Where-Object name -eq 'SHA256SUMS.txt'
if (-not $exeAsset -or -not $sumAsset) { throw "$script:tag has no $File or SHA256SUMS.txt." }

$work = Join-Path ([IO.Path]::GetTempPath()) ("pilot-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
  Write-Host "Downloading $File from $script:tag…"
  Download $exeAsset (Join-Path $work $File)
  Download $sumAsset (Join-Path $work 'SHA256SUMS.txt')
  $line = Get-Content (Join-Path $work 'SHA256SUMS.txt') | Where-Object { $_ -match "^([0-9a-f]{64}) [ *]$([regex]::Escape($File))$" } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS.txt has no checksum for $File." }
  $want = ($line -split ' ')[0]
  $got = (Get-FileHash (Join-Path $work $File) -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { throw "The download doesn't match its checksum: not installed." }

  New-Item -ItemType Directory $Dir -Force | Out-Null
  $exe = Join-Path $Dir 'pilot.exe'
  # Windows won't overwrite a running program but will rename it: a Pilot running now keeps going.
  if (Test-Path $exe) { Move-Item $exe "$exe.old.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Force }
  Move-Item (Join-Path $work $File) $exe -Force
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# On the user's PATH, once.
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($path -split ';') -contains $Dir)) {
  [Environment]::SetEnvironmentVariable('Path', (($path.TrimEnd(';'), $Dir) -join ';').TrimStart(';'), 'User')
  Write-Host "Added $Dir to your PATH: open a new terminal to use pilot."
}
Write-Host "Installed $(& $exe --version) in $exe."
Write-Host ''
Write-Host 'Next, in a project''s folder:'
Write-Host '  pilot app                 Pilot''s window: recent projects, Open a folder'
Write-Host '  pilot ui                  the UI in your browser'
Write-Host '  pilot init --mcp          connect Claude Code (the skill and the MCP server)'
