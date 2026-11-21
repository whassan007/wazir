# Wazir Shell Baseline Validation Report

- **Timestamp:** 2026-11-21T20:31:00Z
- **Repository:** `/Users/wael/Code/Wazir`
- **Baseline Commit:** `a96507f5ca5fa16e2a181188661eddc18bba01b0`
- **Validation Branch:** `feat/wazir-shell-e2e-repair`
- **CLI Version:** `0.4.0` (built at `apps/cli/dist/index.js`)

## 1. Baseline Diagnostic Checks

- `node apps/cli/dist/index.js doctor`: **17 passed, 2 warnings**
  - `3/3` computers online (`local` WaelMacPro.local, `mac_studio` M4 Max, `dgx_spark` NVIDIA DGX Spark GB10)
  - `6/6` runtimes healthy (`mlx`, `ollama`, `lmstudio`, `mac_studio:ollama`, `mac_studio:lmstudio`, `dgx_spark:ollama`)
  - `1/1` hosted provider healthy (`nvidia`, 35 hosted models)
  - `55` registered models (`1` locally loaded on `mac_studio`: `qwen/qwen3-30b-a3b`, `36` ready)
  - Optional native addons active: `os-keychain` (`@napi-rs/keyring`), `node-pty`, `rg`, `qwen --acp`
  - Warnings: `gemma4:26b@dgx_spark:ollama` and `qwen3-coder:30b@dgx_spark:ollama` installed but unloaded; prompt-cache telemetry unavailable on `dgx_spark:ollama` and `lmstudio`.
- `npm run typecheck`: PASS
- Existing shell test baseline (`shellClassifier.test.ts`, `shellCommand.test.ts`, `shell.test.ts`): PASS

## 2. Baseline Defects Identified for Repair

| Defect ID | Severity | Area | Summary |
|---|---|---|---|
| `DEF-001` | P0 | AI Execution & Admission | `launchInteractiveWazirShell` `aiHandler` invokes `executeTask(engine, request, {})` without model selection, permission mode (`/permissions`, `--permissions`), loaded-model fallback when default model hits `MODEL_ADMISSION_DENIED: INSUFFICIENT_MEMORY` (macOS low free memory `0.1 GiB`), or printing `outcome.result`, `outcome.errors`, and model provenance. |
| `DEF-002` | P1 | Shell Input Classifier | `classifyShellInput("find broken tests")` misroutes to native OS `/usr/bin/find broken tests` (`KNOW_SHELL_BINARIES.has('find')`) instead of AI because `NATURAL_LANGUAGE_FOLLOWERS` lacks common NL adjectives/targets like `broken`. |
| `DEF-003` | P1 | Signal & Child Cleanup | `executeShellLine` only sends `SIGINT` to the outer shell (`zsh`/`sh`), risking orphaned child processes (`! sleep 10`) on abort/Ctrl+C, and does not propagate `AbortSignal` into `aiHandler`. |
| `DEF-004` | P1 | Tab Completion | `launchInteractiveWazirShell` completer only matches static builtins without filesystem completion in `state.cwd` and is not exported for automated verification (`S14`). |
| `DEF-005` | P1 | Shell Builtin `$VAR` Expansion & PTY | Builtin `cd $VAR` and `export BAZ=$FOO/sub` do not expand `$VAR` / `${VAR}` from `state.env`, limiting shell variable persistence across builtin commands (`S09`). |
