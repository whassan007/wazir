<#
.SYNOPSIS
  Installs, upgrades or uninstalls the Wazir CLI (wa.exe) on Windows. No WSL, no Node.js needed.

.DESCRIPTION
  Downloads wazir-<version>-windows-<arch>.zip from the GitHub release, verifies its SHA-256
  against the release's SHA256SUMS, checks that the extracted wa.exe reports the requested
  version, and only then makes it the active `wa`. Installs per user under
  %LOCALAPPDATA%\Programs\Wazir (no administrator rights) and adds its bin directory to the
  *user* PATH once. Never changes the execution policy. Uninstall removes the program and the
  PATH entry but keeps your data in %USERPROFILE%\.wazir.

.EXAMPLE
  # Latest release (run in PowerShell; -ExecutionPolicy applies to this one process only):
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
.EXAMPLE
  ./install.ps1 -Version 0.1.60
.EXAMPLE
  ./install.ps1 -Uninstall
.EXAMPLE
  # Offline / CI: install a local archive, verified against a local SHA256SUMS
  ./install.ps1 -ZipPath .\wazir-0.1.60-windows-x64.zip -ChecksumsPath .\SHA256SUMS
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Wazir'),
  [string]$ZipPath,
  [string]$ChecksumsPath,
  [string]$Repository = 'whassan007/wazir',
  [switch]$Uninstall,
  [switch]$NoPathUpdate
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$BinDir = Join-Path $InstallDir 'bin'
$VersionsDir = Join-Path $InstallDir 'versions'

function Write-Step([string]$Message) { Write-Host "==> $Message" }

function Get-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
function Set-UserPath([string]$Value) { [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }
function Split-PathList([string]$Value) { if ($Value) { $Value.Split(';') | Where-Object { $_ -ne '' } } else { @() } }
function Test-SamePath([string]$A, [string]$B) { $A.TrimEnd('\').Equals($B.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }

function Add-ToUserPath([string]$Dir) {
  $entries = @(Split-PathList (Get-UserPath))
  if ($entries | Where-Object { Test-SamePath $_ $Dir }) { return $false }
  Set-UserPath ((@($entries) + $Dir) -join ';')
  return $true
}

function Remove-FromUserPath([string]$Dir) {
  $entries = @(Split-PathList (Get-UserPath))
  $kept = @($entries | Where-Object { -not (Test-SamePath $_ $Dir) })
  if ($kept.Count -ne $entries.Count) { Set-UserPath ($kept -join ';'); return $true }
  return $false
}

if ($Uninstall) {
  if (Test-Path $InstallDir) {
    Write-Step "Removing $InstallDir"
    Remove-Item -Recurse -Force $InstallDir
  } else {
    Write-Step "Wazir is not installed in $InstallDir"
  }
  if (Remove-FromUserPath $BinDir) { Write-Step "Removed $BinDir from the user PATH" }
  Write-Host "Your data in $(Join-Path $env:USERPROFILE '.wazir') was kept."
  exit 0
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" } }

$work = Join-Path ([IO.Path]::GetTempPath()) ("wazir-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  if (-not $ZipPath) {
    if (-not $Version) {
      Write-Step "Resolving the latest release of $Repository"
      $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers @{ 'User-Agent' = 'wazir-install' }
      $Version = $latest.tag_name.TrimStart('v')
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') { throw "Invalid version '$Version'" }
    $asset = "wazir-$Version-windows-$arch.zip"
    $base = "https://github.com/$Repository/releases/download/v$Version"
    $ZipPath = Join-Path $work $asset
    $ChecksumsPath = Join-Path $work 'SHA256SUMS'
    Write-Step "Downloading $asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $ZipPath
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $ChecksumsPath
  }
  $asset = Split-Path -Leaf $ZipPath
  if (-not $Version) {
    if ($asset -match '^wazir-(.+)-windows-(x64|arm64)\.zip$') { $Version = $Matches[1] } else { throw "Cannot infer the version from '$asset'; pass -Version" }
  }

  # Integrity: the archive must match the release's checksum list exactly.
  if (-not $ChecksumsPath -or -not (Test-Path $ChecksumsPath)) { throw 'SHA256SUMS is required to verify the download' }
  $expected = $null
  foreach ($line in Get-Content $ChecksumsPath) {
    $parts = $line -split '\s+\*?', 2
    if ($parts.Count -eq 2 -and $parts[1].Trim() -eq $asset) { $expected = $parts[0].Trim().ToLowerInvariant() }
  }
  if (-not $expected) { throw "$asset is not listed in SHA256SUMS" }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $ZipPath).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Checksum mismatch for ${asset}: expected $expected, got $actual" }
  Write-Step "Verified SHA-256 $actual"

  # Stage, then prove the binary is the requested version before activating it.
  $staged = Join-Path $VersionsDir $Version
  if (Test-Path $staged) { Remove-Item -Recurse -Force $staged }
  New-Item -ItemType Directory -Path $staged -Force | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $staged -Force
  $exe = Join-Path $staged 'wa.exe'
  if (-not (Test-Path $exe)) { throw "wa.exe missing from $asset" }
  $reported = (& $exe --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $reported -ne $Version) { throw "Staged wa.exe reports '$reported', expected '$Version'" }

  # Activate: replace bin\wa.exe (a running old copy is renamed aside, then removed).
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $target = Join-Path $BinDir 'wa.exe'
  if (Test-Path $target) {
    $aside = "$target.old-" + [Guid]::NewGuid().ToString('N')
    Move-Item -Force $target $aside
    Remove-Item -Force $aside -ErrorAction SilentlyContinue
  }
  Copy-Item -Force $exe $target
  Set-Content -Path (Join-Path $InstallDir 'VERSION') -Value $Version -Encoding ascii

  # No stale versions: keep only the one just activated.
  Get-ChildItem -Directory $VersionsDir | Where-Object { $_.Name -ne $Version } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -Path $BinDir -Filter 'wa.exe.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  if (-not $NoPathUpdate -and (Add-ToUserPath $BinDir)) {
    Write-Step "Added $BinDir to your user PATH (open a new terminal to use it)"
  }
  $final = (& $target --version).Trim()
  Write-Host "Wazir $final installed at $target"
  Write-Host "Next: wa doctor"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
