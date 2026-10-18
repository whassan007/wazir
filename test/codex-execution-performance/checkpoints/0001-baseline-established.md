# Checkpoint 0001 — Environment & Baseline Established

- **Timestamp:** 2026-10-17T19:37:31-07:00
- **Git Branch:** `improve/gemini-execution-integrity`
- **Git Commit:** `f6a6ce708347f64250527788f69a7bd7b40d2d4e`
- **Elapsed Time:** 4 minutes
- **Remaining Budget:** 41 minutes
- **Stop-Condition Status:** CLEAR (0 timeouts, 0 failed repairs, memory healthy)

## 1. What Was Attempted
- Inspected `wa --version` (`0.2.5`), `wa doctor`, `wa models list --json`, `lms ps`, `lms ls`, and `http://localhost:1234/v1/models`.
- Executed direct LM Studio runtime baseline probes across `P01`–`P05` and profiled `wa run` baseline phases.

## 2. Actual Result & Timing
- Resident Gemma 4 QAT model on host is `gemma-4-26b-a4b-it-qat` (`READY`, 32,768 context).
- Direct runtime latency:
  - `P01`: TTFT `138.21 ms`, Total `138.59 ms` (non-streaming `148.81 ms`, output `"31"`)
  - `P02`: TTFT `136.74 ms`, Total `137.00 ms` (output `"RIZAW"`)
  - `P03`: TTFT `121.08 ms`, Total `121.20 ms` (output `"56"`)
  - `P04`: TTFT `160.32 ms`, Total `512.99 ms`
  - `P05`: TTFT `173.36 ms`, Total `583.19 ms`
- Unpatched `wa run` baseline latency: `58.3s – 74.9s` with exit code `1` (`Verification failed: Agent declared completion but produced no code modifications.`).

## 3. Engineering Conclusion
- The ~231 ms metric in the problem statement is the complete single-turn inference time (and TTFT) for a 1–3 token completion on `gemma-4-26b-a4b-it-qat`.
- Over 99.6% of `wa run` latency is caused by Wazir startup, redundant model/runtime probing, multi-turn `CodingAgent` orchestration, mandatory full-repo `build`/`test`/`lint`/`typecheck` verification, and repeated 33 MB `JsonFileStore` reloads/flushes.

## 4. Exact Resume Instructions
- Proceed to Checkpoint 0002 (`test/codex-execution-performance/checkpoints/0002-bottlenecks-confirmed.md`) and apply the three ranked repairs (`DEFECT-01`, `DEFECT-02`, `DEFECT-03`).
