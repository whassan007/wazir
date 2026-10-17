# Wazir Comprehensive User-Journey & Live Reliability Test Matrix

**Repository:** `~/Code/Wazir`  
**Branch:** `fix/comprehensive-live-reliability`  
**Runner:** `npm run test:live` (`scripts/live-reliability-gate.mjs`)  

---

## Overview

This document defines the user-journey test matrix (Categories A–H) and the 10 systemic failure detection invariants enforced by Wazir's live reliability test harness. Every test case is designed to exercise Wazir as a real application (spawning real CLI processes, real pseudo-terminals via `node-pty`, real local HTTP runtime fixtures or live daemons, and real distributed API/worker processes) and to fail deterministically on any user-visible regression.

---

## Part 1: User-Journey Test Matrix (Categories A–H)

### Category A: First-Run Experience
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **A-01** | Installation & binary startup (`wa --version`, `wa --help`) | `bin/wa.js` child process | Prints semver matching `package.json`, prints command help, exits `0`. | Tier 1 |
| **A-02** | Workspace configuration initialization (`wa init`) | `bin/wa.js init` in fresh temp workspace | Creates `.wazir/config.json`, prints initialization confirmation, exits `0`. | Tier 1 |
| **A-03** | Runtime discovery (`wa runtimes list`, `wa runtimes inspect <id>`) | `bin/wa.js` child process | Lists registered runtimes with real health state; `inspect <nonexistent>` prints error and exits non-zero (`1`). | Tier 1 |
| **A-04** | Model discovery (`wa models list`, `wa models discover`, `wa models inspect <id>`) | `bin/wa.js` child process | Lists/discovers models from active runtime or reports none; `models inspect --json` emits valid JSON; missing model exits non-zero. | Tier 1 / Tier 2 |
| **A-05** | Authentication & secret status (`wa secrets list`, `wa config show`) | `bin/wa.js` child process | Displays configured secrets/keys with values redacted, exits `0`. | Tier 1 |
| **A-06** | Missing dependencies & unavailable runtimes (`wa doctor`, `wa doctor --json`) | `bin/wa.js` with unreachable runtime ports | Accurately reports unreachable runtimes and recovery commands without crashing (`doctor --json` outputs valid JSON). | Tier 1 |
| **A-07** | Invalid configuration handling | `bin/wa.js` with corrupted `.wazir/config.json` | Reports actionable configuration error or recovers gracefully without unhandled exception. | Tier 1 |

### Category B: Interactive CLI (`wa chat` & `wa fleet` in Real PTY)
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **B-01** | Starting and exiting interactive sessions (`/exit`, `/quit`, `Ctrl+C`, EOF) | Real PTY (`node-pty`) running `bin/wa.js chat` | Renders banner & prompt, exits cleanly on `/exit` or `Ctrl+C`, restores terminal state (`exitCode === 0`). | Tier 1 |
| **B-02** | Submitting inline shell commands (`!pwd`, `!ls -la`, `/sh echo WAZIR_OK`, failing `!sh -c "exit 7"`) | Real PTY (`node-pty`) running `bin/wa.js chat` | Appends command, stdout/stderr, exit code, and duration to durable transcript; does not invoke LLM; session stays alive. | Tier 1 |
| **B-03** | Submitting slash commands in `conversation` mode (`/help`, `/models`, `/model <id>`, `/agents`, `/runtimes`, `/tasks`, `/status`, `/doctor`, `/block`, `/why model`, `/compact`, `/clear-context`, `/cancel`) | Real PTY (`node-pty`) running `bin/wa.js chat` | Every slash command produces immediate, durable, visible output in the conversation transcript; `/why` does NOT freeze keyboard input. | Tier 1 |
| **B-04** | Unknown or mistyped slash commands (`/nonexistent`, `/foo`, bare `/sh`) | Real PTY (`node-pty`) running `bin/wa.js chat` | Prints explicit unknown-command / usage error in transcript; NEVER dispatches an AI coding job for a slash command. | Tier 1 |
| **B-05** | Navigating views & switching modes (`/fleet`, `/chat`, `/search`, `/improvement`, `/canary`, `/context`, `/evidence`, `/worktrees`) | Real PTY (`node-pty`) | Switching views in `conversation` mode either prints durable summary or switches cleanly to dashboard mode and back to `/chat`. | Tier 1 |
| **B-06** | Selecting and pinning models (`/model <id>`, `/model auto`, `/model invalid-id`) | Real PTY (`node-pty`) | Pins valid model with durable confirmation; rejects invalid model with durable error message. | Tier 1 |
| **B-07** | Approving or denying restricted operations in `conversation` mode (`y`/`n`, `/approve`, `/deny`, `/fleet`) | Real PTY (`node-pty`) | Displays approval prompt; allows approving/denying or typing `/approve`, `/deny`, `/fleet` without keyboard deadlock. | Tier 1 |
| **B-08** | Cancellation and interruption (`/cancel`, `Escape` during active task) | Real PTY (`node-pty`) | Cancels active task, updates status and durable transcript, returns prompt to responsive state. | Tier 1 |
| **B-09** | Terminal resizing (`pty.resize(80, 24)` -> `pty.resize(140, 45)`) | Real PTY (`node-pty`) | Re-renders without duplicating durable history blocks or crashing. | Tier 1 |
| **B-10** | Session restart and history persistence (`wa history list`, `wa history inspect <id>`) | Sequential PTY sessions + CLI | Durable history blocks persist across session restarts and can be inspected via CLI and `/block`. | Tier 1 |

