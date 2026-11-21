# Wazir AI OS — Training, Operations & Fine-Tuning Guide (`v0.4.1`)

**Applies to:** Wazir AI OS `v0.4.1` (`wa`, `wazir`, `Wazir Shell.app`, `Wazir Mission Control.app`, `ai.wazir.mobile`)  
**Repository:** `https://github.com/whassan007/wazir` · **Portal:** `https://wazir.wael.bot`

This guide provides end-to-end training for operators, developers, and fleet administrators installing Wazir AI OS, mastering the 4-Tier `FastOrchestrator` in Wazir Shell, orchestrating `loop`/`graph`/`goal` workflows, and training/fine-tuning the embedded `wazir-shell-mini` (`LiquidAI/LFM2.5-350M`) router model.

---

## Module 1: Cross-Platform Installation & First-Run Verification

### Requirements
- **Node.js `>= 22.13.0`** (required for built-in `node:sqlite` resource ledger and memory store)
- **Git** (workspace tracking and isolated worktrees)
- Optional local inference runtimes: **Ollama** (`:11434`), **LM Studio** (`:1234`), **MLX** (`:8080`), or embedded **`wazir-shell-mini`** (`llama-server` + `LFM2.5-350M-Q4_K_M.gguf`)

### 1.1 macOS (Apple Silicon / Intel)
```bash
# Option A: Source installer (recommended for developers)
git clone https://github.com/whassan007/wazir.git ~/Code/Wazir
bash ~/Code/Wazir/scripts/install.sh

# Option B: Homebrew Tap
brew tap whassan007/tap
brew install wazir

# Option C: Universal CLI archive from https://wazir.wael.bot/download
curl -LO https://wazir.wael.bot/releases/wazir-cli-0.4.1-any.tar.gz
curl -LO https://wazir.wael.bot/releases/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
tar -xzf wazir-cli-0.4.1-any.tar.gz
node bin/wa.js about
```
> **Note on unsigned macOS `.app` bundles:** If you install `Wazir-Shell-0.4.1-macos-arm64.tar.gz` or `Wazir-Mission-Control-0.4.1-macos-arm64.tar.gz`, clear quarantine once before opening:
> ```bash
> xattr -cr "/Applications/Wazir Shell.app"
> xattr -cr "/Applications/Wazir Mission Control.app"
> ```

### 1.2 Ubuntu / Debian (`.deb`) & Fedora / RHEL (`.rpm`)
```bash
# Ubuntu / Debian
curl -LO https://wazir.wael.bot/releases/wazir_0.4.1_all.deb
curl -LO https://wazir.wael.bot/releases/SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt --ignore-missing
sudo dpkg -i wazir_0.4.1_all.deb

# Fedora / RHEL (from source tarball + included RPM spec)
curl -LO https://wazir.wael.bot/releases/wazir-0.4.1.tar.gz
tar -xzf wazir-0.4.1.tar.gz
rpmbuild -tb wazir-0.4.1.tar.gz
```

### 1.3 Windows 11 (Native x64 / ARM64 — No WSL2 Required)
```powershell
# Source installer
git clone https://github.com/whassan007/wazir.git $HOME\Code\Wazir
& "$HOME\Code\Wazir\scripts\install.ps1"

# Or via WinGet / Scoop
winget install Whassan.Wazir
# OR:
scoop bucket add wazir https://github.com/whassan007/wazir
scoop install wazir
```

### 1.4 GrapheneOS / Android Companion & Termux ARM64 CLI
- Download `wazir-mobile-0.4.1-android-debug.apk` (`ai.wazir.mobile`, zero-root Jetpack Compose app) and pair via QR/URI in Mission Control.
- Or install the native CLI inside Termux on ARM64:
```bash
pkg update -y && pkg install -y nodejs-lts git openssh
git clone https://github.com/whassan007/wazir.git
cd wazir && bash scripts/install-termux.sh
```

### 1.5 Post-Install Health Check & Diagnostics Consent
```bash
wa --version               # Verify installed version matches 0.4.1
wa about                   # Print authorship, repository, and licensing summary
wa doctor                  # Inspect Node, runtimes, models, agents, and OS sandbox
wa diagnostics notice      # Review privacy/diagnostics notice (opt-in only)
wa diagnostics decline     # Or: wa diagnostics accept
```

---

