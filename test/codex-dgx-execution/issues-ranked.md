# Phase 4 — Ranked Defects & Repair Plan (`issues-ranked.md`)

All defects discovered during Phase 1–4 are ranked below by severity and impact on the 5 mission priorities:
1. Successful and correct task execution
2. Responsive, understandable terminal interaction
3. Accurate execution observability
4. Minimum end-to-end turnaround time
5. Reliable recovery and handoff

---

## Defect #1 (Rank 1 — P0 Blocker): Stale File-Lock Deadlock (`store.ts`) & 12.5s–18.5s Startup Probe Overhead (`modelLifecycleService.ts`, `lmstudio/index.ts`)

- **Severity:** **P0 — Critical Execution & Recovery Blocker**
- **Impact:**
  - Caused **9 of 20 baseline task attempts** (`C01 a2`, `C03 a1/a2`, `C04 a2`, `C06 a2`, `C07 a2`, `C09 a1/a2`, `C10 a2`) to crash at `11.0s` with `Error: timed out waiting for lock '/home/wael/.wazir/wazir.json.lock' (held for over 10000ms)`.
  - Caused **5 of 20 baseline task attempts** (`C02 a2`, `C04 a1`, `C05 a2`, `C08 a2`, `C10 a1`) to exceed the 20s `FIRST_TOKEN_TIMEOUT` ceiling before the first token could be emitted.
- **Root Cause (Exact Files & Lines):**
  1. `packages/shared/src/store.ts:28-29, 70-88`: `LOCK_MAX_WAIT_MS = 10_000` (10s) is **smaller** than `LOCK_STALE_AFTER_MS = 30_000` (30s). Inside `withFileLock()`, `liveForeignHolder(lockFile)` is only checked inside `if (old)` (`age > 30_000`). When a CLI process is killed (`SIGTERM`/`SIGINT`) while writing the 32MB `wazir.json`, its PID is immediately dead (`ESRCH`), but `withFileLock()` refuses to check `liveForeignHolder()` for 30 seconds and crashes after 10 seconds!
  2. `packages/runtimes/lmstudio/src/index.ts:135-153`: `LMStudioAdapter.healthCheck()` always spawns the `lms ls` CLI subprocess (`650ms`) before calling the fast HTTP `/api/v1/models` endpoint (`12ms`).
  3. `apps/cli/src/engine.ts:471` & `packages/core/src/services/modelLifecycleService.ts:175-232`: `createEngine()` runs `discoverAndReconcile({ verify: true })` on every single `wa run` / `wa chat` invocation, which calls `probeModel()` (`POST /v1/chat/completions`) sequentially on **all 3 loaded models** (including slow reasoning models `qwen/qwen3.8-27b` and `nvidia/nemotron-3-nano-omni`), burning 4–6 seconds before the user's task even starts.
  4. `packages/core/src/services/modelLifecycleService.ts:363-372, 481`: `estimateTarget()` spawns `lms load <model> --estimate-only` (`1.5s`) even when `reuse === true` (the model is already `READY` in memory with sufficient context), and `performLoad()` runs `this.verify()` a second time when `plan.reuse === true`.
