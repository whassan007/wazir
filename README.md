<p align="center">
  <img src="assets/brand/logo.jpeg" alt="Wazir — a local AI fleet counselor" width="480">
</p>

# Wazir Meta-Harness

Wazir is a model- and runtime-agnostic meta-harness. It schedules AI agents, models, tools and compute to execute tasks across local and distributed environments. One `wa` CLI routes work to local runtimes (Ollama, LM Studio), hosted providers (Anthropic, OpenAI, Google, NVIDIA) and external coding harnesses (Claude Code, Codex, Qwen Code, OpenCode). It places each task on the best computer in your fleet and verifies the result against physical evidence rather than the model's own claim. Every decision is recorded so you can see what ran, where, on which model, and why.

## Architecture

```
                              Wazir CLI / TUI / Web / Mobile
           (wa chat, wa run, wa goal, wa fleet, wa dashboard, Wazir Mobile approvals)
                                          │
              ┌───────────────┬───────────┼──────────────┬────────────────┐
              ▼               ▼           ▼              ▼                ▼
        PolicyEngine    Goal Studio   JobOrchestrator  Blocks / History   Resources
      (allow/ask/deny,  (goal graphs,     (DAG)       (wa history,       (accounts, budgets,
       sandbox, audit)   ledger, gates)               wa context, @refs)  quotas, kill switch)
              │               │           │
              └───────────────┴─────┬─────┘
                                    ▼
                      Scheduler + Outcome Router
          (capability match → hardware placement → outcome-based choice of
           harness × model × runtime × worker × account; shadow exploration)
                                    │
                ┌───────────────────┼────────────────────┐
                ▼                   ▼                    ▼
         Native harness       ACP harnesses        External CLI harness
         (CodingAgent /       (Claude Code,         (OpenCode)
          ChatAgent)           Codex, Qwen Code)
                │                   │                    │
                └───────────┬───────┴────────────────────┘
                            ▼
        Local worker  ◄──  dispatch (WAL + lease fencing)  ──►  Remote computers (SSE task-pull)
                            │
                            ▼
           Execution & Verification (Plan → Implement → Test → Repair → Verify)
           checkpoints · portable handoff · outcome reconciliation · evidence
                            │
                            ▼
              Persistence (JsonFileStore / PostgresStore / SQLite ledger)
```

## Features

### Execution
- **Conversation-first coding assistant** (`wa chat`): a Codex-style conversation shell with inline shell commands (`!cmd`, `/sh cmd`), live status, and diff-preview approvals. `wa fleet` (or `wa chat --dashboard`) opens the full-screen **Mission Control** dashboard, which runs many agents concurrently with responsive narrow, standard and wide layouts.
- **3-tier execution pipeline**: deterministic read-only commands (`ls`, `git status`, `git diff`, …) are answered without a model round-trip (Tier 0). Conversational prompts go to a lightweight `ChatAgent` (Tier 1), and everything else goes to the full `CodingAgent` loop (Tier 2). Questions that ask for a code change are guarded so they never take the conversational fast path.
- **Cross-harness execution**: one versioned execution contract covers the native Wazir agent, Agent Client Protocol (ACP) harnesses (Claude Code, Codex, Qwen Code) and external CLI harnesses (OpenCode). Capabilities and binaries are discovered automatically. External harnesses never receive standing `always` tool approvals, only one-shot grants that the policy engine permits.
- **Checkpoints and portable handoff**: `wa jobs checkpoint` / `fork` / `rollback` snapshot an execution and its workspace. `wa handoff create/export/resume` moves work between harnesses or machines through a content-addressed, digest-verified checkpoint format. Resuming can never escalate permissions or reset budgets that were already consumed.
- **Solution search** (`wa search`): runs N independent candidate trajectories in parallel, verifies each one, and promotes the winner into the workspace after a conflict check and re-verification.

