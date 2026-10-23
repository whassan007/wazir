# Wazir execution repair handoff

User requested handoff notes during live verification on 2026-10-23. **Mission incomplete; do not declare the system fully fixed.** No push or publication was performed.

## Integrated checkout

Main checkout: `/Users/wael/Code/Wazir`, branch `integration/cross-harness-outcome-recovery`. Last completed evidence commit before this note: `820cdab`. Base was `e87d7e3`; the branch is ahead of its remote. See `fixes-applied.md` for the integrated repair commits. User changes were absent at start and no destructive reset was performed.

Eight agent roles ran in isolated `/private/tmp/wazir-repair-a1` through `a8` worktrees, using the available `gpt-6-luna` launcher model because requested provider models were not launcher options. Concurrency allowed three subagents plus parent; all eight roles were launched in batches. Bootstrap was direct shell/TypeScript/Vitest, independent of Wazir. `model-verification.md` records assignments and real local model discovery.

## Verified results

- Final integrated deterministic manifest: **21 files passed, 241 tests passed, 1 skipped**. Actual log: `evidence/final-deterministic-run.log`. This covers the 20 requested areas where deterministic coverage is possible; live qualification is separate.
- Shared/core/agents/workers/NVIDIA/CLI TypeScript builds and CLI bundling passed. The installed CLI bundle is generated; source edits need rebuilding before live tests.
- Exact C++17 quicksort prompt completed through actual `wa chat` on `google/gemma-4-12b-qat`, in approximately 88.2 seconds. Independent `g++ -std=c++17 -Wall -Wextra -pedantic` compilation and execution passed; output contained ten ascending integers `1 5 7 12 23 32 32 34 45 62`.
- Baseline three consecutive prompts in one chat: arithmetic succeeded, quicksort deliberately bounded at 60 seconds failed, arithmetic then succeeded without showing the previous error. Arithmetic text was verbose, so number-only formatting did not pass that baseline.
- Exploratory `Compute 17 times 23...` returned `391` but failed mutation verification. This live-reproduced planner mismatch was corrected in `c880b17` with 13 planner tests. **Final exact arithmetic live retest is still required.**
- SQLite imports/ledger construction are lazy; global warning suppression was removed. `--version` and `chat --help` have empty captured stderr. Actual SQLite accounting may legitimately emit Node's experimental warning.

## Remaining live work

1. Preserve A8's active Python run outcome, compile/execute its generated merge sort/binary search/unittest program, and retain raw output.
2. Rebuild A8 with `c880b17` and run the exact arithmetic prompt: `What is 17 multiplied by 23?\nReply with only the number.` Require the answer text to be exactly `391`; a sentence containing 391 is a formatting failure.
3. Complete final same-session failure/recovery and live streaming qualification. Deterministic tests alone do not establish these.
4. Finish `execution-results.csv` with the requested 19 columns, `FINAL-REPORT.md`, and per-case 20-area outcomes. Use `unknown` for missing telemetry. Do not relabel deterministic/mocked provider tests as real inference.
5. Preserve remaining A8 work in the main checkout, rerun focused tests only if source changes, and update ranked issues. No original standalone 20-test functional manifest was located; the new manifest explicitly maps the user's 20 named areas. Do not imply a separate historical suite was found or run.

## A8 evidence and continuation

Worktree: `/private/tmp/wazir-repair-a8`, branch `repair/runtime-verification`. It contains an uncommitted reusable driver `tests/wazir-functional/live-pty.py` and `functional/` evidence/projects/homes. Its own cherry-pick hashes differ from main; prefer merging specific new evidence commits or copying only new artifacts, not replaying all integrated fixes.

Useful paths:

- `functional/evidence/cpp-quicksort-summary.json`
- `functional/evidence/cpp-quicksort-transcript.ansi`
- `functional/evidence/cpp-quicksort-independent.json`
- `functional/evidence/cpp-quicksort-independent/` (generated source and verification)
- `functional/evidence/python-merge-binary-spec.json`
- `functional/evidence/python-merge-binary-driver.json` (may be empty until the driver exits)
- `functional/evidence/arithmetic-pty.json` (exploratory pre-planner-fix run)
- `functional/homes/` (isolated durable Wazir execution/job records)

A8 was asked to checkpoint, not start further live jobs, and retain/finish or safely cancel only its own active bounded Python run. Check its final status before resuming to avoid two processes sharing the local model. Parent's baseline PTY session exited cleanly with `/exit`; no parent live job remains.

Run from the main checkout:

```sh
npm run build:cli
node tests/wazir-functional/run.mjs --run --no-build
```

Live commands must use an isolated `WAZIR_HOME` and project, remove hosted API credentials from the child environment, and route `LOCAL_ONLY` with resident Gemma. Sandbox localhost failures require escalation; they are not evidence the runtime is unavailable. LM Studio last reported Gemma loaded at **8192** tokens, although its advertised maximum is **262144**. Do not load the unloaded Qwen models without admission evidence. Do not print credentials.

## Unconfirmed symptom details

The reported exact `8609` output reserve was not reproduced in current source. Inspected defaults were 4096/8000; the former percentage branch cannot yield 8609. Never state an invented exact trace. Historical `0.1 GiB` telemetry is also unavailable: current measurements show low immediately free memory, plus reclaimable memory. The natural-language `Tip: Use !...` string is absent from current source; existing literal-command recognition excludes natural-language requests.