- **Bounded Repair Plan (Defect #1):**
  - In `packages/shared/src/store.ts`: Check `liveForeignHolder(lockFile)` whenever `age > 100` ms (grace window for atomic write of lock metadata) so locks held by dead PIDs (`ESRCH`) are broken immediately (`<150ms`) instead of waiting 30s and crashing at 10s.
  - In `packages/runtimes/lmstudio/src/index.ts`: In `healthCheck()`, query HTTP `this.nativeModels()` first (`~12ms`) and only fall back to spawning `lms ls` if HTTP fails.
  - In `packages/core/src/services/modelLifecycleService.ts`:
    - During `reconcileObserved()`, trust `nativeModels()` `loaded_instances` state for already-loaded models unless an explicit target verification is requested, avoiding sequential `/v1/chat/completions` probes on unrelated resident models during startup.
    - In `estimateTarget()`, when `reuse === true` (model is already loaded and context suffices), return a direct zero-cost reuse estimate without spawning `lms load --estimate-only`.
    - In `performLoad()`, when `plan.reuse === true` and existing state is already `READY`, skip redundant `probeModel()` or only fast-verify if not previously verified.

---

## Defect #2 (Rank 2 — P0 Blocker): Unconditional Multi-Turn Coding Loop & Repo-Wide `build`/`test`/`lint` Verification on Non-Mutating Prompts (`codingAgent.ts`, `run.ts`)

- **Severity:** **P0 — Critical Task Execution & Turnaround Blocker**
- **Impact:**
  - Caused **all remaining baseline tasks** (`C01 a1`, `C02 a1`, `C05 a1`, `C06 a1`, `C07 a1`, `C08 a1`) to time out at the 45s `WALL_TIMEOUT` ceiling even though `gemma-4-26b-a4b-it-qat` generated the correct answer (`"42"`, `"READY"`, etc.) in **1.4s–1.8s**!
- **Root Cause (Exact Files & Lines):**
  1. `packages/agents/src/codingAgent.ts:1544-1695`: `CodingAgent.execute()` forces a multi-phase `plan` -> `implement` loop even when the model returns a complete, direct answer on Turn 1 without requesting any file edits or shell commands.
  2. `packages/agents/src/codingAgent.ts:1744-1785`: In `VERIFY`, `const mutationRequired = request.mutationRequired ?? !groundedResearch;` defaults to `true` for every `wa run` prompt! When a prompt asks a question, requests a code snippet in stdout, or performs a read-only inspection (`filesChangedSet.size === 0` and `expectedFiles.length === 0` and `expectedArtifacts.length === 0`), `CodingAgent`:
     - Marks `'Agent declared completion but produced no code modifications.'` as a verification failure, AND
     - Runs repo-wide `npm run build`, `npm run test`, `npm run lint`, and `npm run typecheck` across the entire Wazir repository (taking 35–60+ seconds)!
- **Bounded Repair Plan (Defect #2):**
  - In `packages/agents/src/codingAgent.ts`:
    - When Turn 1 (`plan` phase) returns `done: true` with zero tool calls (`fileEdits.length === 0 && commands.length === 0 && toolCalls.length === 0`) and a non-empty `summary`, and no `expectedFiles`/`expectedArtifacts` were requested (`!request.mutationRequired`), complete immediately after Turn 1 without forcing a redundant Turn 2 `implement` call.
    - In `VERIFY`, only require file mutations (`mutationRequired`) when `request.mutationRequired === true` or `expectedFiles.length > 0` or `expectedArtifacts.length > 0`.
    - In `VERIFY`, skip repo-wide `build`/`test`/`lint`/`typecheck` verification commands when `filesChangedSet.size === 0` and `executedCommands.length === 0` (no workspace files or state were mutated).
    - Stream or emit the final `modelSummary` to `request.onDelta` when no streaming chunks were emitted during JSON action parsing so CLI and TUI consumers receive first-token and response output promptly.

---

## Defect #3 (Rank 3 — P1 High): TUI Startup Clarity, Active Model Header & CLI JSON Lifecycle Observability (`conversationRenderer.ts`, `fleetTui.ts`, `run.ts`)

- **Severity:** **P1 — High Usability & Observability Defect**
- **Impact:**
  - `wa chat` hides the ready instructions, shows `auto-routed model` instead of the pinned model `gemma-4-26b-a4b-it-qat`, and gives no indication of how to submit (`Enter`), cancel (`Esc`), or exit (`/exit`).
  - `wa run --json` drops `execution.prepared`, `generation.started` (`dispatch`), and `first_token` events, leaving callers blind to startup vs. inference latency.
- **Root Cause (Exact Files & Lines):**
  1. `apps/cli/src/tui/conversationRenderer.ts:64-65`: Explicitly suppresses `idleStatus` and renders a bare 2-line header without startup guidance.
  2. `apps/cli/src/tui/fleetTui.ts:1800, 5253`: Constructs `ConversationRenderer` before `selectedModelId` is resolved from `--model` or runtime discovery, and never updates `conversation.setModel()`.
  3. `apps/cli/src/run.ts:431-475`: Subscribes to `engine.events` but ignores `execution.prepared` and `generation.started` when `options.json` is enabled, and never emits a `first_token` event when the first delta arrives.
- **Bounded Repair Plan (Defect #3):**
  - In `apps/cli/src/tui/conversationRenderer.ts` & `apps/cli/src/tui/fleetTui.ts`:
    - Add `setModel(model: string)` to `ConversationRenderer` and update it once `selectedModelId` or the active ready model is resolved.
    - Render clear, concise startup banner in `ConversationRenderer.start()` showing: what Wazir does, the active model (`gemma-4-26b-a4b-it-qat`), readiness status, and key controls (`Enter` to send, `Esc` to cancel, `/help` for commands, `/exit` to quit).
  - In `apps/cli/src/run.ts`:
    - Emit structured NDJSON events in `--json` mode for `dispatch` (when `generation.started` fires), `first_token` (when the first delta/chunk arrives), and `step`/`verification` progress, plus structured JSON error output if a startup/lock error occurs in `--json` mode.
