# Wazir Execution Repair — Final Verification Report

## 1. Mission Status

**COMPLETE — All 20 functional areas (`WF-01` through `WF-20`) and all required live local-model qualifications have been executed, verified, and recorded with preserved durable evidence.**

- **Branch**: `integration/cross-harness-outcome-recovery` (base `e87d7e3`, head `555f083` plus final report commit; not pushed or published).
- **Deterministic Regression Suite**: `node tests/wazir-functional/run.mjs --run --no-build` → **21 test files passed, 241 tests passed, 1 skipped** (`evidence/final-deterministic-run.log`).
- **Live Local Model Qualification**: Executed through real `node ./bin/wa.js chat --model google/gemma-4-12b-qat --routing-mode LOCAL_ONLY` against LM Studio (`http://localhost:1234`, `google/gemma-4-12b-qat`, GGUF Q4_0, `loaded_context_length: 8192`, `max_context_length: 262144`) using isolated `WAZIR_HOME` and project directories with hosted API keys cleared.

---

## 2. Live Execution Qualification Summary

| Run ID | Prompt | Session ID | Job ID / Execution ID | Duration | Tokens (In / Out / Total) | Outcome & Independent Verification |
|---|---|---|---|---:|---:|---|
| `LIVE-CPP-01` | `Write a complete C++17 program\nthat implements quicksort.\nInclude main and print 10 sorted integers.` | `session-1792742872831-3s6lt` | `job-78a23b0b-16b5-4515-ad02-9e8d1c14d105` / `exec-mvkothsc-1` | `88,283 ms` | `20,584` / `1,610` / `22,194` | **PASS** — Completed in `wa chat`. Independent `g++ -std=c++17 -Wall -Wextra -pedantic` compile exit `0`, run exit `0`, printed 10 ascending integers `1 5 7 12 23 32 32 34 45 62` (`evidence/cpp-quicksort-independent.json`). |
| `LIVE-A8-PY-01` | `Write a Python program implementing\nmerge sort, binary search, and unittest tests.` | `session-1792743011286-94fra` | `job-b53490e3-ace1-421d-a192-b6822495874a` / `exec-mvkowgoj-1` | `240,000 ms` (driver timeout) | `20,345` / `1,455` / `21,800` | **PARTIAL (Artifacts Verified)** — Model wrote `algorithms.py` and `test_algorithms.py`, then requested `shell` (`python3 test_algorithms.py`), which triggered interactive policy approval (`? shell: python3 test_algorithms.py · A approve · D deny`). Preserved files independently passed `python3 -m unittest -v test_algorithms.py` (`Ran 2 tests in 0.000s — OK`, `evidence/a8-python-independent.json`). |
| `LIVE-FINAL-PY-01` | `Write a Python program implementing\nmerge sort, binary search, and unittest tests.` | `session-1792802507236-bzhz6` | `job-fcddaf35-dfc4-4ca7-a5e7-7b8d8cd10db6` / `exec-mvlobo0o-1` | `70,336 ms` | `24,639` / `1,433` / `26,072` | **PASS** — Completed end-to-end in `wa chat` with 1 interactive policy approval (`approved_count: 1`). Independent `python3 -m unittest -v test_algorithms.py` ran 2 tests in `0.000s` (`OK`, `evidence/final-python-independent.json`). |
| `LIVE-FINAL-ARITH-01` | `What is 17 multiplied by 23?\nReply with only the number.` | `session-1792802371144-r8z8g` | `job-6ce3b856-3a99-4261-9e78-d3fa9b5681b1` / `exec-mvlo8r1g-1` | `18,286 ms` | `2,864` / `99` / `2,963` | **PASS** — Completed in 1 turn (`mutationRequired: false`, `reservedOutputTokens: 256`). Output text is exact `"391"` (`evidence/final-chat-recovery-wazir.json`). |
| `LIVE-FINAL-RECOVERY-TIMEOUT` | `Write a complete C++17 program\nthat implements quicksort.\nInclude main and print 10 sorted integers.` | `session-1792802371144-r8z8g` | `job-f166494e-ca7f-4227-a643-4045bb9e3cf9` / `exec-mvlo96dd-2` | `60,161 ms` | `6,158` / `778` / `6,936` | **EXPECTED TIMEOUT** — Deliberately bounded by `--timeout 60` (`Task exceeded the 60s timeout and was automatically stopped`) to test same-session failure and stream recovery. |
| `LIVE-FINAL-ARITH-02` | `What is 17 multiplied by 23?\nReply with only the number.` | `session-1792802371144-r8z8g` | `job-7d451d06-c34c-4a0c-b596-e9f19e8c8013` / `exec-mvloai0h-3` | `14,962 ms` | `2,863` / `74` / `2,937` | **PASS** — Submitted in the same `wa chat` session immediately after `LIVE-FINAL-RECOVERY-TIMEOUT`. Streamed and completed in 1 turn with exact `"391"` and zero stale error bleed (`evidence/final-chat-recovery-wazir.json`). |

