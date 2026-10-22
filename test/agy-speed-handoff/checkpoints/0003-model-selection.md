# AGY Handoff Checkpoint

Checkpoint ID: 0003-model-selection
Timestamp: 2026-10-17T19:11:31-07:00
Current phase: Phase 2 — Model Selection
Repository: /home/wael/Code/Wazir
Git branch: improve/gemini-execution-integrity
Git commit: 6a6fb8b5d241673c48cb6e5384b5ce70429c868a
Wazir version: 0.2.5

## Objective
Evaluate the three resident GPU models in LM Studio against latency, footprint, and elementary task responsiveness criteria, select the fastest suitable resident model, and document the rationale in `model-selection.md`.

## Action Taken
1. Ran `wa --help` to inspect CLI subcommands (`wa run`, `wa ask`, `wa task`).
2. Executed a direct streaming latency micro-probe (`What is 2+2? Return only the number.`) against all 3 resident models in LM Studio (`127.0.0.1:1234/v1/chat/completions`).
3. Wrote `test/agy-speed-handoff/model-selection.md`.

## Observed Result
- `gemma-4-26b-a4b-it-qat`: TTFT = 230.8ms, Total = 231.0ms, Output = `'4'` (14.44 GB VRAM, 26B-A4B MoE, Parallel=4).
- `nvidia/nemotron-3-nano-omni`: TTFT = 218.5ms, Total = 341.1ms, Output = `''` (spends initial budget in reasoning tokens; 26.10 GB VRAM).
- `qwen/qwen3.8-27b`: TTFT = 409.4ms, Total = 924.0ms, Output = `''` (spends initial budget in reasoning tokens; 17.74 GB VRAM, 27B dense).

## Engineering Analysis
`gemma-4-26b-a4b-it-qat` is the clear winner: it is already resident in GPU memory, has the smallest memory footprint (14.44 GB), uses only 4B active parameters per token, has 4 parallel slots configured in LM Studio, and answers directly without burning hundreds of thinking tokens on trivial tasks.

## Decision
Select `gemma-4-26b-a4b-it-qat` (`lmstudio`) for all 10 benchmark tasks (serial and parallel).

## Files Modified
- `test/agy-speed-handoff/model-selection.md` (Populated full inventory and rationale)
- `test/agy-speed-handoff/checkpoints/0003-model-selection.md` (Created)
- `test/agy-speed-handoff/handoff-history.md` (Appended step 0003)
- `test/agy-speed-handoff/HANDOFF.md` (Atomically updated)
- `test/agy-speed-handoff/execution-live.log` (Logged model probe and selection)

## Verification
Verified `gemma-4-26b-a4b-it-qat` responds in 231.0ms with exact answer `'4'`.

## Outstanding Issues
- Confirm exact CLI invocation flags (`wa run` vs `wa ask`) so we pass `--model gemma-4-26b-a4b-it-qat` (or equivalent flag) through Wazir's real execution pipeline.

## Immediate Next Action
Inspect `wa run --help` and `wa ask --help` output, then execute Task E01 (`What is 12 + 18? Return only the number.`) through Wazir's execution pipeline and persist Checkpoint 0004.

## Resume Command
`wa run --model gemma-4-26b-a4b-it-qat "What is 12 + 18? Return only the number."`

## Recovery Notes
No models were loaded or unloaded.
