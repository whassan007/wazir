# ==============================================================================
# Wazir Native Windows Installer (scripts/install.ps1)
# ==============================================================================
# Installs Wazir from source on Windows (no WSL2 required).
# Validates environment, installs dependencies via npm ci, builds packages,
# installs native 'wa' launchers (wa.cmd, wa.ps1, wa), configures User PATH,
# and runs `wa doctor`.
# ==============================================================================

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$BinDir,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Host @"
Usage: .\scripts\install.ps1 [options]

Options:
  -SkipBuild    Skip 'npm ci' and 'npm run build' steps
  -BinDir <dir> Custom directory to install launcher (default: %LOCALAPPDATA%\Programs\Wazir\bin)
  -Help         Show this help message
"@
    exit 0
}

Write-Host "==> Wazir Native Windows Installer" -ForegroundColor Cyan

# 1. Detect Windows version and architecture
$osVer = [System.Environment]::OSVersion
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
Write-Host "==> OS: Windows ($arch), Version: $($osVer.VersionString)"

# 2. Locate Repository Root
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path (Join-Path $RepoRoot "package.json")) -or -not (Test-Path (Join-Path $RepoRoot "apps\cli\package.json"))) {
    Write-Error "Could not find Wazir repository at $RepoRoot. Please run this script from inside a Wazir checkout."
    exit 1
}
Set-Location $RepoRoot
Write-Host "==> Repository Root: $RepoRoot"

# 3. Validate Git
Write-Host "==> Validating Git..."
$gitCmd = Get-Command "git" -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Error "Git is not installed or not found on PATH. Please install Git for Windows: https://git-scm.com/download/win"
    exit 1
}
$gitVersion = (& git --version)
Write-Host "✓ Found $gitVersion" -ForegroundColor Green

# 4. Validate Node.js (>= 22.5.0 required for node:sqlite DatabaseSync)
Write-Host "==> Validating Node.js..."
$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "Node.js is not installed or not found on PATH. Wazir requires Node.js >= 22.5.0: https://nodejs.org/"
    exit 1
}
$nodeBin = $nodeCmd.Source

$nodeVersionCheck = & "$nodeBin" -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 5) ? 0 : 1)"
if ($LASTEXITCODE -ne 0) {
    $currentVer = & "$nodeBin" -v
    Write-Error "Node.js >= 22.5.0 required, but found $currentVer at $nodeBin. Please install Node.js 22.5+ from https://nodejs.org/"
    exit 1
}
$nodeVersionStr = & "$nodeBin" -v
Write-Host "✓ Using Node.js $nodeVersionStr at $nodeBin" -ForegroundColor Green

# 5. Validate npm
$npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    $npmCmd = Get-Command "npm" -ErrorAction SilentlyContinue
}
if (-not $npmCmd) {
    Write-Error "npm is not installed or not found on PATH."
    exit 1
}
$npmBin = $npmCmd.Source

# 6. Install dependencies and build Wazir
$cliEntry = Join-Path $RepoRoot "bin\wa.js"

if ($SkipBuild) {
    Write-Host "==> -SkipBuild specified: skipping npm ci and build" -ForegroundColor Yellow
} else {
    Write-Host "==> Installing dependencies using npm ci..."
    & "$npmBin" ci
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm ci failed. Check your network and Node.js setup, then re-run."
        exit 1
    }
    Write-Host "✓ Dependencies installed" -ForegroundColor Green

    Write-Host "==> Building all workspaces..."
    & "$npmBin" run build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed! Stale artifacts will NOT be installed. Fix build errors and retry."
        exit 1
    }
    Write-Host "✓ Build succeeded" -ForegroundColor Green
}

if (-not (Test-Path $cliEntry)) {
    Write-Error "No CLI bundle found at $cliEntry. Build may have failed."
    exit 1
}

# 7. Configure environment files (~/.wazir/.env and config.json)
Write-Host "==> Configuring environment files..."
& "$nodeBin" (Join-Path $RepoRoot "scripts\setup-env.mjs")
if ($LASTEXITCODE -ne 0) {
    Write-Warning "setup-env.mjs exited with non-zero code."
}

# 8. Determine Installation Directory
if (-not $BinDir) {
    if ($env:WAZIR_BIN_DIR) {
        $BinDir = $env:WAZIR_BIN_DIR
    } else {
        $localAppData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
        if ($localAppData) {
            $BinDir = Join-Path $localAppData "Programs\Wazir\bin"
        } else {
            $BinDir = Join-Path $env:USERPROFILE ".local\bin"
        }
    }
}

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}
Write-Host "==> Installing launcher to $BinDir"