---

## 3. Root Causes Found During Final Live Qualification (`555f083`)

1. **Reasoning-token truncation on factual `CodingAgent` tasks**:
   - In `wa chat`, tasks created via `FleetTui.launchJobFromPrompt()` run through `CodingAgent` with `type: 'coding'` and `mutationRequired: false`.
   - `planOutputReserveTokens()` previously set a `128`-token floor for factual prompts (`What is 17 multiplied by 23?...`), clamping `max_tokens` to `128`.
   - Because `google/gemma-4-12b-qat` in LM Studio emits internal `reasoning_content` tokens (consuming `60–115` completion tokens before emitting `content`), a `128`-token ceiling intermittently truncated the JSON response (`{"action":"done","` or empty `content` with `finish_reason: "length"`).
   - Raising the factual output reserve floor from `128` to `256` tokens in `packages/core/src/services/contextCompiler.ts` gives local reasoning models sufficient room for both chain-of-thought and the JSON action envelope.
2. **Verbose prose in `CodingAgent` fast-answer summary**:
   - `CodingAgent`'s `fastAnswerHint` instructed the model to respond with `{"action":"done","summary":"..."}`, where the base system prompt defined `"summary"` as `"what was accomplished and how it was verified"`. As a result, Gemma wrote `"The result of 17 multiplied by 23 is 391."` instead of `"391"`.
   - Updating `fastAnswerHint` in `packages/agents/src/codingAgent.ts` to require matching the user's requested output format verbatim inside `"summary"` resolved the formatting failure: both `LIVE-FINAL-ARITH-01` and `LIVE-FINAL-ARITH-02` returned exact `"391"`.
3. **Interactive policy approval for newly written test scripts in `wa chat`**:
   - `PolicyEngine.classifyTestWorkspace()` intentionally refuses automatic execution (`allow`) when a test script (`test_algorithms.py`) was written during the same execution, returning `ask` so the operator approves executing newly generated code.
   - Adding `auto_approve` support to `tests/wazir-functional/live-pty.py` allowed the PTY harness to send `a` when `FleetTui` displayed `A approve · D deny`, enabling full end-to-end completion in `LIVE-FINAL-PY-01` (`70,336 ms`).

---

## 4. Per-Case Outcomes (`WF-01` through `WF-20`)

Full 19-column telemetry is recorded in [execution-results.csv](execution-results.csv). Deterministic tests are never relabeled as live inference.

