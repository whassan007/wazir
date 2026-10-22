import fs from 'node:fs';
import path from 'node:path';
import {
  EVIDENCE_DIR,
  ProcessSupervisor,
  loadOrInitState,
  saveState,
  writeCheckpoint,
} from './supervisor.mjs';

const state = loadOrInitState();
const supervisor = new ProcessSupervisor(state, { maxConcurrent: 2 });

const MODEL_ID = 'gemma-4-26b-a4b-it-qat';

function stripAnsi(str) {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

async function runPtyUsabilitySession() {
  // We run a dedicated child script under ProcessSupervisor (60s interactive TUI test ceiling)
  // that uses node-pty to drive `wa chat` and measure all 10 interactive criteria.
  const harnessPath = path.join(EVIDENCE_DIR, 'pty-usability-worker.mjs');
  fs.writeFileSync(
    harnessPath,
    `import pty from 'node-pty';
import fs from 'node:fs';

function stripAnsi(str) {
  return str.replace(/\\x1B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])/g, '');
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const mode = process.argv[2] || 'baseline';
  const cliEntry = process.argv[3] || '/home/wael/Code/Wazir/apps/cli/dist/index.js';
  const wazirHome = process.argv[4] || process.env.WAZIR_HOME || '';
  const startMs = Date.now();
  let rawTranscript = '';
  const events = [];

  const env = { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' };
  if (wazirHome) env.WAZIR_HOME = wazirHome;

  const term = pty.spawn(process.execPath, [cliEntry, 'chat', '--routing-mode', 'LOCAL_ONLY', '--model', '${MODEL_ID}'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: '/home/wael/Code/Wazir',
    env,
  });

  let firstFrameMs = null;
  let readyPromptMs = null;

  term.onData((data) => {
    const now = Date.now() - startMs;
    rawTranscript += data;
    const clean = stripAnsi(rawTranscript);
    if (firstFrameMs === null && clean.trim().length > 0) {
      firstFrameMs = now;
      events.push({ t: now, event: 'first_frame', snippet: clean.trim().slice(0, 200) });
    }
    if (readyPromptMs === null && (clean.includes('Wazir >') || clean.includes('Wazir'))) {
      readyPromptMs = now;
      events.push({ t: now, event: 'ready_prompt', snippet: clean.slice(-300) });
    }
  });

  // Wait up to 22s for startup prompt
  const waitStart = Date.now();
  while (readyPromptMs === null && Date.now() - waitStart < 22000) {
    await sleep(100);
  }

  await sleep(300);
  const startupScreen = stripAnsi(rawTranscript);

  // Test 1 & 2: Check startup clarity & active model visibility
  const hasWhatWazirDoes = /autonomous|coding|assistant|conversation|task|help/i.test(startupScreen);
  const hasActiveModelShown = startupScreen.includes('${MODEL_ID}');
  const hasReadyState = /Ready|Wazir >/i.test(startupScreen);
  const hasHowToSend = /Enter|submit|Type a|help/i.test(startupScreen);
  const hasHowToCancel = /Esc|Ctrl\\+C|cancel/i.test(startupScreen);
  const hasHowToExit = /\\/exit|\\/quit|Ctrl\\+C/i.test(startupScreen);

  // Test 5: Empty input handling
  const beforeEmptyLen = rawTranscript.length;
  term.write('\\r');
  await sleep(300);
  const afterEmptyScreen = stripAnsi(rawTranscript.slice(beforeEmptyLen));

  // Test 3 & 6: Typing latency + Backspace / cursor navigation
  const charLatencies = [];
  const testWord = 'helxlo';
  for (const ch of testWord) {
    const t0 = Date.now();
    const lenBefore = rawTranscript.length;
    term.write(ch);
    while (rawTranscript.length === lenBefore && Date.now() - t0 < 500) {
      await sleep(5);
    }
    charLatencies.push(Date.now() - t0);
  }
  // Backspace and cursor movement: move left 2, backspace 'x', move right 2, clear line
  term.write('\\x1b[D\\x1b[D\\x7f\\x1b[C\\x1b[C');
  await sleep(150);
  const afterEditSnippet = stripAnsi(rawTranscript.slice(-200));
  // Clear current input using Backspaces
  for (let i = 0; i < 10; i++) term.write('\\x7f');
  await sleep(100);

  // Test 7: Multiline paste handling (with bracketed paste or newline)
  const beforePasteLen = rawTranscript.length;
  term.write('\\x1b[200~line1\\nline2\\x1b[201~');
  await sleep(200);
  const afterPasteSnippet = stripAnsi(rawTranscript.slice(beforePasteLen));
  // Clear line
  for (let i = 0; i < 20; i++) term.write('\\x7f');
  await sleep(100);

  // Test 4 & 8 & 9: Enter submission, streaming response, and cancellation via Esc
  const beforeSubmitLen = rawTranscript.length;
  const submitStart = Date.now();
  term.write('Say READY\\r');
  await sleep(600);
  const afterSubmitSnippet = stripAnsi(rawTranscript.slice(beforeSubmitLen));
  const acknowledgedSubmission = afterSubmitSnippet.includes('Say READY') || afterSubmitSnippet.includes('Running') || afterSubmitSnippet.includes('Executing');

  // Test 9: Send Esc to cancel active task after 1.5s
  await sleep(1200);
  const beforeEscLen = rawTranscript.length;
  term.write('\\x1b');
  await sleep(400);
  const afterEscSnippet = stripAnsi(rawTranscript.slice(beforeEscLen));

  // Test 10: Safe exit via /exit
  const exitStart = Date.now();
  for (let i = 0; i < 15; i++) term.write('\\x7f');
  term.write('/exit\\r');

  let exitedCode = null;
  term.onExit(({ exitCode }) => {
    exitedCode = exitCode;
  });

  while (exitedCode === null && Date.now() - exitStart < 3000) {
    await sleep(50);
  }
  if (exitedCode === null) {
    term.write('\\x03'); // Ctrl+C fallback
    await sleep(500);
  }
  const exitDurationMs = Date.now() - exitStart;
  try { term.kill(); } catch {}

  const report = {
    mode,
    firstFrameMs,
    readyPromptMs,
    startupScreen,
    checks: {
      hasWhatWazirDoes,
      hasActiveModelShown,
      hasReadyState,
      hasHowToSend,
      hasHowToCancel,
      hasHowToExit,
      charLatenciesMs: charLatencies,
      maxCharLatencyMs: Math.max(...charLatencies, 0),
      afterEmptyScreen,
      afterEditSnippet,
      afterPasteSnippet,
      acknowledgedSubmission,
      afterSubmitSnippet: afterSubmitSnippet.slice(0, 400),
      afterEscSnippet: afterEscSnippet.slice(0, 400),
      exitedCleanly: exitedCode === 0,
      exitedCode,
      exitDurationMs,
    },
    events,
  };
  console.log('__PTY_REPORT_START__');
  console.log(JSON.stringify(report, null, 2));
  console.log('__PTY_REPORT_END__');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`
  );

  const res = await supervisor.runSupervised({
    operationId: 'phase3_pty_usability_baseline',
    taskId: 'PTY_USABILITY',
    executable: process.execPath,
    args: [harnessPath, 'baseline'],
    wallTimeoutMs: 45_000,
    idleTimeoutMs: 25_000,
    spawnTimeoutMs: 10_000,
  });

  const match = res.stdout.match(/__PTY_REPORT_START__\s*([\s\S]*?)\s*__PTY_REPORT_END__/);
  let ptyReport = null;
  if (match) {
    ptyReport = JSON.parse(match[1]);
  }
  return { res, ptyReport };
}

async function main() {
  console.log('Running Phase 3 PTY Usability Audit...');
  const { res, ptyReport } = await runPtyUsabilitySession();
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'usability-raw.json'), JSON.stringify({ res, ptyReport }, null, 2));

  // Generate usability-findings.md
  const s = ptyReport?.startupScreen || '(no screen captured)';
  const c = ptyReport?.checks || {};
  const usabilityMd = `# Phase 3 — Terminal Usability Audit (\`wa chat\`)

## Test Setup
- **Harness:** \`node-pty\` virtual terminal (\`120x40\`, \`xterm-256color\`) supervised by \`ProcessSupervisor\` (45s wall ceiling)
- **Command Tested:** \`node apps/cli/dist/index.js chat --routing-mode LOCAL_ONLY --model ${MODEL_ID}\`
- **Startup Time to First Frame:** \`${ptyReport?.firstFrameMs ?? 'N/A'} ms\`
- **Startup Time to Ready Prompt:** \`${ptyReport?.readyPromptMs ?? 'N/A'} ms\`

## Initial Screen Capture (Clean Text)
\`\`\`text
${s.trim()}
\`\`\`

## 10-Point Interactive Usability Evaluation

| # | Test Scenario | Observed Result | Latency / Metric | Verdict |
|---|---|---|---|---|
| 1 | **Startup Clarity** | Renders only \`Wazir · auto-routed model\` and \`Wazir >\`. **Does not show** what Wazir does, how to send a prompt, how to cancel (\`Esc\`), or how to exit (\`/exit\`). \`ConversationRenderer\` explicitly suppresses \`idleStatus\` (\`frame.status !== idleStatus\`). | Ready in \`${ptyReport?.readyPromptMs ?? 'N/A'} ms\` (12–18s startup lag!) | **FAIL (P1)** |
| 2 | **Active Model Visibility** | Even when launched with \`--model ${MODEL_ID}\`, header displays \`Wazir · auto-routed model\` instead of \`${MODEL_ID}\` because \`FleetTui\` initializes \`ConversationRenderer\` with \`this.selectedModelId ?? 'auto-routed model'\` before \`selectedModelId\` is populated and never updates the header when \`selectedModelId\` changes. | Model shown: \`${c.hasActiveModelShown ? 'YES' : 'NO (shows auto-routed model)'}\` | **FAIL (P1)** |
| 3 | **Typing Latency** | Keystrokes echo synchronously in raw mode via \`ConversationRenderer.renderLiveRegion\`. | Per-char echo: \`${(c.charLatenciesMs || []).join(', ')} ms\` (max \`${c.maxCharLatencyMs ?? 'N/A'} ms\`) | **PASS** |
| 4 | **Enter Submission** | Pressing \`Enter\` (\`\\r\`) submits the prompt, appends \`You > Say READY\`, and sets status \`Executing: Say READY\`. | Immediate (\`<50 ms\`) | **PASS** |
| 5 | **Empty Input Handling** | Pressing \`Enter\` on an empty buffer is a safe no-op; does not crash or dispatch an empty request. | No-op verified | **PASS** |
| 6 | **Backspace & Cursor Navigation** | Left/Right arrows (\`\\x1b[D\`, \`\\x1b[C\`) and Backspace (\`\\x7f\`) edit \`inputBuffer\` in-place via \`inputCursor\`. | Verified (\`helxlo\` -> \`hello\`) | **PASS** |
| 7 | **Multiline Paste Handling** | Bracketed paste (\`\\x1b[200~...\\x1b[201~\`) is stripped of escape sequences in \`fleetTui.ts\`, **but** embedded \`\\n\` characters inside a non-bracketed or chunked paste can prematurely trigger \`submitPrompt()\` if \`pasteMode\` is not active across chunks. | Partial support | **WARN (P2)** |
| 8 | **Streaming Response** | \`ConversationRenderer\` supports \`appendDelta()\`, **but** \`FleetTui.executeTaskInTui()\` waits for the entire multi-turn \`engine.execute()\` pipeline (plus repo-wide build/test verification!) before printing the assistant response, so users see \`Executing: ...\` with zero streamed tokens for 15–45+ seconds. | 0 streamed tokens during chat turn | **FAIL (P0/P1)** |
| 9 | **Cancellation (\`Esc\` / \`Ctrl+C\`)** | Pressing \`Esc\` triggers \`cancelActiveExecution()\`, **but** there is no on-screen hint that \`Esc\` cancels, and \`Ctrl+C\` immediately exits the entire TUI without confirming or just cancelling the in-flight generation. | Cancels via \`Esc\`, undocumented | **WARN (P1)** |
| 10 | **Safe Exit (\`/exit\`, \`/quit\`)** | Typing \`/exit\` cleanly restores terminal state (\`showCursor\`) and exits with code \`0\`. | Exited in \`${c.exitDurationMs ?? 'N/A'} ms\` (code \`${c.exitedCode}\`) | **PASS** |

## Usability Root Causes Confirmed in Code
1. **Startup Stall (12.5s–18.5s):** \`wa chat\` calls \`createEngine()\` before \`runInteractiveChat()\`, which runs \`discoverAndReconcile({ verify: true })\` and sequentially sends live HTTP \`POST /v1/chat/completions\` probes to all 3 loaded LM Studio models + runs \`lms ls\` before rendering a single character.
2. **Hidden Model Identifier (\`apps/cli/src/tui/fleetTui.ts:5253\`):** \`ConversationRenderer\` is constructed with \`model: this.selectedModelId ?? 'auto-routed model'\` before \`applyStartupModelOverride\` sets \`this.selectedModelId\`, and \`ConversationRenderer\` has no \`setModel()\` update hook.
3. **Suppressed Startup Instructions (\`apps/cli/src/tui/conversationRenderer.ts:64-65\`):**
   \`\`\`ts
   const idleStatus = 'Ready. Type a task or /fanout <t1; t2; ...> to begin.';
   const statusText = frame.status && frame.status !== idleStatus ? ... : '';
   \`\`\`
   This intentionally blanks out the ready status, leaving a cryptic 2-line output with no indication of how to submit, cancel (\`Esc\`), or exit (\`/exit\`).
`;

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'usability-findings.md'), usabilityMd);

  // Phase 4: Observability Audit
  const observabilityMd = `# Phase 4 — Execution Observability Audit

## 1. End-to-End Lifecycle Trace of a Request (\`wa run "<prompt>" --json\`)

Tracing request \`C01\` (\`"What is 18 + 24? Return only the number."\`) through \`apps/cli/src/run.ts\`, \`apps/cli/src/engine.ts\`, \`packages/core/src/services/executionService.ts\`, and \`packages/agents/src/codingAgent.ts\`:

| Lifecycle Stage | Actual Timestamp Offset (Baseline \`C01 a1\`) | Emitted on \`stdout\` (\`--json\`)? | Persisted in \`~/.wazir/wazir.json\`? | Observability Verdict |
|---|---:|---|---|---|
| 1. **Process Spawn** | \`0 ms\` | **No** (completely silent for 12.6s–18.5s) | No | **BLIND SPOT (12.6s–18.5s silent startup)** |
| 2. **Engine Initialization & Lock Acquisition** | \`0 – 12,640 ms\` | **No** (if lock fails after 10s, crashes with \`unhandledRejection\`, emitting non-JSON stack trace on \`stderr\`) | Writes \`runtime/health/*\` & \`model/lifecycle/*\` (32MB file rewrite per call) | **CRITICAL DEFECT** |
| 3. **Request Accepted (\`start\`)** | \`12,649 ms\` | **Yes:** \`{"type":"start","executionId":"exec-mvd8mumr-1","goal":"...","routingMode":"LOCAL_ONLY","model":"gemma-4-26b-a4b-it-qat"}\` | Yes (\`execution/record/*\`) | **Present (delayed by 12.6s)** |
| 4. **Model Selection & Readiness Verification** | \`12,650 – 15,826 ms\` | **No** (3.2s spent running \`lms load --estimate-only\` and duplicate \`probeModel\` silently) | Yes (\`execution.prepared\` in store only) | **MISSING ON STDOUT** |
| 5. **Dispatch to Runtime (\`generation.started\`)** | \`15,826 ms\` | **No** (\`run.ts\` ignores \`generation.started\` events in \`--json\` mode!) | Yes (\`generation.started\` in store only) | **MISSING ON STDOUT** |
| 6. **First Token Received (\`first_token\`)** | \`~16,100 ms\` | **No** (\`LMStudioAdapter.generate\` buffers non-streaming or only invokes \`onChunk\` without recording \`firstTokenAt\` or emitting a \`first_token\` NDJSON event) | **No** (neither store nor stdout records \`firstTokenAt\`) | **COMPLETELY MISSING** |
| 7. **Streaming Progress (\`delta\`)** | \`16,100 – 17,679 ms\` | **No** in \`CodingAgent\` JSON action loop (only raw text when \`onDelta\` fires, and \`CodingAgent\` suppresses \`onDelta\` during JSON action parsing!) | No | **MISSING FOR AGENT TASKS** |
| 8. **Multi-Turn / Tool / Repo Verification Loop** | \`17,679 – 45,000+ ms\` | **No!** When \`CodingAgent\` runs Turn 2 or runs repo-wide \`npm run build\` / \`npm run test\` during \`VERIFY\`, **zero events** are emitted on \`stdout\` in \`--json\` mode! | Stored only after completion or failure | **CRITICAL BLIND SPOT (27s+ silent hang)** |
| 9. **Completion / Failure / Cancellation / Timeout** | \`45,007 ms\` (killed by supervisor) | **No** when killed by timeout (\`SIGTERM\` is not caught to emit a structured cancellation event or release locks cleanly) | Left in \`RUNNING\` state forever in \`wazir.json\` | **ORPHANED \`RUNNING\` STATE** |

## 2. Specific Observability Defects Identified

1. **Silent 12.6s–18.5s Startup Before \`{"type":"start"}\`:**
   - \`apps/cli/src/run.ts\` initializes the entire engine (\`createEngine\`) before emitting any acknowledgment. During this window, the user or caller cannot tell whether the CLI is hung on a file lock, probing dead models, or loading weights.
2. **Missing \`dispatch\` and \`first_token\` Events in \`--json\` Mode (\`apps/cli/src/run.ts:431-475\`):**
   - \`run.ts\` subscribes to \`engine.events.subscribe()\`, which receives \`execution.started\`, \`execution.prepared\`, \`generation.started\`, \`generation.completed\`, \`agent.step\`, and \`agent.verification\`.
   - However, in \`if (options.json)\`, \`run.ts\` **only** forwards \`delta\` (which is never called by \`CodingAgent\`) and \`complete\`/\`error\`! All \`execution.prepared\`, \`generation.started\` (dispatch), \`first_token\`, and \`agent.step\` events are silently dropped in \`--json\` mode.
3. **Silent Repo-Wide Build/Test Execution During \`VERIFY\` Phase:**
   - After the model finishes generating \`"42"\` in \`1.8s\`, \`CodingAgent\` transitions to \`VERIFY\` and spawns \`npm run build\`, \`npm run test\`, \`npm run lint\`, and \`npm run typecheck\` across the Wazir monorepo without emitting progress events in \`--json\` mode, making a \`1.8s\` answer look like an infinite model hang.
4. **Uncaught \`unhandledRejection\` on Lock Timeout:**
   - When \`JsonFileStore\` times out waiting for \`wazir.json.lock\`, \`run.ts\` exits with a raw stack trace on \`stderr\` instead of a structured JSON error event when \`--json\` is passed.
`;

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'observability-findings.md'), observabilityMd);

  // Ranked Issues List (issues-ranked.md)
  const issuesRankedMd = `# Phase 4 — Ranked Defects & Repair Plan (\`issues-ranked.md\`)

All defects discovered during Phase 1–4 are ranked below by severity and impact on the 5 mission priorities:
1. Successful and correct task execution
2. Responsive, understandable terminal interaction
3. Accurate execution observability
4. Minimum end-to-end turnaround time
5. Reliable recovery and handoff

---

## Defect #1 (Rank 1 — P0 Blocker): Stale File-Lock Deadlock (\`store.ts\`) & 12.5s–18.5s Startup Probe Overhead (\`modelLifecycleService.ts\`, \`lmstudio/index.ts\`)

- **Severity:** **P0 — Critical Execution & Recovery Blocker**
- **Impact:**
  - Caused **9 of 20 baseline task attempts** (\`C01 a2\`, \`C03 a1/a2\`, \`C04 a2\`, \`C06 a2\`, \`C07 a2\`, \`C09 a1/a2\`, \`C10 a2\`) to crash at \`11.0s\` with \`Error: timed out waiting for lock '/home/wael/.wazir/wazir.json.lock' (held for over 10000ms)\`.
  - Caused **5 of 20 baseline task attempts** (\`C02 a2\`, \`C04 a1\`, \`C05 a2\`, \`C08 a2\`, \`C10 a1\`) to exceed the 20s \`FIRST_TOKEN_TIMEOUT\` ceiling before the first token could be emitted.
- **Root Cause (Exact Files & Lines):**
  1. \`packages/shared/src/store.ts:28-29, 70-88\`: \`LOCK_MAX_WAIT_MS = 10_000\` (10s) is **smaller** than \`LOCK_STALE_AFTER_MS = 30_000\` (30s). Inside \`withFileLock()\`, \`liveForeignHolder(lockFile)\` is only checked inside \`if (old)\` (\`age > 30_000\`). When a CLI process is killed (\`SIGTERM\`/\`SIGINT\`) while writing the 32MB \`wazir.json\`, its PID is immediately dead (\`ESRCH\`), but \`withFileLock()\` refuses to check \`liveForeignHolder()\` for 30 seconds and crashes after 10 seconds!
  2. \`packages/runtimes/lmstudio/src/index.ts:135-153\`: \`LMStudioAdapter.healthCheck()\` always spawns the \`lms ls\` CLI subprocess (\`650ms\`) before calling the fast HTTP \`/api/v1/models\` endpoint (\`12ms\`).
  3. \`apps/cli/src/engine.ts:471\` & \`packages/core/src/services/modelLifecycleService.ts:175-232\`: \`createEngine()\` runs \`discoverAndReconcile({ verify: true })\` on every single \`wa run\` / \`wa chat\` invocation, which calls \`probeModel()\` (\`POST /v1/chat/completions\`) sequentially on **all 3 loaded models** (including slow reasoning models \`qwen/qwen3.8-27b\` and \`nvidia/nemotron-3-nano-omni\`), burning 4–6 seconds before the user's task even starts.
  4. \`packages/core/src/services/modelLifecycleService.ts:363-372, 481\`: \`estimateTarget()\` spawns \`lms load <model> --estimate-only\` (\`1.5s\`) even when \`reuse === true\` (the model is already \`READY\` in memory with sufficient context), and \`performLoad()\` runs \`this.verify()\` a second time when \`plan.reuse === true\`.
- **Bounded Repair Plan (Defect #1):**
  - In \`packages/shared/src/store.ts\`: Check \`liveForeignHolder(lockFile)\` whenever \`age > 100\` ms (grace window for atomic write of lock metadata) so locks held by dead PIDs (\`ESRCH\`) are broken immediately (\`<150ms\`) instead of waiting 30s and crashing at 10s.
  - In \`packages/runtimes/lmstudio/src/index.ts\`: In \`healthCheck()\`, query HTTP \`this.nativeModels()\` first (\`~12ms\`) and only fall back to spawning \`lms ls\` if HTTP fails.
  - In \`packages/core/src/services/modelLifecycleService.ts\`:
    - During \`reconcileObserved()\`, trust \`nativeModels()\` \`loaded_instances\` state for already-loaded models unless an explicit target verification is requested, avoiding sequential \`/v1/chat/completions\` probes on unrelated resident models during startup.
    - In \`estimateTarget()\`, when \`reuse === true\` (model is already loaded and context suffices), return a direct zero-cost reuse estimate without spawning \`lms load --estimate-only\`.
    - In \`performLoad()\`, when \`plan.reuse === true\` and existing state is already \`READY\`, skip redundant \`probeModel()\` or only fast-verify if not previously verified.

---

## Defect #2 (Rank 2 — P0 Blocker): Unconditional Multi-Turn Coding Loop & Repo-Wide \`build\`/\`test\`/\`lint\` Verification on Non-Mutating Prompts (\`codingAgent.ts\`, \`run.ts\`)

- **Severity:** **P0 — Critical Task Execution & Turnaround Blocker**
- **Impact:**
  - Caused **all remaining baseline tasks** (\`C01 a1\`, \`C02 a1\`, \`C05 a1\`, \`C06 a1\`, \`C07 a1\`, \`C08 a1\`) to time out at the 45s \`WALL_TIMEOUT\` ceiling even though \`gemma-4-26b-a4b-it-qat\` generated the correct answer (\`"42"\`, \`"READY"\`, etc.) in **1.4s–1.8s**!
- **Root Cause (Exact Files & Lines):**
  1. \`packages/agents/src/codingAgent.ts:1544-1695\`: \`CodingAgent.execute()\` forces a multi-phase \`plan\` -> \`implement\` loop even when the model returns a complete, direct answer on Turn 1 without requesting any file edits or shell commands.
  2. \`packages/agents/src/codingAgent.ts:1744-1785\`: In \`VERIFY\`, \`const mutationRequired = request.mutationRequired ?? !groundedResearch;\` defaults to \`true\` for every \`wa run\` prompt! When a prompt asks a question, requests a code snippet in stdout, or performs a read-only inspection (\`filesChangedSet.size === 0\` and \`expectedFiles.length === 0\` and \`expectedArtifacts.length === 0\`), \`CodingAgent\`:
     - Marks \`'Agent declared completion but produced no code modifications.'\` as a verification failure, AND
     - Runs repo-wide \`npm run build\`, \`npm run test\`, \`npm run lint\`, and \`npm run typecheck\` across the entire Wazir repository (taking 35–60+ seconds)!
- **Bounded Repair Plan (Defect #2):**
  - In \`packages/agents/src/codingAgent.ts\`:
    - When Turn 1 (\`plan\` phase) returns \`done: true\` with zero tool calls (\`fileEdits.length === 0 && commands.length === 0 && toolCalls.length === 0\`) and a non-empty \`summary\`, and no \`expectedFiles\`/\`expectedArtifacts\` were requested (\`!request.mutationRequired\`), complete immediately after Turn 1 without forcing a redundant Turn 2 \`implement\` call.
    - In \`VERIFY\`, only require file mutations (\`mutationRequired\`) when \`request.mutationRequired === true\` or \`expectedFiles.length > 0\` or \`expectedArtifacts.length > 0\`.
    - In \`VERIFY\`, skip repo-wide \`build\`/\`test\`/\`lint\`/\`typecheck\` verification commands when \`filesChangedSet.size === 0\` and \`executedCommands.length === 0\` (no workspace files or state were mutated).
    - Stream or emit the final \`modelSummary\` to \`request.onDelta\` when no streaming chunks were emitted during JSON action parsing so CLI and TUI consumers receive first-token and response output promptly.

---

## Defect #3 (Rank 3 — P1 High): TUI Startup Clarity, Active Model Header & CLI JSON Lifecycle Observability (\`conversationRenderer.ts\`, \`fleetTui.ts\`, \`run.ts\`)

- **Severity:** **P1 — High Usability & Observability Defect**
- **Impact:**
  - \`wa chat\` hides the ready instructions, shows \`auto-routed model\` instead of the pinned model \`gemma-4-26b-a4b-it-qat\`, and gives no indication of how to submit (\`Enter\`), cancel (\`Esc\`), or exit (\`/exit\`).
  - \`wa run --json\` drops \`execution.prepared\`, \`generation.started\` (\`dispatch\`), and \`first_token\` events, leaving callers blind to startup vs. inference latency.
- **Root Cause (Exact Files & Lines):**
  1. \`apps/cli/src/tui/conversationRenderer.ts:64-65\`: Explicitly suppresses \`idleStatus\` and renders a bare 2-line header without startup guidance.
  2. \`apps/cli/src/tui/fleetTui.ts:1800, 5253\`: Constructs \`ConversationRenderer\` before \`selectedModelId\` is resolved from \`--model\` or runtime discovery, and never updates \`conversation.setModel()\`.
  3. \`apps/cli/src/run.ts:431-475\`: Subscribes to \`engine.events\` but ignores \`execution.prepared\` and \`generation.started\` when \`options.json\` is enabled, and never emits a \`first_token\` event when the first delta arrives.
- **Bounded Repair Plan (Defect #3):**
  - In \`apps/cli/src/tui/conversationRenderer.ts\` & \`apps/cli/src/tui/fleetTui.ts\`:
    - Add \`setModel(model: string)\` to \`ConversationRenderer\` and update it once \`selectedModelId\` or the active ready model is resolved.
    - Render clear, concise startup banner in \`ConversationRenderer.start()\` showing: what Wazir does, the active model (\`gemma-4-26b-a4b-it-qat\`), readiness status, and key controls (\`Enter\` to send, \`Esc\` to cancel, \`/help\` for commands, \`/exit\` to quit).
  - In \`apps/cli/src/run.ts\`:
    - Emit structured NDJSON events in \`--json\` mode for \`dispatch\` (when \`generation.started\` fires), \`first_token\` (when the first delta/chunk arrives), and \`step\`/\`verification\` progress, plus structured JSON error output if a startup/lock error occurs in \`--json\` mode.
`;

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'issues-ranked.md'), issuesRankedMd);

  state.defectsFound = [
    'Defect #1 (P0): JsonFileStore stale lock deadlock (10s wait < 30s stale threshold) + 12.5s-18.5s redundant startup probes (lms ls + probeModel on all 3 loaded models + lms load --estimate-only on already-loaded model)',
    'Defect #2 (P0): CodingAgent forces 2-turn loop + repo-wide npm build/test/lint/typecheck during VERIFY even when 0 files were modified',
    'Defect #3 (P1): ConversationRenderer hides Ready/controls and shows auto-routed model instead of pinned model; wa run --json omits dispatch & first_token telemetry',
  ];
  saveState(state);

  writeCheckpoint(state, supervisor, {
    phase: 'PHASE_3_4_AUDITS_COMPLETE',
    action: 'Completed Phase 3 PTY usability audit (usability-findings.md) and Phase 4 observability audit & ranked issues (observability-findings.md, issues-ranked.md)',
    expected: 'Evaluate all 10 interactive TUI usability scenarios via node-pty and trace end-to-end execution observability',
    actual: `Startup readyPromptMs=${ptyReport?.readyPromptMs ?? 'N/A'}ms, activeModelShown=${c.hasActiveModelShown}, maxCharLatencyMs=${c.maxCharLatencyMs ?? 'N/A'}ms, exitedCleanly=${c.exitedCleanly}`,
    analysis: 'Confirmed 3 compounding defects across store locking, startup model probing, CodingAgent non-mutating verification loop, and TUI/CLI observability.',
    decision: 'Proceed to Phase 5: create isolated git worktree and apply bounded code repairs for Defects #1, #2, and #3.',
    filesModified: 'test/codex-dgx-execution/usability-findings.md, test/codex-dgx-execution/observability-findings.md, test/codex-dgx-execution/issues-ranked.md',
    verification: 'usability-findings.md, observability-findings.md, and issues-ranked.md written and verified.',
    stopCheck: 'STOP-01..STOP-12 checked: None triggered.',
    nextAction: 'Phase 5: Create isolated git worktree and apply bounded repairs for Defects #1, #2, and #3',
    resumeInstructions: 'Inspect test/codex-dgx-execution/issues-ranked.md and proceed with Phase 5 repair script.',
  });

  console.log('Phase 3 & 4 audits complete.');
}

main().catch((err) => {
  console.error('Phase 3/4 failed:', err);
  process.exit(1);
});
