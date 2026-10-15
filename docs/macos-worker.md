# macOS Worker Setup Guide

Wazir runs natively on macOS (Apple Silicon ARM64 and Intel x64), providing first-class integration with Metal hardware acceleration, MLX, LM Studio, and Apple unified memory architectures.

---

## 1. Prerequisites

- macOS 12 Monterey, macOS 13 Ventura, macOS 14 Sonoma, or macOS 15 Sequoia
- Apple Silicon (M1/M2/M3/M4 Pro/Max/Ultra) or Intel x86_64
- Node.js 22.x LTS or standalone `wa` binary
- Optional: Xcode Command Line Tools (`xcode-select --install`) for native compilation

---

## 2. Installation

### Option A: Shell Quick Install
```bash
curl -fsSL https://raw.githubusercontent.com/whassan007/wazir/main/scripts/install.sh | bash
```

### Option B: Homebrew (or Manual Mach-O Binary)
```bash
tar -xzf wazir-v0.1.59-darwin-arm64.tar.gz
sudo cp wazir-v0.1.59-darwin-arm64/wa /usr/local/bin/
```

Verify installation:
```bash
wa --version
wa doctor
```

---

## 3. Apple Silicon Hardware & Unified Memory Discovery

On Apple Silicon (`darwin arm64`), Wazir's hardware discovery module queries `sysctl`:
- `sysctl -n machdep.cpu.brand_string` (identifies e.g. `Apple M2 Ultra`)
- `hw.ncpu` (total physical and performance cores)
- `hw.memsize` (system RAM)
- Metal GPU unified memory: On Apple Silicon, GPU memory matches total system memory (e.g. 64GB, 128GB, or 192GB unified RAM). Wazir automatically flags `unifiedMemory: true` and scores local model residency with zero VRAM offload penalties.

---

## 4. Running as a Background launchd Service

Wazir provides built-in `launchd` service descriptors located at `scripts/launchd/com.wazir.worker.plist`:

```bash
# Register and start worker launchd daemon
cp scripts/launchd/com.wazir.worker.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.wazir.worker.plist
```

---

## 5. Apple Code Signing & Notarization Requirements

Production macOS binaries require signing with an Apple Developer ID Application certificate and notarization via Apple's notary service:

1. **Sign Mach-O executable with Hardened Runtime**:
   ```bash
   codesign --deep --force --options=runtime --sign "Developer ID Application: Your Name (TEAM_ID)" dist/wa
   ```
2. **Submit for Notarization**:
   ```bash
   xcrun notarytool submit dist/wazir-v0.1.59-darwin-arm64.tar.gz --keychain-profile "AC_PASSWORD" --wait
   ```
3. **Staple Ticket**:
   ```bash
   xcrun stapler staple dist/wa
   ```
> [!NOTE]
> Local development binaries run under ad-hoc code signature (`codesign --sign - dist/wa`).
