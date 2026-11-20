# Wazir OS (Ubuntu 26.04.1 LTS / GNOME 50) — Architecture & 12-Workstream Map

**Branch:** `feat/wazir-os-ubuntu` (branched from `ad341e8`)  
**Contract Version:** `1.0.0` (`packages/ubuntu-os/src/contracts.ts`)

---

## Hardware Fleet Discovered
- `local` (`WaelMacPro.local`, Apple M5 Pro, 18 cores, 24 GB): `mlx:8080`, `lmstudio:1234`, `ollama:11434` (9 models)
- `dgx_spark` (`NVIDIA DGX Spark GB10`, ARM64 Linux, 20 cores, 128 GB): `http://100.113.62.112:11434` (6 models)
- `rtx_win` (`laptop-rtx-win.tail16d8d9.ts.net`, `100.84.209.95:1234`): `rtx_win:lmstudio` (`LiquidAI/LFM3-1.7B`)

---

## 12-Workstream Dependency & Ownership Matrix

| Agent | Workstream | Priority | Primary Artifacts | Status |
|---|---|---|---|---|
| **01** | Architecture & Shared Contracts | P0 | `packages/ubuntu-os/src/contracts.ts`, this doc | Complete |
| **02** | Hybrid Linux Shell (`wa shell`) | P0 | `shellClassifier.ts`, `hybridShell.ts`, `apps/cli/src/index.ts` | Complete & Tested |
| **03** | Pluggable Execution Backends (`wa backend`) | P0 | `backendRegistry.ts`, `apps/cli/src/index.ts`, `apps/api/src/server.ts` | Complete & Tested |
| **04** | Configurable Inference Providers | P0 | `inferenceRegistry.ts`, `packages/models/src/engineProfiles.ts` | Complete & Tested |
| **05** | Fast-Path Optimization & Telemetry | P0 | `fastPath.ts`, `tests/wazir-os-ubuntu/benchmark50.test.ts` | Complete & Tested |
| **06** | Speech-to-Text (`whisper.cpp`) | P1 | `voiceAdapters.ts` (`WhisperCppSttAdapter`) | Implemented (binary probed at runtime) |
| **07** | Text-to-Speech (`piper`) | P1 | `voiceAdapters.ts` (`PiperTtsAdapter`) | Implemented (binary probed at runtime) |
| **08** | GNOME 50 Desktop Integration | P1 | `os/wazir-os-ubuntu/gnome/*`, `os/wazir-os-ubuntu/apps/*` | Implemented (requires Ubuntu VM for GUI test) |
| **09** | Settings & CLI/API Parity | P1 | `inferenceRegistry.ts`, `wa settings`, `/api/v1/ubuntu/settings` | Complete & Tested |
| **10** | Ubuntu `.deb` & Autoinstall Image | P1 | `scripts/build-deb.mjs`, `ubuntu-26.04.1-autoinstall.yaml` | Implemented (`dpkg-deb` requires Linux) |
| **11** | Security, Privacy & Recovery | P0 | `voiceAdapters.ts` (`untrustedTranscript`), `hybridShell.ts` | Complete & Tested |
| **12** | E2E QA & 50-Task Benchmark | P0 | `tests/wazir-os-ubuntu/*.test.ts`, `benchmark-results.json` | Complete & Tested |

---

## Canonical Trademark & Legal Compliance
- Wazir is layered as an independently installable `.deb` package over official Ubuntu 26.04.1 LTS without modifying Canonical's trademarks, logos, default login shell, or APT repositories.
- Any public ISO/image built using `ubuntu-26.04.1-autoinstall.yaml` must follow Canonical's Intellectual Property Rights Policy (using unmodified Ubuntu media + Wazir `.deb` side-load, or removing Ubuntu branding if redistributed as a derivative).