### Category C: AI Execution
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **C-01** | Simple natural-language request (`wa ask "Reply with PONG"`) | CLI + Controlled Runtime Fixture / Live Runtime | Streams response, outputs `PONG`, records token usage, exits `0`. | Tier 1 / Tier 2 / Tier 3 |
| **C-02** | Multi-step coding & tool-dependent task (`wa run "Create hello.txt with WAZIR_LIVE_OK"`) | CLI + Controlled Agent Runtime / Live Runtime | Executes `write` tool, verifies physical file creation on disk, records execution evidence, exits `0`. | Tier 1 / Tier 2 / Tier 3 |
| **C-03** | Context-heavy request & compaction (`ContextEngine` + `/compact`) | Engine / TUI | Compacts context within token budget while preserving pinned constraints and system instructions. | Tier 1 |
| **C-04** | Failed model response (HTTP 500 / 429 / unreachable provider) | Controlled Fault Server + CLI/Engine | Surfaces explicit failure class (`PROVIDER_UNAVAILABLE`, `RATE_LIMITED`), does NOT report `completed`, exits non-zero. | Tier 1 / Tier 2 |
| **C-05** | Partial / truncated streaming response & mid-stream abort | Controlled Fault Server + Runtime Adapters | Premature EOF without `[DONE]`/`finishReason` or aborted stream emits `error` (`INCOMPLETE_PROVIDER_STREAM` / `CANCELLED`), never `{ type: 'completed' }`. | Tier 1 / Tier 2 |
| **C-06** | Tool execution failure & verification failure | `CodingAgent` + `VerificationEngine` | Failing build/test (including `"Module not found"` or `"No such file"`) fails verification unless repaired; never falsely reports `VERIFICATION_PASSED`. | Tier 1 |
| **C-07** | Verification and repair loop | `CodingAgent` + Controlled Runtime | Agent receives failing test output, applies repair edit, re-runs verification, and succeeds only after check passes. | Tier 1 / Tier 2 |

### Category D: Multi-Model Orchestration & Resource Governance
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **D-01** | Capability-based model selection & explicit pinning (`--model <id>`) | `Scheduler` + `RookEngine` | Selects model matching required capabilities or pinned model ID. | Tier 1 |
| **D-02** | Local vs remote routing modes (`LOCAL_ONLY`, `PREFER_LOCAL`, `CLOUD_ALLOWED`, `NVIDIA`) | `Scheduler` | Respects locality constraints and never wipes `resource:*` vetoes (auth block, emergency stop, quota exhausted) in `NVIDIA` mode. | Tier 1 |
| **D-03** | Model unavailability & zero-model recovery in `wa chat` | Real PTY (`node-pty`) with zero models | Displays durable recovery explanation with concrete commands; does not create a stuck job; `!shell` commands remain usable. | Tier 1 |
| **D-04** | Model instance state filtering (`FAILED`, `UNAVAILABLE`, `LOADING`, `UNLOADING`, `DRAINING`) | `Scheduler` + `ModelLifecycleService` | Never routes tasks to model instances in `FAILED` or `UNAVAILABLE` state. | Tier 1 |
| **D-05** | Token budget exhaustion & local GPU concurrency queueing (`governAdapter`) | `ResourceControlPlane` + `governAdapter` | Blocks when budget is exhausted; serializes concurrent local GPU requests when `maxConcurrent` is reached even under default policy. | Tier 1 |