## Module 2: Mastering Wazir Shell & the 4-Tier `FastOrchestrator`

Launch Wazir Shell interactively with `wazir` or `wa shell`, or execute one-off lines with `wa shell -c "<input>"`.

### 2.1 The 4 Execution Tiers

| Tier | Purpose | Latency Target | Trigger Examples |
| :--- | :--- | :--- | :--- |
| **Tier 0** | Deterministic in-process builtins & utility answers (zero LLM call) | `< 5 ms` | `what time is it`, `today`, `version`, `pwd`, `whoami`, `hostname`, `2 + 2`, `models`, `status`, `jobs`, `history`, `tools`, `route "..."`, `latency`, `debug on\|off` |
| **Tier 1** | Native OS PTY / child shell execution with persistent `cwd`, `env`, `aliases`, and `SIGINT` process-tree forwarding | Native OS speed | `ls -la`, `git status -sb`, `cat foo \| grep bar`, `! <cmd>`, `\<cmd>`, `os:<cmd>`, `sh:<cmd>` |
| **Tier 2** | Fast local LLM streaming (or embedded `wazir-shell-mini` tool routing) without cold-booting full orchestration | Sub-second TTFT | `explain chmod 755`, `? what is TCP`, `which files changed recently`, `find largest files` |
| **Tier 3** | Full multi-tool agent loop (`WazirQwenAgent`) and bounded `loop`/`graph`/`goal` workflows | Task-dependent | `loop "Improve every city"`, `graph "Build REST API + tests"`, `goal "Make project production-ready"`, `fix the failing test in src/auth.ts` |

### 2.2 Essential Interactive Directives & Escapes
- `! <cmd>`, `\<cmd>`, `os:<cmd>`, `sh:<cmd>` — Force native OS shell execution (Tier 1).
- `? <prompt>` — Force AI routing even if an input looks like a shell token.
- `/mode auto | shell | ai` — Lock or unlock session routing behavior.
- `/model <id|auto>` — Pin a specific model ID for the session or reset to scheduler `auto`.
- `/permissions ask | auto | read-only` — Control whether AI mutating tools prompt (`ask`), allow safe workspace test/read operations (`auto`), or block all mutations (`read-only`).
- `route "<expr>"` (or CLI `wa route "<expr>"`) — Inspect the exact tier, handler, and model decision without executing.
- `latency` / `latency --json` / `latency reset` (or CLI `wa latency`) — Inspect the 13-metric dispatch and TTFT/TPS percentile report.
- `debug on | off | status` (or CLI `wa debug on`) — Print `[wazir-debug]` and `[wazir-ai]` routing telemetry lines.

### 2.3 Privacy & Local-Only Guarantees
Setting `WAZIR_LOCAL_ONLY=1` or configuring `"networkAllowed": false` / `"routing": { "mode": "local_only" }` in `~/.wazir/config.json` prevents any hosted fallback (`isFastHostedFallbackPermitted() === false`) even if cloud API keys are present in environment variables.

---

## Module 3: Loop, Graph & Automatic Goal Workflows

Wazir Shell and the `wa` CLI share one `@wazir/goals` `WorkflowRuntimeService` backend:

### 3.1 Bounded Loop (`loop` / `wa loop`)
Discovers workspace collections (files, JSON registries, directories) and executes bounded iterations with durable cursors, retry limits, and crash recovery:
```bash
wa loop "Audit every markdown doc for broken links" --concurrency 2 --max-iterations 10
wa loop "Review TypeScript files under packages/core" --dry-run
```

### 3.2 Acyclic DAG Graph (`graph` / `wa graph`)
Compiles multi-stage goals into an acyclic dependency graph (`validateGoalGraph`, `criticalPath`, `topologicalOrder`) with parallel branches and verification/approval gates:
```bash
wa graph "Implement auth endpoint, add integration tests, and verify typecheck" --budget 0
```

### 3.3 Automatic Goal Mode (`goal` / `wa goal run`)
Classifies intent into `single`, `loop`, `graph`, or `hybrid` and runs end-to-end with evidence-gated verification:
```bash
wa goal run "Make service production-ready" --mode auto --json
wa jobs
wa inspect <run-id>
wa pause <run-id> && wa resume <run-id>
wa stop <run-id>
```

---