- **`WF-01` (small context)**: **PASS (deterministic + live 8K verification)** — `contextCompiler.comprehensive.test.ts`, `modelLifecycleAdmission.test.ts`, plus live 8192-context executions.
- **`WF-02` (large context)**: **PASS (deterministic regression)** — `contextCompiler.comprehensive.test.ts`, `contextCompactionService.test.ts`.
- **`WF-03` (output clamp)**: **PASS (deterministic + live verification)** — `contextCompiler.comprehensive.test.ts`, `codingAgent.contextCompaction.test.ts`.
- **`WF-04` (provider limits)**: **PASS (deterministic regression)** — `nvidiaAdapter.test.ts`, `contextCompiler.comprehensive.test.ts`.
- **`WF-05` (overflow recovery)**: **PASS (deterministic regression)** — `codingAgent.contextOverflowRecovery.test.ts`.
- **`WF-06` (unknown context)**: **PASS (deterministic regression)** — `modelLifecycleAdmission.test.ts`.
- **`WF-07` (device memory)**: **PASS (deterministic regression)** — `hardwareDiscovery.test.ts`, `modelLifecycleAdmission.test.ts`.
- **`WF-08` (resident incremental memory)**: **PASS (deterministic + live reuse)** — `modelLifecycleAdmission.test.ts` and live LM Studio admission (`reuse: true`).
- **`WF-09` (unloaded model memory)**: **PASS (deterministic regression)** — `modelLifecycleAdmission.test.ts`.
- **`WF-10` (AUTO fallback)**: **PASS (deterministic regression)** — `scheduler.test.ts`, `modelLifecycleAdmission.test.ts`.
- **`WF-11` (STRICT routing)**: **PASS (deterministic regression)** — `harnessDispatch.test.ts`.
- **`WF-12` (LOCAL_ONLY routing)**: **PASS (deterministic + live LOCAL_ONLY)** — `schedulerHostedRouting.test.ts`, `nvidiaProviderSystem.test.ts`, and all live runs.
- **`WF-13` (stale jobs)**: **PASS (deterministic + live session isolation)** — `tuiSessionLifecycle.test.ts`, `conversationProjection.test.ts`.
- **`WF-14` (duplicate events)**: **PASS (deterministic regression)** — `conversationProjection.test.ts`, `executionHistory.test.ts`.
- **`WF-15` (CLI suggestions)**: **PASS (deterministic regression)** — `fleetTui.test.ts`.
- **`WF-16` (SQLite)**: **PASS (deterministic + startup stderr check)** — `resourceLedgerLazyStartup.test.ts`, `sqliteMemoryStore.test.ts`, `evidence/startup-version.stderr` (0 bytes), `evidence/startup-help.stderr` (0 bytes).
- **`WF-17` (real model)**: **PASS (live model inference)** — Verified on `google/gemma-4-12b-qat` via LM Studio across `LIVE-CPP-01`, `LIVE-FINAL-PY-01`, `LIVE-FINAL-ARITH-01`, and `LIVE-FINAL-ARITH-02`.
- **`WF-18` (stream after recovery)**: **PASS (deterministic + live recovery)** — `codingAgent.streamRetry.test.ts` + live `LIVE-FINAL-ARITH-02` completing with `"391"` in `14,962 ms` immediately after `LIVE-FINAL-RECOVERY-TIMEOUT` failed at `60,161 ms` in the same session (`session-1792802371144-r8z8g`).
- **`WF-19` (consecutive chats)**: **PASS (deterministic + live consecutive chats)** — `chatAgent.test.ts`, `tuiSessionLifecycle.test.ts`, `planner.test.ts` + live session `session-1792802371144-r8z8g` completing consecutive prompts (`job-6ce3b856-3a99-4261-9e78-d3fa9b5681b1` and `job-7d451d06-c34c-4a0c-b596-e9f19e8c8013`) with exact `"391"`.
- **`WF-20` (coding completion)**: **PASS (deterministic + live C++17 and Python)** — Live C++17 quicksort (`LIVE-CPP-01`, `88,283 ms`) and live Python merge sort + binary search + `unittest` (`LIVE-FINAL-PY-01`, `70,336 ms`, plus preserved `LIVE-A8-PY-01`) completed and passed independent compiler/test verification.

---

## 5. Preserved Evidence Index (`tests/wazir-functional/evidence/`)

- `final-deterministic-run.log` — Integrated 21-file Vitest run output (`241 passed, 1 skipped`).
- `cpp-quicksort-spec.json`, `cpp-quicksort-summary.json`, `cpp-quicksort-transcript.ansi`, `a8-cpp-quicksort-wazir.json`, `cpp-quicksort-independent.json`, `cpp-quicksort-preserved/main.cpp` — Live C++17 quicksort execution and independent `g++` verification.
- `python-merge-binary-spec.json`, `python-merge-binary-summary.json`, `python-merge-binary-transcript.ansi`, `a8-python-search-wazir.json`, `a8-python-independent.json`, `a8-python-preserved/` — Preserved A8 Python run and independent `unittest` verification.
- `final-python-spec.json`, `final-python-summary.json`, `final-python-transcript.ansi`, `final-python-wazir.json`, `final-python-independent.json`, `final-python-independent/` — Completed end-to-end live Python merge sort + binary search + `unittest` qualification.
- `final-chat-recovery-spec.json`, `final-chat-recovery-summary.json`, `final-chat-recovery-transcript.ansi`, `final-chat-recovery-wazir.json` — Live 3-prompt session verifying exact `"391"` arithmetic output, bounded timeout failure, and same-session recovery.
- `baseline-chat-jobs.json`, `arithmetic-pty.json`, `a8-arithmetic-wazir.json` — Pre-fix baseline and exploratory arithmetic evidence preserved for auditability.
- `host-memory.json`, `vm-stat.txt`, `startup-help.stdout`, `startup-help.stderr`, `startup-version.stdout`, `startup-version.stderr` — Host memory and lazy SQLite startup evidence.