### Category E: Distributed Operations
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **E-01** | Remote worker registration & model/runtime synchronization (`POST /computers/register`) | Real API Server + Worker Process | Registers computer AND populates `RuntimeRegistry` and `ModelRegistry` instances so `Scheduler.scheduleComputer` routes to the remote worker. | Tier 2 |
| **E-02** | Remote task dispatch, streaming events, and completion (`dispatchRemote`) | Real API Server + Worker Process | Dispatches task over SSE, streams events (even past buffer eviction boundaries via sequence numbers), commits final result. | Tier 2 |
| **E-03** | Worker heartbeat loss, `SIGKILL` crash, and lease expiration recovery | Real API Server + Worker Process (`tests/distributed`) | Detects lost heartbeat/expired lease, recovers or sweeps abandoned dispatch via `RecoveryManager`, prevents duplicate commits via lease tokens. | Tier 2 |
| **E-04** | Half-open SSE stream timeout on Worker (`runTaskStream`) | Worker + Controlled Stalled SSE Server | Worker aborts stalled SSE read when heartbeat pings stop arriving and reconnects automatically. | Tier 2 |
| **E-05** | Concurrent distributed task execution & isolation | Real API Server + Multiple Workers | Concurrent tasks execute in isolated worktrees/leases without cross-contaminating state or duplicating side effects. | Tier 2 |

### Category F: Safety, Sandboxing & Policy Governance
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **F-01** | Path traversal & workspace escape prevention (`write`, `edit`, `read`, symlinks) | `ToolRegistry` + `PolicyEngine` | Blocks writes/edits outside workspace root and through escaping symlinks. | Tier 1 |
| **F-02** | Destructive shell command blocking (`rm -rf /`, `mkfs`, `find . -exec ... + -delete`) | `PolicyEngine` + `shell` tool | Requires approval or denies destructive commands, including `find -exec ... +` chains and modified workspace build files (`Makefile`, `Cargo.toml`, `.go`). | Tier 1 |
| **F-03** | `code_mode` policy enforcement (`wazir.write`, `wazir.edit`, `wazir.git`, `wazir.call('shell', ...)`) | `createCodeModeTool` + `PolicyEngine` | Enforces `PolicyEngine.authorize()` on `code_mode` and on every inner tool invocation (`wazir.write`, `wazir.call('shell', ...)`). | Tier 1 |
| **F-04** | `terminal_open` & `terminal_send` policy & sandbox enforcement | `PolicyEngine` + `terminalTools` | Requires policy authorization for `terminal_open`/`terminal_send` (treating commands via shell classifier) and enforces workspace containment. | Tier 1 |
| **F-05** | OS Sandbox live enforcement (`bwrap` on Linux, `sandbox-exec` on macOS) | `wrapInSandbox` (`sandbox.ts`) | Blocks writes outside allowed write roots in a real child process on both Linux (`bwrap`) and macOS (`sandbox-exec`). | Tier 1 / Tier 2 |
| **F-06** | Secret redaction in logs, status, and transcripts | `PolicyEngine` + CLI/TUI | Redacts API keys and bearer tokens across tool outputs, execution records, and CLI outputs. | Tier 1 |

