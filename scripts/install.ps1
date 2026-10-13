<#
.SYNOPSIS
Installs Wazir from source on Windows natively.

.DESCRIPTION
Native PowerShell installer for Wazir. Validates Node.js >= 22.5 and Git,
installs dependencies via npm ci, builds all workspaces, configures Wazir
environment files, and installs the `wa` CLI launchers (`wa.cmd` and `wa.ps1`)
into $env:USERPROFILE\.wazir\bin (or $env:WAZIR_BIN_DIR if defined), safely
configuring the Windows User PATH.

Requirements:
- Windows 10/11 or Windows Server (no WSL2 required)
- PowerShell 5.1 or PowerShell Core 7+
- Node.js >= 22.5.0 (https://nodejs.org or 'winget install OpenJS.NodeJS.LTS')
- Git for Windows (https://git-scm.com or 'winget install Git.Git')

Usage:
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1

Uninstall instructions:
  1. Remove launcher directory from User PATH:
     $p = [Environment]::GetEnvironmentVariable('Path', 'User')
     $bin = if ($env:WAZIR_BIN_DIR) { $env:WAZIR_BIN_DIR } else { "$env:USERPROFILE\.wazir\bin" }
     $newP = ($p.Split(';') | Where-Object { $_.TrimEnd('\') -ine $bin.TrimEnd('\') }) -join ';'
     [Environment]::SetEnvironmentVariable('Path', $newP, 'User')
  2. Remove the launcher directory:
     Remove-Item -Recurse -Force "$env:USERPROFILE\.wazir\bin"
  3. (Optional) Remove Wazir state and configuration:
     Remove-Item -Recurse -Force "$env:USERPROFILE\.wazir"
#>

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# 1. Locate repository root
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackageJson = Join-Path $RepoRoot "package.json"
$CliPackageJson = Join-Path $RepoRoot "apps\cli\package.json"

if (-not (Test-Path $PackageJson) -or -not (Test-Path $CliPackageJson)) {
    Write-Error "Could not find Wazir repository at $RepoRoot.`nPlease run this script from a Wazir checkout: powershell -File scripts\install.ps1"
    exit 1
}

Write-Host "==> Wazir repository root: $RepoRoot"

# 2. Validate Node.js >= 22.5
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error @"
Node.js is not installed or not found on PATH.
Wazir requires Node.js >= 22.5 with built-in SQLite support.
Please install Node.js >= 22.5 from:
  https://nodejs.org
or via winget:
  winget install OpenJS.NodeJS.LTS
"@
    exit 1
}

$NodeBin = $nodeCmd.Source
try {
    $versionOutput = & $NodeBin -v
} catch {
    Write-Error "Failed to execute Node.js binary at $NodeBin"
    exit 1
}

# 22.5 is the first release with the built-in node:sqlite used by @wazir/memory.
$verCheckScript = 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'
& $NodeBin -e $verCheckScript
if ($LASTEXITCODE -ne 0) {
    Write-Error @"
Node.js >= 22.5 is required, found $versionOutput at:
  $NodeBin
Please upgrade Node.js from https://nodejs.org or via winget:
  winget install OpenJS.NodeJS.LTS
"@
    exit 1
}
Write-Host "==> Using Node $versionOutput at $NodeBin"

# 3. Validate Git
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Error @"
Git is not installed or not found on PATH.
Wazir requires Git for workspace tracking and versioning.
Please install Git for Windows from:
  https://git-scm.com
or via winget:
  winget install Git.Git
"@
    exit 1
}

# 4. Resolve npm executable
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npmCmd) {
    Write-Error "npm is not installed or not found on PATH. Ensure your Node.js installation includes npm."
    exit 1
}
$NpmBin = $npmCmd.Source

# 5. Install dependencies and build workspaces
$shouldSkipBuild = $SkipBuild -or ($env:WAZIR_SKIP_BUILD -eq "1")

if ($shouldSkipBuild) {
    Write-Host "==> WAZIR_SKIP_BUILD=1: skipping npm ci and build"
} else {
    Write-Host "==> Installing dependencies via npm ci"
    Push-Location $RepoRoot
    try {
        & $NpmBin ci
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm ci failed with exit code $LASTEXITCODE. Check network and npm configuration, then re-run."
            exit 1
        }

        Write-Host "==> Building all workspaces"
        & $NpmBin run build
        if ($LASTEXITCODE -ne 0) {
            Write-Error @"
BUILD FAILED with exit code $LASTEXITCODE.
Refusing to install an outdated or broken build. Fix the compilation errors above and re-run.
"@
            exit 1
        }
    } finally {
        Pop-Location
    }
}

# 6. Verify CLI bundle output
$CliEntry = Join-Path $RepoRoot "bin\wa.js"
if (-not (Test-Path $CliEntry)) {
    $AltEntry = Join-Path $RepoRoot "apps\cli\dist\index.js"
    if (Test-Path $AltEntry) {
        $CliEntry = $AltEntry
    } else {
        Write-Error "No CLI build found at $CliEntry or $AltEntry. Build may have failed."
        exit 1
    }
}

# 7. Configure environment files & security tokens
Write-Host "==> Configuring Wazir environment and configuration files"
$setupEnvScript = Join-Path $RepoRoot "scripts\setup-env.mjs"
& $NodeBin $setupEnvScript
if ($LASTEXITCODE -ne 0) {
    Write-Warning "setup-env.mjs reported non-zero status ($LASTEXITCODE), continuing with launcher installation."
}

# 8. Determine launcher bin directory
$BinDir = if ($env:WAZIR_BIN_DIR) {
    $env:WAZIR_BIN_DIR
} else {
    Join-Path $env:USERPROFILE ".wazir\bin"
}

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Write-Host "✓ Created launcher directory: $BinDir"
}

