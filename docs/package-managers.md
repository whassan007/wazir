# Wazir Package Manager Distribution Guide

Wazir provides native packaging and distribution across macOS, Linux, and Windows through official and community package managers.

This document details installation, upgrade, uninstallation, and submission workflows for **Homebrew**, **WinGet**, and **Scoop**, as well as the underlying architecture that guarantees non-destructive persistence of user state across versions.

---

## 1. Package Manager Matrix

| Package Manager | Target Platforms | Supported Architectures | Package Identifier / Tap | Upstream Repository |
| :--- | :--- | :--- | :--- | :--- |
| **npm** | macOS, Linux, Windows | x64, ARM64 | `wazir` / `@whassan007/wazir` | [npm Registry](https://www.npmjs.com) |
| **Homebrew** | macOS, Linux | Apple Silicon (ARM64), Intel (x64) | `whassan007/tap/wazir` | [whassan007/homebrew-tap](https://github.com/whassan007/homebrew-tap) |
| **WinGet** | Windows 10/11 | x64, ARM64 | `Whassan.Wazir` | [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) |
| **Scoop** | Windows 10/11 | x64, ARM64 | `wazir` | [whassan007/scoop-bucket](https://github.com/whassan007/wazir) |

---

## 2. Homebrew (macOS & Linux)

### Installation

To install via the official Wazir tap:

```bash
# Add the tap
brew tap whassan007/tap

# Install Wazir
brew install wazir
```

Or install directly in a single command:

```bash
brew install whassan007/tap/wazir
```

### Upgrading

```bash
brew update
brew upgrade wazir
```

Homebrew replaces the symlinked binary in `/usr/local/bin` or `/opt/homebrew/bin`. Your local database (`~/.wazir/resources.db`), configuration files (`~/.wazir/config.json`), and credentials remain completely untouched.

### Uninstallation

```bash
brew uninstall wazir
```

Uninstallation removes only the binary and Homebrew Cellar files. To completely purge state and history, optionally delete:

```bash
rm -rf ~/.wazir
```

### Submission & Upstream Maintenance

The formula is defined in [Formula/wazir.rb](../Formula/wazir.rb) and [packaging/homebrew/Formula/wazir.rb](../packaging/homebrew/Formula/wazir.rb).

- **Custom Tap:** Pushing to `whassan007/homebrew-tap` makes updates available immediately to all users.
- **Homebrew Core:** To submit to `homebrew/core`, follow the [Homebrew formula submission checklist](https://docs.brew.sh/Formula-Cookbook). Wazir meets licensing (AGPL-3.0), audit (`brew audit --strict`), and test requirements (`brew test wazir`).

---

## 3. Scoop (Windows)

[Scoop](https://scoop.sh) is a command-line installer for Windows that installs applications in user space without requiring administrator privileges.

### Installation

```powershell
# Add the Wazir bucket
scoop bucket add wazir https://github.com/whassan007/wazir

# Install Wazir
scoop install wazir
```

Scoop installs the native `wa.exe` binary and generates a command shim automatically in `%USERPROFILE%\scoop\shims\wa.exe`.

### Upgrading

```powershell
scoop update wazir
```

Scoop extracts the new version archive into `%USERPROFILE%\scoop\apps\wazir\<version>` and updates the `current` junction. All configuration and ledger files located in `%USERPROFILE%\.wazir` are fully preserved.

### Uninstallation

```powershell
scoop uninstall wazir
```

To remove residual configuration and logs:

```powershell
Remove-Item -Recurse -Force "$HOME\.wazir"
```

### Upstream Maintenance

The Scoop manifest is located at [bucket/wazir.json](../bucket/wazir.json) and [packaging/scoop/wazir.json](../packaging/scoop/wazir.json). It incorporates `checkver` and `autoupdate` blocks for automatic release synchronization.

---

## 4. WinGet (Windows Package Manager)

WinGet is the official Windows Package Manager integrated directly into Windows 10 (1809+) and Windows 11.

### Installation

```powershell
winget install Whassan.Wazir
```

WinGet downloads the verified release archive, verifies the SHA-256 integrity hash against Microsoft's repository, extracts `wa.exe`, and binds the `wa` command alias to your user PATH.

### Upgrading

```powershell
winget upgrade Whassan.Wazir
```

### Uninstallation

```powershell
winget uninstall Whassan.Wazir
```

### Submission to microsoft/winget-pkgs

WinGet manifests follow schema version 1.6.0:

- Version manifest: `packaging/winget/manifests/w/Whassan/Wazir/<version>/Whassan.Wazir.yaml`
- Installer manifest: `packaging/winget/manifests/w/Whassan/Wazir/<version>/Whassan.Wazir.installer.yaml`
- Locale manifest: `packaging/winget/manifests/w/Whassan/Wazir/<version>/Whassan.Wazir.locale.en-US.yaml`

To submit a new release to Microsoft's official repository:

```powershell
# Install winget-create tool
winget install Microsoft.WingetCreate

# Submit the new version
wingetcreate submit https://github.com/whassan007/wazir/releases/download/v<version>/wazir-v<version>-windows-x64.zip
```

Alternatively, copy the generated manifests directory into your fork of [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) and open a pull request.

---

## 5. Non-Destructive Persistence Architecture

All package managers install Wazir binaries into isolated executable directories, while state is stored in the user profile directory:

```
~/.wazir/
├── config.json          # User settings, allowed commands, MCP servers
├── resources.db         # SQLite ledger for tasks, jobs, accounts, checkpoints
├── .env                 # API tokens and runtime environment flags
└── logs/                # Session and execution logs
```

### Invariants:
1. **Binary Independence:** Binaries are standalone or packaged into standard prefixes. They do not write within the package installation prefix.
2. **Backward Compatibility:** Database migrations and configuration schemas handle older versions gracefully on startup.
3. **Safe Uninstall:** Package managers do not remove user data in `~/.wazir` upon uninstallation unless explicitly directed.

---

## 6. Automated Manifest Updates

The release pipeline generates and synchronizes manifests across all three package managers in a single command:

```bash
# Update manifests using the latest release checksums
npm run package:manifests -- --sums dist/release/SHA256SUMS.txt

# Or verify manifest integrity
npm run package:manifests -- --verify
```

This workflow runs automatically during release tagging, ensuring that Homebrew formulas, Scoop manifests, and WinGet declarations stay synchronized with release binaries.