### Category G: Persistence, Checkpoints & Recovery
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **G-01** | Durable checkpoint creation, fork, and rollback across process restart | `CheckpointService` + `JsonFileStore` | `checkpoint()`, `fork()`, and `rollback()` flush updated `ExecutionRecord` to disk so `revision`, `evidence`, and `mutationHistory` survive process restart. | Tier 1 / Tier 2 |
| **G-02** | Interrupted execution orphan recovery (including container PID 1 reuse & `'paused'` state) | `ExecutionEngine` + `JsonFileStore` | Marks interrupted `'running'`, `'queued'`, and `'paused'` executions from prior boot/instance as failed/recoverable on startup even if PID is 1. | Tier 1 |
| **G-03** | Store-backed `JobManager` startup reconciliation & `resume()` | `JobManager` + `JsonFileStore` | Reconciles stale `'running'` jobs on startup when store is configured; `jobManager.resume(id)` transitions failed/cancelled jobs back to `'ready'` and persists without throwing `JOB_LEASE_LOST`. | Tier 1 |
| **G-04** | `JobOrchestrator` execution record lifecycle & model unload | `JobOrchestrator` + `ModelLifecycleService` | Completed/failed orchestrated jobs leave zero orphaned `'queued'` `ExecutionRecord`s; subsequent `ModelLifecycleService.unload()` succeeds. | Tier 1 |

### Category H: Self-Improvement, Search, Canary & CLI Exit Code Integrity
| ID | Scenario | Execution Surface | Expected Observable Outcome | Tier |
| :--- | :--- | :--- | :--- | :--- |
| **H-01** | Non-zero exit codes on missing entities & failed CLI operations | `bin/wa.js` child process | `computers inspect`, `runtimes inspect`, `task status`, `executions inspect|replay`, `history inspect`, `jobs inspect|merge|checkpoint|fork|rollback`, `artifacts *`, `benchmark run`, `search *`, `improve *`, `canary *` exit non-zero (`1`) when target entity is missing or operation fails. | Tier 1 |
| **H-02** | CLI flag fidelity (`wa history list --command`, `wa models inspect --json`, `wa status`) | `bin/wa.js` child process | `wa history list --command <subtext>` filters history blocks accurately; `wa models inspect --json` outputs valid JSON; `wa status` reports real version (`0.2.5`) and real active/queued execution counts. | Tier 1 |
| **H-03** | Honest empty state in TUI Improvement & Context panes | `FleetTui` | When no experiments or context compactions exist, renders honest empty state rather than fabricated `exp-042` or `G1..G7`. | Tier 1 |

---

## Part 2: Automated Detection for the 10 Systemic Failure Categories (Phase 4)

Every live test run (`scripts/live-reliability-gate.mjs`) enforces automated detectors across all 10 failure categories:

1. **Silent Failure Detector**: Every CLI invocation or TUI submission must produce an observable acknowledgment and terminal outcome within a bounded timeout (5s for local commands, 15s for task executions); empty stdout+stderr or unrendered TUI commands fail the gate immediately.
2. **Lost Input Detector**: Tracks submitted commands/prompts against rendered transcript blocks and `HistoryService` records; any submission missing from the transcript or history fails the gate.
3. **False Success Detector**: Verifies that failed commands, missing IDs, aborted/truncated model streams, failed verification checks, and unexecuted mobile tasks never return exit code `0` or `status: 'completed'`.
4. **Infinite Execution Detector**: Enforces hard per-step and per-job timeouts (`JobOrchestrator` unschedulable task detection, `Worker` SSE read heartbeat timeout, `CodingAgent` wall-clock cap).
5. **Duplicate Execution Detector**: Verifies that a single submission or `JobOrchestrator` task creates at most one `ExecutionRecord` and executes side effects once.
6. **Lost State Detector**: Restarts engine/CLI processes against the same `.wazir` state directory after checkpoints, rollbacks, history writes, and job transitions, asserting 100% state parity before and after restart.
7. **Invalid Routing Detector**: Verifies that `Scheduler` rejects `FAILED`/`UNAVAILABLE` model instances, respects `resource:*` vetoes in `NVIDIA` mode, and routes to registered remote workers.
8. **Unauthorized Execution Detector**: Attempts restricted tool calls via `shell`, `find -exec ... +`, `code_mode`, and `terminal_open`/`terminal_send` without approval and asserts `PolicyEngine` blocks/asks every time.
9. **Resource Overrun Detector**: Submits concurrent local GPU requests exceeding `maxConcurrent` and asserts queueing (`deferred` wait) and accurate token ledger settlement.
10. **Broken Recovery Detector**: Simulates process crashes (`SIGKILL` / stale boot ID / PID 1 reuse) mid-execution and mid-job, asserting that restart transitions all interrupted records out of `'running'`/`'queued'` into a terminal/recoverable state.