# 9. Create native wa.cmd launcher
$waCmdPath = Join-Path $BinDir "wa.cmd"
$waCmdContent = @"
@echo off
setlocal
set "NODE_BIN=$nodeBin"
if not exist "%NODE_BIN%" set "NODE_BIN=node"
set "CLI_ENTRY=$cliEntry"
if not exist "%CLI_ENTRY%" (
  echo wa: CLI bundle missing at %CLI_ENTRY%. Re-run .\scripts\install.ps1 1>&2
  exit /b 127
)
set "ENV_FILE=%USERPROFILE%\.wazir\.env"
if exist "%ENV_FILE%" (
  for /f "usebackq tokens=*" %%i in ("%ENV_FILE%") do (
    set "%%i" 2>nul
  )
)
"%NODE_BIN%" "%CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
"@
Set-Content -Path $waCmdPath -Value $waCmdContent -Encoding ASCII
Write-Host "✓ Created $waCmdPath" -ForegroundColor Green

# 10. Create native wa.ps1 launcher (for PowerShell users with scripts execution enabled)
$waPs1Path = Join-Path $BinDir "wa.ps1"
$waPs1Content = @"
`$ErrorActionPreference = 'Stop'
`$node = '$nodeBin'
if (-not (Test-Path `$node)) { `$node = 'node' }
`$cli = '$cliEntry'
if (-not (Test-Path `$cli)) {
    Write-Error "wa: CLI bundle missing at `$cli. Re-run .\scripts\install.ps1"
    exit 127
}
`$envFile = Join-Path `$env:USERPROFILE ".wazir\.env"
if (Test-Path `$envFile) {
    Get-Content `$envFile | ForEach-Object {
        `$line = `$_.Trim()
        if (`$line -and -not `$line.StartsWith('#') -and `$line.Contains('=')) {
            `$parts = `$line.Split('=', 2)
            [System.Environment]::SetEnvironmentVariable(`$parts[0].Trim(), `$parts[1].Trim(), 'Process')
        }
    }
}
& `$node `$cli `$args
exit `$LASTEXITCODE
"@
Set-Content -Path $waPs1Path -Value $waPs1Content -Encoding UTF8
Write-Host "✓ Created $waPs1Path" -ForegroundColor Green

# 11. Create wa bash shim (for Git Bash / MSYS2 / MinGW users on Windows)
$waBashPath = Join-Path $BinDir "wa"
$waBashContent = @"
#!/usr/bin/env bash
NODE_BIN="$nodeBin"
CLI="$cliEntry"
if [ ! -f "`$CLI" ]; then
  echo "wa: CLI bundle missing at `$CLI. Re-run .\scripts\install.ps1" >&2
  exit 127
fi
ENV_FILE="`$USERPROFILE/.wazir/.env"
if [ -f "`$ENV_FILE" ]; then
  set -a
  source "`$ENV_FILE" 2>/dev/null || true
  set +a
fi
exec "`$NODE_BIN" "`$CLI" "`$@"
"@
Set-Content -Path $waBashPath -Value $waBashContent -Encoding ASCII
Write-Host "✓ Created $waBashPath" -ForegroundColor Green

# 12. Safely configure User PATH (without touching Machine PATH or requiring admin)
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
$pathParts = if ($userPath) { $userPath.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries) } else { @() }
$normalizedBinDir = (Resolve-Path $BinDir).Path

$foundInPath = $false
foreach ($part in $pathParts) {
    if ($part.Trim().TrimEnd('\') -eq $normalizedBinDir.TrimEnd('\')) {
        $foundInPath = $true
        break
    }
}

if (-not $foundInPath) {
    $newUserPath = ($pathParts + $normalizedBinDir) -join ';'
    [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Host "✓ Added $normalizedBinDir to User PATH." -ForegroundColor Green
    Write-Host "  Note: Restart your terminal session for User PATH updates to take effect in new windows." -ForegroundColor Yellow
} else {
    Write-Host "✓ $normalizedBinDir is already in User PATH." -ForegroundColor Green
}

# Update current PowerShell process PATH so wa runs immediately
$env:PATH = "$normalizedBinDir;$env:PATH"

# 13. Run `wa doctor`
Write-Host "`n==> Running 'wa doctor' to verify installation..." -ForegroundColor Cyan
& "$waCmdPath" doctor
$doctorStatus = $LASTEXITCODE

Write-Host @"

==============================================================================
✓ Wazir installed successfully!
==============================================================================

Launcher directory: $BinDir
Command: wa

Next steps:
  wa doctor
  wa models list
  wa ask "explain what this repository does"

To upgrade Wazir:
  git pull
  .\scripts\install.ps1

To uninstall Wazir:
  1. Remove '$BinDir' from your User PATH environment variable.
  2. Remove '$BinDir'.
  3. (Optional) Remove '%USERPROFILE%\.wazir' to delete all local history and settings.
==============================================================================
"@ -ForegroundColor Green

if ($doctorStatus -ne 0) {
    exit 0 # Installation itself succeeded even if some optional doctor runtimes are offline
}
exit 0
