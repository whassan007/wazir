# Windows Worker Setup Guide

Wazir supports native Windows 10, Windows 11, and Windows Server (x64 and ARM64) as execution workers and distributed controllers.

---

## 1. Prerequisites

- Windows 10 / 11 (x64 recommended, build 19041+)
- PowerShell 5.1+ or PowerShell 7 (pwsh)
- Node.js 22.x LTS or standalone `wa.exe` binary
- Optional GPU Support: NVIDIA GPU with CUDA Toolkit 12.x or modern DirectX 12 DirectML drivers

---

## 2. Installation

### Option A: Native Standalone Binary (`wa.exe`)
Download `wazir-v<version>-windows-x64.zip` from releases, extract, and add to your `PATH`:

```powershell
Expand-Archive -Path .\wazir-v0.1.59-windows-x64.zip -DestinationPath "C:\Program Files\Wazir"
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Program Files\Wazir", [EnvironmentVariableTarget]::Machine)
```

### Option B: PowerShell Quick Installer
Run the automated Windows installer script:

```powershell
irm https://raw.githubusercontent.com/whassan007/wazir/main/scripts/install.ps1 | iex
```

Verify the installation:
```powershell
wa.exe --version
wa.exe doctor
```

---

## 3. Worker Configuration & Hardware Discovery

The Windows worker automatically queries system topology:
- **CPU**: Discovered via `Get-CimInstance Win32_Processor` or `wmic cpu get Name,NumberOfCores`.
- **Memory**: Total and free RAM queried via Windows CIM APIs.
- **GPU & CUDA**: NVIDIA GPUs detected via `nvidia-smi` or `Win32_VideoController`.

### Running Worker as a Console Process

```powershell
$env:WAZIR_CONTROLLER_URL = "http://controller.corp.net:4000"
$env:WAZIR_REGISTRATION_TOKEN = "sk-reg-cluster-secret"

wa workers start --controller $env:WAZIR_CONTROLLER_URL --name "win-workstation-rtx4090"
```

---

## 4. Running as a Background Windows Service

Wazir includes Windows Service integration via `sc.exe`:

```powershell
# Create background Windows Service
sc.exe create WazirWorker binPath= "C:\Program Files\Wazir\wa.exe workers start --controller http://controller:4000" start= auto

# Start service
sc.exe start WazirWorker
```

---

## 5. Security & Authenticode Code Signing Requirements

For production enterprise deployment:
1. Binary `wa.exe` must be signed with an EV Code Signing Certificate using Windows SDK `signtool.exe`:
   ```powershell
   signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a "C:\dist\wa.exe"
   ```
2. Verify signature:
   ```powershell
   signtool verify /pa /v "C:\dist\wa.exe"
   ```
> [!NOTE]
> Standalone unsigned developer binaries trigger Windows SmartScreen warnings on first run. Unblock with `Unblock-File .\wa.exe`.
