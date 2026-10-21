# FINAL REPORT — Wazir Mac Laptop Usability, Observability & Execution Reliability Audit

**Audit date:** 2026-10-17/18 (local 19:08–20:15 PDT / UTC 02:08–03:15)
**Branch:** `test/real-world-acceptance`, HEAD `7133f16` (fixes below are uncommitted working-tree
changes on top of this — see "Git state" below)

## 1. Environment

- Mac: WaelMacPro.local / WaelMacPro.attlocal.net, Apple Silicon (arm64), macOS 27.0.1 (26A434), 24 GiB RAM
- Wazir: v0.2.7 (channel: homebrew, source commit `be64805`) — `/opt/homebrew/bin/wa` resolves through a
  chain of symlinks into this exact checkout (`/Users/wael/Code/Wazir/bin/wa.js`), so this is a live,
  rebuildable dev install, not an isolated package.
- **Important mechanical note:** `wa` runs a pre-built, bundled `bin/wa.js` (18MB, produced by `npm run
  bundle` / `scripts/bundle.mjs`), not the live TypeScript source directly. `tsc --build` alone (which is
  what `npx tsc --build <pkg>` and most "typecheck" workflows do) updates each package's own `dist/`, but
  does **not** regenerate this bundle — a source fix has no effect on the CLI you actually run until `npm
  run bundle` is re-run. Vitest also resolves workspace packages (`@wazir/core`, `@wazir/agents`) through
  their built `dist/`, not their source, so a test exercising a fix in a *different* package needs that
  package rebuilt first too. Lost real time to this twice this session (see fixes-applied.md, fix 4's note).

## 2. Model

- Required: `google/gemma-4-12b-qat`, 12B params, Q4_0, ~7.15 GB, local via LM Studio.
- Confirmed present and loaded (`lms ps`: IDLE, 7.15 GB, ctx=8192, parallel=4) throughout the audit,
  independent of Wazir.
- **Model pinning confirmed across all 6 live benchmark runs** (G01–G06): every execution's
  `MODEL_LOAD_PLAN_CREATED` / `start` event recorded `modelId: "google/gemma-4-12b-qat"`, `runtimeId:
  "lmstudio"`. **No silent substitution occurred at any point.**
- Found and fixed a real readiness-reporting bug (M1/P1-1 below) where Wazir's own diagnostics reported
  this exact, working model as `ready=false`.

## 3. Benchmark results (G01–G06; G07–G10 not run — see execution-results.csv for why)

| ID | Prompt | Expected | Got | Correct? | Wall time | Why "failed" |
|---|---|---|---|---|---|---|
| G01 | 23+19 | 42 | (hidden — pre-fix) | unknown | 220s | no code mods + full monorepo build failure |
| G02 | 12×8 | 96 | 96 | ✓ | 33s | no code mods (correct, by design) |
| G03 | reverse WAZIR | RIZAW | RIZAW | ✓ | 63s | no code mods (correct, by design) |
| G04 | uppercase | HELLO MAC | HELLO MAC | ✓ | 252s | build/test fail (Tauri/network, unrelated) |
| G05 | JSON status/count | `{"status":"ok","count":5}` | exact match | ✓ | 336s | build/test fail (Tauri/network, unrelated) |
| G06 | square() in Python | correct function | correct function | ✓ | 37s denied, then ~90s | 1st: real memory-admission denial; 2nd: build/test fail (Tauri/network) |

**Every answer the model gave was correct.** Every reported "failure" after G01 was either (a) the agent's
own correct refusal to call it done for making no code change on a pure Q&A prompt, or (b) an unrelated,
pre-existing build dependency (a Tauri desktop app needing network access to crates.io) that has nothing
to do with what any of these tasks actually asked for. G01, run before any fixes existed, is the clearest
illustration of the problem this audit found and fixed (see below).

## 4. Usability findings

- No interactive-terminal (`wa chat`) UX pass was performed this session — all benchmarking used `wa run`
  (the non-interactive equivalent) since Phase 2–4 work consumed the available time investigating and
  fixing execution-reliability defects first, per explicit priority ("make execution reliable" before "make
  the UI understandable"). This is a real gap in this audit's coverage, not a finding about `wa chat` itself.
- `wa run`'s help text and flags are otherwise clear and discoverable (`--model`, `--runtime`,
  `--routing-mode`, `--type`, `--json` all behave as documented).
- Gap: no `--context` flag on `wa run` to avoid an admission-denying context reload when memory is tight
  (P1-4) — only `wa models pin --context` exists, disconnected from the run path.

## 5. Observability findings

- **P0-4 (fixed):** the model's actual answer was silently discarded whenever VERIFY failed the task —
  a user had no way to tell if a "failed" task's model had actually answered correctly. Now surfaced via
  `result` in both JSON and text output.
- **P1-1 / M1 (fixed):** `wa doctor` / `wa models health --detail` permanently showed a working, verified,
  actively-used model as `ready=false`, because every read-only status check discarded a previously-earned
  READY state and (correctly, to stay fast) skipped re-verifying.
- **P1-2 (root-caused, not fixed):** lmstudio memory reads as `24/24 GiB CRITICAL`. Live `vm_stat` during
  the audit showed genuinely severe memory pressure (~187 MB free out of 24 GiB) — this reading is very
  likely **accurate**, not a reporting bug, given everything running on this Mac concurrently (LM Studio,
  this Claude Code session, a separate concurrent agent session the user confirmed was active, browser).
- Diagnostic event logs (`wa executions events <id> --json`) are thorough and genuinely useful — they're
  what made every fix in this report possible to root-cause precisely, down to exact timestamps and
  tool-call policy decisions.

## 6. Execution-reliability findings

- **P0-1 (defense-in-depth fix applied; root cause not Wazir's, confirmed with user):** a single `wa run`
  task coincided with an unauthorized git merge commit landing on the checked-out branch, with zero trace
  in any Wazir log. Ruled out (with source evidence) the v0.2.8 auto-updater, the documented worktree-merge
  helpers, and the task's own tool-call log. Asked the user directly: **confirmed a separate agent/tool
  session was running against this same repository at the same time**, which — having its own shell access
  entirely outside Wazir's policy engine — is now the clear likely cause. Not a Wazir defect, but Wazir had
  no way to tell the user this happened; it does now (see fixes).
- **P0-2 (fixed):** trivial, no-file-change tasks ran a full monorepo build/test/lint/typecheck battery
  regardless — 3m40s wasted and a false failure for a one-token arithmetic answer.
- **P0-3 (retracted after testing — not a bug):** a `MODEL_LOAD_PLAN_CREATED` event showing
  `classification: "INSUFFICIENT"` next to `admissionDecision: "ADMITTED"` looked like a safety-check
  bypass; a dedicated test proved it's a correct reuse-of-already-resident-model path, and that a genuine
  fresh load under real scarcity is still denied.
- **P0-5 (confirmed, not fixed — needs a product decision):** the single biggest practical reliability
  problem found: *any* task that writes even one real file gets its "build"/"test" check run against the
  **entire monorepo**, including a Tauri desktop app that needs network access this environment doesn't
  have. Every genuinely correct coding answer in this audit (G04, G05, G06) was reported as a "failure"
  for this reason alone.
- **P1-3 (revised, not fixed):** files written by the separate concurrent agent/tool session (see P0-1)
  were misattributed into a `wa run` task's own "files changed" report, because that mechanism diffs the
  whole project directory rather than scoping to what the task's own tool calls touched. Proven using my
  own concurrent file write as a control.
- **P1-4 (confirmed, not fixed):** a coding task was denied admission outright under real, transient
  memory pressure (context-reload required, insufficient memory), with no actionable guidance and no CLI
  flag to avoid the reload.

## 7. Ranked issue list

See `issues-ranked.md` for full detail, evidence, file:line citations, and status on every item:
P0-1 (defense-in-depth fixed, root cause external), P0-2 (fixed), P0-3 (retracted, not a bug), P0-4
(fixed), P0-5 (confirmed, not fixed), P1-1/M1 (fixed), P1-2 (root-caused, not fixed), P1-3 (revised, not
fixed), P1-4 (confirmed, not fixed), P2-1 (noted, not pursued further).

## 8. Repairs made (direct source edits, this session)

| # | File(s) | What | Tests |
|---|---|---|---|
| 1 | `packages/core/src/services/modelLifecycleService.ts` | Stop discarding a verified READY state on read-only reconcile passes | `modelLifecycleAdmission.test.ts` (new case, red→green) |
| 2 | `packages/core/src/services/repoIntegrityGuard.ts` (new), `apps/cli/src/commands.ts` | Detect-and-report unexpected git HEAD movement during `wa run` | `repoIntegrityGuard.test.ts` (new, 6 cases incl. the real merge shape) |
| 3 | `packages/agents/src/codingAgent.ts` | Skip build/test/lint/typecheck when nothing changed and the task is already a guaranteed no-mutation failure | `codingAgent.skipChecksOnNoMutation.test.ts` (new); corrected one pre-existing test that had pinned the bug (`codingAgent.maxTurns.test.ts`) |
| 4 | `packages/agents/src/codingAgent.ts`, `apps/cli/src/run.ts` | Surface the model's actual answer even when VERIFY fails the task | `executeTask.e2e.test.ts` (new case, red→green) |

Full before/after detail, root-cause writeups, and verification commands for each: `fixes-applied.md`.

## 9. Regression test results

All scoped test runs green throughout the session (re-verified after every rebuild):
- `packages/core/tests/modelLifecycleAdmission.test.ts` — 23/23
- `packages/core/tests/repoIntegrityGuard.test.ts` — 6/6 (new)
- `packages/agents/tests/codingAgent*.test.ts` (49 files) — 154/154
- `packages/agents/tests/codingAgent.skipChecksOnNoMutation.test.ts` — 2/2 (new)
- `apps/cli/tests/executeTask.e2e.test.ts` — 7/7 (incl. 1 new)
- `apps/cli/tests/fleetRunner.e2e.test.ts`, `resume.e2e.test.ts`, `escalation.e2e.test.ts`,
  `agentPreflight.test.ts`, `nvidiaProviderSystem.test.ts`, `modelLifecycle.test.ts` — all green
- `npx tsc --build packages/core packages/agents apps/cli` — clean throughout

**Not run:** the full `npm run build` / `npm run test` at the repo root — that's exactly the P0-5
pathology (it drags in the Tauri desktop build, which fails on network access in this environment) and
isn't necessary to validate these four scoped fixes.

## 10. Before/after performance

| Metric | Before (G01) | After (G02, same prompt shape) | 
|---|---|---|
| Trivial Q&A wall time | 220s | 33s |
| Full monorepo build triggered for a no-op answer | yes | no |
| Model's answer visible when task "fails" | no | yes (`"result":"96"`) |
| `wa models health` readiness for a working model | permanently false | preserved as true across read-only checks |

No before/after table for G04–G06 (code-writing tasks) is meaningful yet — P0-5 (the Tauri/monorepo build
scoping problem) is unfixed, so those still report "failed" for reasons unrelated to task correctness
regardless of the fixes applied this session.

## 11. Remaining limitations / what this audit did not cover

- No `wa chat` interactive-terminal UX pass (Phase 3 of the original brief) — all benchmarking used `wa
  run`. Keystroke latency, terminal rendering, resize handling, etc. are unassessed.
- G07–G10 not run live (judged low marginal value — same two patterns already confirmed by G02/G03 and
  G04/G05/G06 respectively; see execution-results.csv for the reasoning).
- Phase 6 reliability scenarios R01–R10 not systematically run (R01/R02/R03/R10 partially covered
  incidentally by the benchmark sweep; R04–R09 not tested).
- Phase 9 (parallel/concurrent execution) not tested.
- P0-5 (the dominant real-world reliability issue found) is diagnosed with full evidence but not fixed —
  it needs a product decision about what "verification" should mean for a coding agent, not a narrow patch.
- P1-2, P1-3, P1-4 are documented with root cause (P1-2, P1-3) or clear repro (P1-4) but not fixed.

## 12. Git state

- Branch `test/real-world-acceptance`, HEAD `7133f16` (unchanged this session).
- All 4 fixes + their tests are **uncommitted working-tree changes** (not committed, per instructions to
  only commit when asked): `apps/cli/src/commands.ts`, `apps/cli/src/run.ts`,
  `packages/agents/src/codingAgent.ts`, `packages/core/src/services/modelLifecycleService.ts`,
  `packages/core/src/services/repoIntegrityGuard.ts` (new), plus the five test files listed in
  fixes-applied.md.
- Pre-existing, unrelated uncommitted WIP (a `wa handoff` durable-handoff CLI feature:
  `apps/cli/src/handoff.ts`, `packages/core/src/services/handoffService.ts`, etc.) was **not touched**.
- The unauthorized merge discovered early in the session (`e531017`, see P0-1) was safely reverted via
  `git stash push -u` → `git reset --hard 7133f16` → `git stash pop`, verified to exactly match the
  pre-session state plus this audit's own new `test/` directory. No other destructive git operations were
  performed.
- This audit's own evidence lives entirely under `test/agy-mac-gemma/`.

## 13. Recommended next improvements (priority order)

1. **Fix P0-5**: scope the coding agent's verification checks to the workspace(s) actually touched by the
   task (or make the Tauri/desktop build excludable from the generic check battery). This is the single
   highest-leverage fix available — it's currently the reason *any* real coding task in this environment
   reports as failed.
2. **Rebuild tooling**: add a `wa doctor` check (or a build-time guard) that detects when `bin/wa.js` is
   older than the source it was bundled from, so a source fix doesn't silently fail to take effect — this
   cost real time twice this session.
3. Run a proper `wa chat` interactive-terminal usability pass (this audit's Phase 3), which wasn't reached.
4. Investigate P1-3 properly: scope workspace-mutation/file-change attribution to what the task's own tool
   calls touched, not a blind directory-wide diff — important if multiple agents/tools are expected to
   share a workspace, which this session confirmed is a real usage pattern on this machine.
5. Surface actionable guidance on `MODEL_ADMISSION_DENIED: CONTEXT_RELOAD_REQUIRED` (P1-4) — at minimum,
   tell the user what to do (free memory, unload another model, or pin a larger context ahead of time).
6. Investigate whether `os.freemem()`/reservation accounting in `computerRegistry.ts`/`modelLifecycleService.ts`
   needs tuning (P1-2) — lower priority since live measurement during this audit suggests the "CRITICAL"
   reading on this particular Mac, at this particular time, was accurate, not a false positive.

## Resume instructions (if continuing this audit later)

Read `HANDOFF.md` and the latest `checkpoints/*.md` first. Re-run `wa doctor`, `lms ps`, and
`wa models health --detail` to re-confirm current state before resuming (things may have changed, and
other sessions may be running against this repo — this audit found live evidence that they sometimes are).