### Scheduling and routing
- **Distributed scheduling and dispatch**: two-phase routing (capability match, then hardware-aware placement) across local and remote computers, including NVIDIA DGX Spark. Dispatch is WAL-backed and lease-fenced, so a worker that lost its lease can never apply a stale result.
- **Outcome-based routing**: the router learns from recorded outcomes across harness, model, runtime, worker and account. Per-harness performance tracking feeds the choice, and an optional shadow router explores alternatives without affecting the live result. Routing telemetry is recorded for every decision and can be audited.
- **Resource economics** (`wa resources`): per-account token budgets, quotas, local GPU capacity and an emergency stop for cloud dispatch. Costs are labelled honestly: local inference is `ACTUAL $0`, priced APIs are `ACTUAL` or `ESTIMATED`, and unpriced or subscription inference is `UNKNOWN`, never coerced to zero.
- **Explainable scheduling** (`wa explain <ref>`): renders the `SchedulerDecision` recorded at execution time (model, computer and runtime, and why) instead of recomputing one after the fact.

### Verification, safety and recovery
- **Evidence-gated completion**: a model or harness reporting "done" counts only as an *apparent* completion until the controller verifies physical evidence at the current workspace revision. `wa evidence <ref>` shows exactly which evidence verified (or failed to verify) an execution.
- **3-tier policy engine** (`allow` / `ask` / `deny`): every shell, git, filesystem, MCP and web tool call is authorized before it runs. An `ask` decision suspends only the requesting agent, not its siblings. Approvals are scope-bound, expiring and durable, and every decision lands in an append-only audit log (`wa audit`).
- **OS sandbox**: tool subprocesses run under `bwrap` on Linux or `sandbox-exec` on macOS, with a read-only host filesystem, no network unless policy allows it, and a seccomp denylist on Linux. `WAZIR_SANDBOX=required` fails closed. See [Tool sandbox](#tool-sandbox).
- **Durable recovery**: every tool call is recorded as `STARTED`, `COMPLETED`, `FAILED` or `OUTCOME_UNKNOWN`. A mutating call whose outcome is unknown blocks automatic replay until it is reconciled or an operator authorizes it. Interrupted executions and jobs are recovered on startup (`wa jobs recover`).
- **Git worktree isolation**: concurrent fleet agents each work in their own worktree branch. `wa jobs merge` reviews and merges completed branches back.

### Goal Studio
- **Persistent, evidence-gated goal execution** (`wa goal`, `@wazir/goals`): import a YAML or JSON goal graph, validate it as a DAG, and run it continuously. Targets unlock dependents only once independent verification marks them `completed`. Runs keep a durable, lease-fenced ledger with idempotent side effects, and failed targets go through a diagnose → hypothesize → replan → retest repair loop with no-progress detection. Spending caps, scope-bound approvals, a tamper-evident audit hash chain and a web UI with a live goal graph complete the subsystem. See [docs/goal-studio/README.md](docs/goal-studio/README.md).

### Context and history
- **Command history as data** (`wa history`): every `doctor`, `status`, `task run` and `task plan` invocation is persisted as a **Block** (command, status, stdout, exit code and linked execution) and survives restarts.
- **Attachable context** (`wa context add/remove/list/clear`): feeds a prior Block's output into the next task's context budget.
- **Deterministic references** (`@123`, `@job:x`, `@agent:x`, `@model:x`, `@computer:x`, `@file:x`, or a bare execution id): each is a direct store lookup with no LLM involved.

### Providers, tools and integrations
- **Runtime-agnostic providers**: one `RuntimeAdapter` interface with adapters for **Ollama**, **LM Studio**, **NVIDIA API Catalog**, **Anthropic**, **OpenAI** and **Google**. Local runtimes are auto-discovered. Hosted providers are configured with `wa auth login <provider>` and checked with `wa providers test`. Every adapter requires an explicit terminal marker, so a truncated stream is never accepted as a complete answer.
- **MCP** (`wa mcp`): add, authenticate, connect and inspect Model Context Protocol servers, and use their tools, resources and prompts under policy control.
- **Policy-controlled web grounding** (`wa web`). See [docs/web-grounding.md](docs/web-grounding.md).
- **Self-improvement and canaries** (`wa improve`, `wa canary`): measured, budgeted experiments that are promoted only with operator authorization and can always be rolled back.
- **Verified auto-updates** (`wa update`): SHA-256-verified, atomically staged updates with rollback. Updates wait for active work to drain before activating. See [docs/auto-updates.md](docs/auto-updates.md).
- **Web dashboard, desktop and mobile**: `wa dashboard` launches the web control plane. A Tauri desktop app lives in `apps/desktop`, and the Wazir Mobile companion (`wa mobile pair`) handles remote approvals.
- **Pluggable persistence**: a local JSON file store by default, or Postgres via `WAZIR_DATABASE_URL` for a shared, multi-machine deployment.

---

## Quick Start

Requires **Node.js 22.13 or newer** (Wazir's resource ledger uses `node:sqlite`).

```bash
npm install -g wazir        # once published; until then use a release tarball:
npm install -g ./wazir-<version>.tgz
wa doctor                   # check runtimes, providers, agents and sandbox
wa init                     # optional: initialise the local control plane
```

Installing via npm never writes to `~/.wazir` or your shell profile; `wa` creates its state on first
use and upgrades and uninstalls leave it in place. The package bundles the CLI into one file
(`bin/wa.js`); three native modules are optional and only disable their own feature when they
cannot be installed: `node-pty` (interactive terminal tool), `@napi-rs/keyring` (OS keychain;
falls back to the encrypted file store) and `pg-native` (not installed; the pure-JS Postgres
driver is used).

### From a Source Checkout (macOS & Linux — Apple Silicon, Intel x64, Linux x64, Linux ARM64 / DGX Spark)

```bash
git clone https://github.com/whassan007/wazir.git ~/Code/Wazir
bash ~/Code/Wazir/scripts/install.sh
```

### Windows 11 (Native x64 / ARM64 — No WSL2 Required)

In PowerShell (Run as regular user):

```powershell
git clone https://github.com/whassan007/wazir.git $HOME\Code\Wazir
& "$HOME\Code\Wazir\scripts\install.ps1"
```

The source installer verifies Node.js ≥ 22.13, installs dependencies with `npm ci`, builds all workspaces, installs the native `wa` CLI launcher to `~/.local/bin` on macOS/Linux or `%USERPROFILE%\.wazir\bin` on Windows, configures it in your user PATH, and executes `wa doctor`. Failures halt immediately without installing stale artifacts.

### Alternative Installation & Packaging Methods

#### 1. npm package from a checkout
```bash
npm ci
npm run build
npm run package:pack     # writes dist/npm/wazir-<version>.tgz (the publishable package)
npm run package:check    # packs, scans, installs it in isolation, smoke-tests, upgrades, uninstalls
```

#### 2. Homebrew (macOS / Linux)
```bash
# Install from source checkout
brew install --build-from-source Formula/wazir.rb

# Or via Homebrew tap (when hosted on GitHub)
brew tap whassan007/wazir https://github.com/whassan007/wazir
brew install wazir
```

#### 3. Scoop / WinGet (Windows), DEB / RPM (Linux)
Manifests live in `bucket/` (Scoop) and `packaging/` (WinGet, Homebrew, DEB and RPM, with systemd units). Build Linux packages with `npm run build:deb` / `npm run build:rpm`. See [docs/package-managers.md](docs/package-managers.md).

#### 4. Standalone Native Binary (Zero-dependency)
Package Wazir into a self-contained native binary using Node Single Executable Application (SEA):
```bash
npm run build:binary
# Standalone binary is produced at dist/wa (runs with no external Node.js required)
sudo cp dist/wa /usr/local/bin/wa
```

### First run

With Ollama or LM Studio running locally, or a hosted provider configured:

```bash
wa doctor                       # confirm runtimes/providers/models are reachable
wa auth login anthropic         # optional: add a hosted provider (anthropic|openai|google|nvidia)
wa models list                  # see what's discovered
wa chat                         # conversation-first coding assistant
wa run "explain what this repository does"
```

---

## CLI command reference

| Command | What it does |
| --- | --- |
| `wa init` / `wa doctor` / `wa status` | Initialize the control plane, run a health check, show an operational snapshot |
| `wa chat` | Conversation-first coding assistant (`--dashboard` for Mission Control) |
| `wa fleet` | Full-screen Mission Control fleet dashboard |
| `wa ask <prompt>` | One-shot question with automatic model/computer selection |
| `wa run <prompt>` / `wa task run <prompt>` | Run a task end-to-end through the agent loop, policy-gated, with streaming output |
| `wa task plan <prompt>` | Show the scheduling decision without executing |
| `wa task status <id>` | Authoritative task/execution status from the persisted store |
| `wa executions list` / `inspect` / `events` / `replay` | Inspect an execution, its durable event log, or replay it |
| `wa jobs list` / `inspect` / `merge` / `recover` | Fleet jobs and DAGs, worktree merge-back, recovery of interrupted graphs |
| `wa jobs checkpoint` / `fork` / `rollback` | Checkpoint an execution and workspace, fork it into a worktree, or roll back |
| `wa handoff create` / `list` / `show` / `export` / `resume` | Durable, portable agent handoffs across harnesses and machines |
| `wa goal import` / `list` / `start` / `status` / `pause` / `resume` / `stop` / `retry` / `approve` / `reject` | Goal Studio runs over goal graphs |
| `wa search run` / `status` / `candidates` / `inspect` / `promote` / `cancel` | Best-of-N parallel solution search |
| `wa explain <ref>` | The recorded scheduling decision behind an execution, block, or job |
| `wa evidence <ref>` | Which controller evidence verifies (or fails to verify) an execution |
| `wa artifacts` | Artifact provenance |
| `wa history` / `wa context` | Command history (Blocks) and active context blocks |
| `wa providers list` / `inspect` / `test` | Local and hosted execution providers |
| `wa auth login` / `logout` | Authenticate hosted providers (Anthropic, OpenAI, Google, NVIDIA) |
| `wa runtimes` / `wa models` / `wa discover` | Discovered runtimes and models; force a discovery pass |
| `wa computers` / `wa workers` / `wa agents` / `wa tools` | Fleet computers, worker daemons, coding agents, tools and their risk levels |
| `wa resources` | Accounts, budgets, quotas, GPU capacity; `stop` / `resume` cloud dispatch |
| `wa policy inspect` / `wa audit` | Policy rules and the append-only security/policy audit log |
| `wa mcp` | Manage MCP servers, credentials and capabilities |
| `wa web` | Policy-controlled web grounding diagnostics |
| `wa improve` / `wa canary` | Self-improvement experiments and canary deployments |
| `wa evaluation` / `wa benchmark run` / `wa test` | Evaluation metrics, model benchmarks, protocol diagnostics |
| `wa dashboard` | Launch the web control plane and dashboard |
| `wa mobile` | Pair and manage Wazir Mobile companion devices |
| `wa service` | Install and manage the background service (systemd / launchd / Windows) |
| `wa update` | Verified updates: `check`, `now`, `enable`, `rollback`, `history` |
| `wa config show` / `wa version` | Effective configuration and build information |

Most listing/inspection commands accept `--json` for machine-readable output. Run `wa <command> --help` for every subcommand.

---

## Command history, context & references

Every `doctor`, `status`, `task run`, and `task plan` invocation is persisted as a **Block** — a record of the command, its status, stdout, exit code, and (when applicable) the execution or job it created. Blocks survive process restarts, backed by the same `KeyValueStore` as everything else.

```bash
wa doctor                    # runs, and is recorded as block #7
wa history list               # id  command  status   age
                               # 7   doctor   success  just now
wa history inspect 7          # full detail: stdout, exit code, duration
wa history list --status failed --json
```

Pull a prior Block's output into the next task's context budget:

```bash
wa context add 7
wa context list               # shows block #7, ~152 tok estimate
wa task plan "continue from the last doctor run"   # context budget genuinely
                                                    # includes block #7's output
wa context clear
```

Reference anything deterministically — no LLM involved in resolution, every form is a direct lookup:

```
@123              a Block by id
@job:<id>         a fleet job
@agent:<name>     a registered agent
@model:<id>       a registered model
@computer:<id>    a registered computer
@file:<path>      resolved against the project root, existence-checked
exec-abc123       a bare execution id
```

```bash
wa explain exec-abc123        # the actual recorded SchedulerDecision:
                               # selected model/computer/runtime and why,
                               # plus any non-'allow' policy decisions
wa explain @job:job-xyz       # aggregate rollup (tokens, duration, cost)
                               # plus per-task scheduling reasons
wa evidence exec-abc123       # the evidence that verified (or failed) it
```

---

## Interactive terminal (`wa chat` / `wa fleet`)

```bash
wa chat                                 # conversation-first assistant
wa fleet                                # Mission Control dashboard (= wa chat --dashboard)
wa chat --dashboard --concurrency 8 --auto-merge
wa chat --no-worktrees                  # run in-place, no git isolation
```

### Keyboard navigation (Mission Control)

| Key | Action |
| --- | --- |
| `Tab` | Cycle views: Fleet Dashboard → Tail → Approval Queue → Worktrees → Help |
| `Up` / `Down` | Navigate agents in the fleet table |
| `Enter` | Tail the highlighted agent (live stream of turns/tool calls) |
| `Esc` | Return to the Fleet Dashboard |
| `y` / `n` | Approve / Deny the current pending policy request |
| `a` / `d` | Approve All / Deny All pending requests |

### In-session commands

- `!cmd` or `/sh cmd` — run a shell command inline; output, exit code and duration go into the transcript without calling a model
- `/fleet` / `/chat` — switch between Mission Control and the conversation view
- `/fanout t1; t2; t3` — decompose into N sub-tasks and run them concurrently, up to the concurrency limit
- `/steer <instruction>` — inject a mid-run instruction into the selected agent (or the whole fleet)
- `/cancel [taskId]` — cancel one agent, or the whole job if none is selected
- `/exit` or `q` — shut down the TUI

---

## Fleet jobs, checkpoints & handoff

```bash
wa jobs list
wa jobs inspect <job-id>                      # per-task status + usage rollup
wa jobs merge <job-id> --target main          # merge completed worktree branches
wa jobs recover                               # resume interrupted graphs; leaves live owners alone

wa jobs checkpoint <execution-id> --desc "before refactor"
wa jobs fork <checkpoint-id>                  # continue in an isolated worktree branch
wa jobs rollback <execution-id> <checkpoint-id>

wa handoff create                             # portable, digest-verified handoff
wa handoff resume <handoff-id>                # resume on another harness or machine
```

---

## Goal Studio (`wa goal`)

```bash
wa goal import goals.yaml                     # validate and store a goal graph revision
wa goal start <graph-id>                      # start a controller run (fenced lease)
wa goal status <run-id>                       # ledger and per-target statuses
wa goal pause|resume|stop <run-id>
wa goal retry <run-id> <target-id>
wa goal approve <approval-id>                 # scope-bound approval requests
```

Only verified `completed` targets unlock their dependents. Targets with an external dependency wait in `awaiting_external` until attributable evidence arrives. Runs persist and resume across restarts without repeating completed side effects. The full lifecycle and verification suites are in [docs/goal-studio/README.md](docs/goal-studio/README.md).

---

## Distributed mode

By default the CLI only knows about the machine it's running on. Point it at a control-plane API to schedule across a real fleet:

```bash
export WAZIR_API_URL=http://control-plane-host:4800
wa ask "refactor the auth module" --computer dgx-primary
```

On startup, the CLI pulls the API's known computers/runtimes/models/instances into its own `Scheduler` registries (skipping anything matching its own local computer id), so a task can genuinely be placed on — and dispatched to — a remote machine over the API's SSE task-pull loop. See `Dockerfile`'s `api`/`worker` targets and `docker-compose.yml` for running the control plane itself, and [docs/fleet-setup.md](docs/fleet-setup.md) for a full fleet.

### Control-plane authentication

A worker's reported result is fed straight back into the operator's agent loop as the model reply, so the control plane authenticates both sides:

| Variable | Where | Purpose |
| :-- | :-- | :-- |
| `WAZIR_API_TOKEN` | API, CLI, web | Operator bearer token for every `/api/v1/*` route and `/executions`. Optional on a loopback bind; the API refuses to bind any other address without it (override with `WAZIR_ALLOW_UNAUTHENTICATED=1`). |
| `WAZIR_REGISTRATION_TOKEN` | API, worker | Cluster secret a worker must present to register a new computer id or re-claim one after a restart. |
| `WAZIR_WORKER_TOKEN` | worker | Optional pre-shared per-computer token so a worker keeps a stable identity without the registration secret. |

Registration returns a per-computer token that the worker then sends on its heartbeat, task stream and result routes — only the process that registered a computer can receive its tasks or report on them. `local` is decided by the API from the transport, never from the registration payload, so `localOnly` tasks are never routed off-machine. Updates to an execution are fenced by its lease epoch, so a worker that lost its lease cannot overwrite the current owner's state.

`docker-compose.yml` requires both cluster tokens and publishes every port on `127.0.0.1` only; put a TLS reverse proxy in front if other hosts must reach the API.

### Tool sandbox

Beyond the policy engine's allow/ask/deny decision, every `shell`, `git` and check-tool subprocess runs inside an OS sandbox when the host supports one: `bwrap` (bubblewrap) on Linux, `sandbox-exec` on macOS. Inside it the host filesystem is read-only, only the project directory and a private `/tmp` are writable, `$HOME` and other users' homes are hidden except for toolchain directories (`~/.nvm`, `~/.cargo`, package caches), runtime sockets under `/run` are masked, the network is unreachable unless the policy's `networkAccess` allows it, and on Linux a seccomp denylist refuses `mount`, `ptrace`, `unshare`/`setns`, module loading, `bpf` and similar. `WAZIR_SANDBOX=auto|required|bwrap|sandbox-exec|none` selects the backend — `required` fails closed instead of falling back to the host; the effective mode is stored on every tool call record and reported by `wa doctor`. When no sandbox is active, workspace artifact execution is never auto-approved. On Ubuntu ≥ 23.10 install the shipped AppArmor profile (`scripts/apparmor/bwrap`) so bubblewrap may create user namespaces. See [docs/sandbox.md](docs/sandbox.md).

---

## Persistence

The default backend is a local JSON file at `~/.wazir/wazir.json` (`JsonFileStore`), safe for concurrent writers across processes via a cross-process file lock. Two other backends are available, checked in this order:

1. `WAZIR_DATABASE_URL=postgres://...` — `PostgresStore`, for a shared, multi-machine deployment. Run `docker compose up -d` to get one, or point at an existing instance.
2. `WAZIR_IN_MEMORY=1` — nothing persisted, useful for tests/CI.
3. Otherwise, the default local JSON file.

The resource ledger and the API's durable execution history use SQLite (`node:sqlite`).

---

## Deployment

### Docker / Docker Compose

`Dockerfile` builds four targets from one multi-stage build: `api`, `worker`, `web`, `cli`.

```bash
docker compose up -d api worker web       # control plane + a worker + the dashboard
docker compose run --rm cli wa doctor     # one-off CLI commands against that stack
```

Set `WAZIR_OLLAMA_URL` / `WAZIR_LMSTUDIO_URL` in `.env` (see `.env.example`) so the `api`/`worker` containers can reach runtimes on the Docker host, e.g. `http://host.docker.internal:11434`.

### Background service (systemd / launchd / Windows)

```bash
wa service install --type worker --api-url http://control-plane-host:4800
wa service install --type api --port 4800
wa service status
```

Unit files are also available in `scripts/systemd/` and a launchd plist in `scripts/launchd/` if you prefer to install them by hand:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wazir-api
sudo systemctl enable --now wazir-worker

cp scripts/launchd/ai.wazir.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.wazir.worker.plist
```

The launchd worker is headless and distinct from the GUI `Wazir.app` produced by `npm run dmg`.

---

## Directory structure

```
wazir/
├── apps/
│   ├── cli/          # `wa` — commands, engine wiring, conversation shell and Mission Control (src/tui/)
│   ├── api/          # REST control plane — inventory, SSE dispatch, checkpoint transport, Goal Studio routes
│   ├── web/          # Web dashboard and Goal Studio UI
│   ├── worker/       # Standalone worker daemon
│   ├── desktop/      # Tauri desktop app
│   └── mobile/       # Wazir Mobile companion (android/, ios/)
│
├── packages/
│   ├── core/         # Domain types, Scheduler, outcome router, PolicyEngine, ExecutionEngine,
│   │                 # JobOrchestrator, ApprovalQueue, checkpoints, handoff, harness dispatch/resume
│   ├── agents/       # CodingAgent / ChatAgent, native, ACP and external-CLI harness adapters
│   ├── goals/        # Goal Studio: graphs, ledger, controller, verification, recovery, governance
│   ├── runtimes/     # Provider adapters: ollama, lmstudio, nvidia, anthropic, openai, google
│   ├── workers/      # Worker daemon: registration, heartbeat, SSE task-pull, remote dispatch
│   ├── scheduler/    # Deterministic, explainable task scheduling
│   ├── policies/     # Policy enforcement
│   ├── tools/        # Filesystem/shell/git/check tools and the OS sandbox
│   ├── models/       # Model catalog and capabilities
│   ├── lsp/          # Language-server integration
│   ├── secrets/      # Credential storage (OS keychain / encrypted file)
│   ├── database/     # PostgresStore + reference SQL schema
│   ├── registry/     # Durable repository helpers over a KeyValueStore
│   ├── evaluation/   # Post-execution evaluation and router benchmarks
│   ├── observability/# Structured logging & metrics
│   ├── memory/       # Session/conversation store
│   └── shared/       # KeyValueStore implementations (JSON file / in-memory), utils
│
├── packaging/        # Homebrew, Scoop, WinGet, DEB and RPM manifests
├── scripts/          # Installers, builders, systemd units, launchd plist, AppArmor profile
├── docs/             # Guides, design notes and reports
└── tests/            # Cross-cutting integration tests (package tests live in each package)
```

## Cross-Platform Support

Wazir runs natively on Linux, macOS and Windows with no emulation layer.

| Operating System | Architecture | Installation | Status | Verification & Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Linux** | x64 | `bash scripts/install.sh` | **VERIFIED** | GitHub Actions matrix (`ubuntu-latest`) & local runners. Bubblewrap sandbox supported. |
| **Linux** | ARM64 (DGX Spark) | `bash scripts/install.sh` | **VERIFIED** | Live validated on NVIDIA GB10 hardware. Local GPU telemetry & LM Studio routing active. |
| **macOS** | ARM64 (Apple Silicon) | `bash scripts/install.sh` | **VERIFIED** | GitHub Actions matrix (`macos-latest`). Mach-O binary packaging via Node SEA. |
| **macOS** | x64 (Intel) | `bash scripts/install.sh` | **VERIFIED** | Full CLI, TUI, and test suite compatible. Portable path & process-tree termination. |
| **Windows 11** | x64 (Native) | `& scripts\install.ps1` | **VERIFIED** | GitHub Actions matrix (`windows-latest`). Native launchers (`wa.cmd`, `wa.ps1`). No WSL2 required. Process trees terminated via `taskkill /T /F`. |
| **Windows 11** | ARM64 (Native) | `& scripts\install.ps1` | **VERIFIED** | Node.js ≥ 22.13 ARM64. Native PE binary packaging. |

### Platform Abstraction Highlights

1. **Process-Tree Termination**: Uses POSIX process groups (`process.kill(-pid)`) on macOS/Linux and native Windows `taskkill /pid <pid> /T /F` on Windows to eliminate orphan leakages.
2. **Case-Insensitive Paths**: Path containment (`isPathInside`) resolves cross-platform paths using `path.relative` to safely handle Windows drive letters and case insensitivity.
3. **Command Resolution**: Resolves commands on Windows taking `PATHEXT` (`.EXE`, `.CMD`, `.BAT`) into account without fragile shell wrapping.
4. **Git Hook Isolation**: Replaces POSIX-only `/dev/null` with `GIT_NULL_DEVICE` (`NUL` on Windows) for `core.hooksPath`.
5. **Native Packaging**: `npm run build:binary` compiles standalone self-contained binaries using Node.js Single Executable Application (SEA) targeting ELF on Linux, Mach-O on macOS, and PE on Windows.
6. **Heterogeneous Fleet & DGX Spark**: Two-phase resource-aware scheduler routes workloads across macOS, Windows, and Linux ARM64 (NVIDIA DGX Spark GB10 with 122 GB ATS unified memory).
7. **Durable Recovery & Lease Fencing**: WAL-backed dispatch with cryptographically fenced lease tokens (`LEASE_LOST`), orphan sweeps, and safe retries preventing duplicate mutating side effects.

### Documentation & Guides

- [Distributed Fleet Setup Guide](docs/fleet-setup.md)
- [Linux ARM64 NVIDIA DGX Spark Worker Guide](docs/dgx-spark-worker.md)
- [Windows Worker Setup Guide](docs/windows-worker.md)
- [macOS Worker Setup Guide](docs/macos-worker.md)
- [Goal Studio Guide](docs/goal-studio/README.md)
- [NVIDIA Provider](docs/nvidia-provider.md)
- [Tool Sandbox](docs/sandbox.md)
- [Auto-Updates](docs/auto-updates.md)
- [Web Grounding](docs/web-grounding.md)
- [Package Managers](docs/package-managers.md)
- [Cross-Platform Compatibility Matrix](docs/compatibility-matrix.md)
- [Troubleshooting Guide](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)

---

## Development

```bash
npm run build       # build every workspace
npm run typecheck   # tsc --build --force, no emit
npm test            # build + full vitest suite
npm run test:watch  # vitest in watch mode
```

Postgres-backed tests are skipped automatically unless `WAZIR_TEST_DATABASE_URL` is set:

```bash
docker run --rm -d -e POSTGRES_PASSWORD=wazir -e POSTGRES_DB=wazir_test -p 5432:5432 postgres:16-alpine
WAZIR_TEST_DATABASE_URL=postgres://postgres:wazir@localhost:5432/wazir_test npm test
```

---

## Brand

Logo and full corporate visual identity guidelines (typography, color palette, voice) are in [`assets/brand/`](./assets/brand/); see [`Wazir_CVI_Guidelines.pdf`](./assets/brand/Wazir_CVI_Guidelines.pdf).

---

## License

AGPL-3.0 — see [LICENSE](./LICENSE). If you run a modified version of Wazir as a network service, the AGPL requires you to make your modified source available to users of that service.