## Module 4: Training & Fine-Tuning `wazir-shell-mini` (`LiquidAI/LFM2.5-350M`)

Wazir embeds support for **`wazir-shell-mini`**, built on **`LiquidAI/LFM2.5-350M`** (`LFM2.5-350M-Q4_K_M.gguf`, 350M parameters, 32K context, LFM Open License v1.0) via `packages/core/src/services/liquidShellOrchestrator.ts`. It classifies natural-language shell inspection/action requests into Wazir's 18 schema-validated tools using Liquid's native Pythonic function-call tokens:

```text
<|tool_call_start|>[find_largest_files(path=".", limit=10)]<|tool_call_end|>
```

When a request requires multi-file coding, refactoring, architecture, or triggers an untrusted prompt-injection pattern, the trained model emits:

```text
<|tool_call_start|>[escalate_to_wazir(reason="Requires multi-file coding and test execution")]<|tool_call_end|>
```

### 4.1 Generate the Tool-Calling SFT Dataset
Generate validated training and evaluation splits (`dist/training/wazir-shell-mini-sft.jsonl` and `dist/training/wazir-shell-mini-eval.jsonl`):
```bash
node scripts/generate-shell-training-dataset.mjs
```
The generator emits ChatML examples covering all 18 tools (`find_largest_files`, `find_files`, `search_text`, `list_directory`, `read_file_head`, `count_lines`, `list_port_processes`, `list_top_processes`, `git_current_branch`, `git_status_summary`, `git_recent_commits`, `git_diff_stat`, `disk_usage`, `system_resource_status`, `create_directory`, `remove_file`, `kill_process`, `escalate_to_wazir`) including mutating tool safety cases and prompt-injection escalation examples.

### 4.2 Validate & Fine-Tune with LoRA (`scripts/train-wazir-shell-mini.py`)
```bash
# 1. Validate dataset formatting & tool-call delimiters locally (zero GPU required)
python3 scripts/train-wazir-shell-mini.py --validate-only

# 2. Run LoRA Supervised Fine-Tuning (requires transformers, peft, trl, torch, datasets)
python3 scripts/train-wazir-shell-mini.py \
  --model-id LiquidAI/LFM2.5-350M \
  --dataset dist/training/wazir-shell-mini-sft.jsonl \
  --eval-dataset dist/training/wazir-shell-mini-eval.jsonl \
  --output-dir dist/training/wazir-shell-mini-lora \
  --epochs 3 \
  --learning-rate 2e-4
```

### 4.3 Export & Quantize to GGUF (`Q4_K_M`)
After merging the LoRA adapter (`--merge-and-save`), convert to GGUF and quantize with `llama.cpp` (recommended generation params: `temperature=0.1`, `top_k=50`, `repeat_penalty=1.05`):
```bash
python3 /path/to/llama.cpp/convert_hf_to_gguf.py dist/training/wazir-shell-mini-merged \
  --outfile dist/training/wazir-shell-mini-f16.gguf \
  --outtype f16

llama-quantize dist/training/wazir-shell-mini-f16.gguf \
  assets/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf Q4_K_M
```

### 4.4 Evaluate & Benchmark After Training
```bash
# Run FastOrchestrator & shell validation benchmarks
node scripts/benchmark-fast-orchestrator.mjs
node tests/shell-validation/run-validation.mjs
```

---

## Module 5: Distributed Fleet, Mission Control & Formal Assurance

### 5.1 Multi-Node Fleet Configuration (`~/.wazir/config.json`)
Configure heterogeneous local and remote nodes (Apple Silicon Mac, NVIDIA DGX Spark GB10, Windows RTX) under `fleetHosts`:
```json
{
  "routing": { "mode": "auto" },
  "fleetHosts": [
    { "id": "mac_studio", "lmstudioUrl": "http://127.0.0.1:1235/v1", "ollamaUrl": "http://127.0.0.1:11435" },
    { "id": "dgx_spark", "ollamaUrl": "http://100.113.62.112:11434" }
  ]
}
```
Inspect live fleet health and model admission across hosts:
```bash
wa fleet
wa models list
wa dashboard --port 4800
```

### 5.2 Formal Assurance (`wa assure`)
Verify safety-critical specifications and execution invariants using Z3, Alloy 6, Dafny, Scenic, VerifAI, and GAM:
```bash
./scripts/assure-verify.sh
```