# 9. Install wa.cmd (Batch launcher for Command Prompt and generic shells)
$WaCmdPath = Join-Path $BinDir "wa.cmd"
$WaCmdContent = @"
@echo off
setlocal enabledelayedexpansion

set "NODE_BIN=$NodeBin"
set "CLI=$CliEntry"

if not exist "!NODE_BIN!" (
  for %%X in (node.exe) do (set "NODE_BIN=%%~`$PATH:X")
)
if "!NODE_BIN!"=="" set "NODE_BIN=node"

if not exist "!CLI!" (
  echo wa: Wazir build missing at "!CLI!". Re-run: powershell -File "$PSScriptRoot\install.ps1" >&2
  exit /b 127
)

rem Source Wazir environment if present
if defined WAZIR_HOME (
  set "ENV_FILE=%WAZIR_HOME%\.env"
) else (
  set "ENV_FILE=%USERPROFILE%\.wazir\.env"
)

if exist "!ENV_FILE!" (
  for /f "usebackq tokens=1,* delims==" %%A in ("!ENV_FILE!") do (
    set "line=%%A"
    if not "!line:~0,1!"=="#" if not "%%B"=="" set "%%A=%%B"
  )
)

"!NODE_BIN!" "!CLI!" %*
exit /b %ERRORLEVEL%
"@

[System.IO.File]::WriteAllText($WaCmdPath, $WaCmdContent, [System.Text.Encoding]::ASCII)
Write-Host "✓ Created Command Prompt launcher: $WaCmdPath"

# 10. Install wa.ps1 (PowerShell launcher)
$WaPs1Path = Join-Path $BinDir "wa.ps1"
$WaPs1Content = @"
# Wazir CLI launcher for PowerShell — generated by scripts/install.ps1
`$ErrorActionPreference = 'Stop'

`$NodeBin = '$NodeBin'
`$CliEntry = '$CliEntry'

if (-not (Test-Path `$NodeBin)) {
    `$cmd = Get-Command node -ErrorAction SilentlyContinue
    if (`$cmd) { `$NodeBin = `$cmd.Source }
}

if (-not `$NodeBin -or -not (Test-Path `$NodeBin)) {
    Write-Error "wa: Node.js executable not found. Expected: `$NodeBin"
    exit 127
}

if (-not (Test-Path `$CliEntry)) {
    Write-Error "wa: Wazir build missing at `$CliEntry. Re-run: powershell -File '$PSScriptRoot\install.ps1'"
    exit 127
}

`$WazirHome = if (`$env:WAZIR_HOME) { `$env:WAZIR_HOME } else { Join-Path `$env:USERPROFILE ".wazir" }
`$EnvFile = Join-Path `$WazirHome ".env"

if (Test-Path `$EnvFile) {
    Get-Content `$EnvFile | ForEach-Object {
        `$line = `$_.Trim()
        if (`$line -and -not `$line.StartsWith('#') -and `$line.Contains('=')) {
            `$parts = `$line.Split('=', 2)
            `$varName = `$parts[0].Trim()
            `$varVal = `$parts[1].Trim()
            if (`$varName) {
                [Environment]::SetEnvironmentVariable(`$varName, `$varVal, 'Process')
            }
        }
    }
}

& `$NodeBin `$CliEntry @args
exit `$LASTEXITCODE
"@

[System.IO.File]::WriteAllText($WaPs1Path, $WaPs1Content, [System.Text.Encoding]::UTF8)
Write-Host "✓ Created PowerShell launcher: $WaPs1Path"

# 11. Safe user PATH configuration (Registry User PATH only, never weakens Machine PATH)
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$CleanBinDir = $BinDir.TrimEnd('\')
$Paths = if ($UserPath) {
    $UserPath.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() }
} else {
    @()
}

$AlreadyPresent = $false
foreach ($p in $Paths) {
    if ($p.TrimEnd('\') -ieq $CleanBinDir) {
        $AlreadyPresent = $true
        break
    }
}

if (-not $AlreadyPresent) {
    $NewUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) {
        $CleanBinDir
    } else {
        "$UserPath;$CleanBinDir"
    }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
    Write-Host "✓ Added $BinDir to User PATH environment variable."
} else {
    Write-Host "✓ $BinDir is already present in User PATH."
}

# Update current session PATH so wa is immediately runnable
$SessionPaths = $env:Path.Split(';') | ForEach-Object { $_.TrimEnd('\') }
if ($SessionPaths -notcontains $CleanBinDir) {
    $env:Path = "$CleanBinDir;$env:Path"
}

Write-Host @"

Done. Wazir installed successfully!

To verify installation, open a new Command Prompt or PowerShell and run:
  wa --help
  wa doctor
  wa status
  wa agents list
  wa models list
  wa resources
"@

exit 0
