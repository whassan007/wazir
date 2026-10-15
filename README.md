<p align="center">
  <img src="assets/brand/logo.jpeg" alt="Wazir — a local AI fleet counselor" width="480">
</p>

# Wazir Meta-Harness

A production-quality local and fleet-scale AI meta-harness that orchestrates multiple AI runtimes, models, tools, and target computers — with an OpenCode-style interactive terminal UI capable of running dozens of agents concurrently across distributed infrastructure, and a persistent command history/context system that lets you reason about what actually ran, on which model, with which scheduling decision, and why.

## Architecture

```
                       Wazir CLI / TUI
              (wa ask, wa task run, wa chat, wa jobs)
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
          PolicyEngine   JobOrchestrator  Blocks / History
        (allow/ask/deny)     (DAG)        (wa history)
                │             │                │
                │   ┌─────────┼─────────┐      ▼
                │   ▼         ▼         ▼   Context (wa context)
                │ Approval  Worktree  Fleet     │
                │  Queue    Manager   Runner     ▼
                │ (non-      (git     (worker  References (@x)
                │ blocking) isolation) dispatch)    │
                │                        │          ▼
                └───────────┬────────────┘     wa explain <ref>
                            ▼
                       Scheduler
              (capability match + hardware placement)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        Local Worker                Remote Computer
        (CodingAgent)              (SSE task-pull loop)
              │                           │
              └─────────────┬─────────────┘
                            ▼
                Execution & Verification
             (Plan → Implement → Test → Repair → Verify)
                            │
                            ▼
              Persistence (JsonFileStore / PostgresStore)
```

## Features

- **Fleet-scale interactive agent TUI** (`wa chat` / `wa fleet`): an OpenCode-style terminal UI that runs many coding agents concurrently across distributed scheduler infrastructure instead of a single local process — live dashboard, per-agent tail view, non-blocking approval queue, worktree pane.
- **Distributed scheduling & dispatch**: two-phase model routing (capability match, then hardware-aware placement) across local and remote fleet computers via an SSE task-pull loop; `wa ask`/`wa task run` transparently dispatch to whichever computer the Scheduler picks.
- **Git worktree isolation**: concurrent fleet agents each work in an isolated git worktree/branch, avoiding dirty-tree collisions; `wa jobs merge` reviews and merges completed branches back.
- **Non-blocking, 3-tier policy engine** (`allow` / `ask` / `deny`): every tool call — shell, git, filesystem — is authorized before it runs; an `ask` decision suspends only the requesting agent, not its siblings.
- **Command history as first-class data** (`wa history`): every `doctor`/`status`/`task run`/`task plan` invocation is persisted as a `Block` — command, status, stdout, exit code, linked execution — queryable by id, status, or command substring, and it survives process restarts.
- **Context you can actually attach** (`wa context add/remove/list/clear`): pull a prior Block's output into a task's context budget, verified to actually change the `ContextCompiler`'s token accounting, not just be stored and ignored.
- **Deterministic references** (`@123`, `@job:x`, `@agent:x`, `@model:x`, `@computer:x`, `@file:x`, or a bare execution id): no LLM involved in resolution — every reference is a direct registry/store lookup.
- **Explainable scheduling** (`wa explain <ref>`): renders the actual `SchedulerDecision` recorded at execution time — which model/computer/runtime was chosen and why — never recomputes one after the fact.
- **Runtime-agnostic**: a standardized `RuntimeAdapter` interface with implementations for Ollama and LM Studio today, auto-discovered on their local ports; no OpenAI-compatible adapter exists yet (see `PROGRESS.md`).
- **Pluggable persistence**: local JSON file store by default, or point `WAZIR_DATABASE_URL` at Postgres for a shared, multi-machine deployment — same `KeyValueStore` interface either way.

---

## Quick Start

Requires **Node.js 22.13 or newer** (Wazir's resource ledger uses `node:sqlite`).

```bash
npm install -g wazir        # once published; until then use a release tarball:
npm install -g ./wazir-<version>.tgz
wa doctor                   # check runtimes, agents and sandbox
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
You can install using Homebrew directly from the local formula or tap:
```bash
# Install from source checkout
brew install --build-from-source Formula/wazir.rb

# Or via Homebrew tap (when hosted on GitHub)
brew tap whassan007/wazir https://github.com/whassan007/wazir
brew install wazir
```

#### 3. Standalone Native Binary (Zero-dependency)
Package Wazir into a self-contained native binary using Node Single Executable Application (SEA):
```bash
npm run build:binary
# Standalone binary is produced at dist/wa (runs with no external Node.js required)
sudo cp dist/wa /usr/local/bin/wa
```

To run the test suite: `npm test`.

Then, with Ollama or LM Studio running locally:

```bash
wa doctor          # confirm runtimes/models are reachable
wa models list     # see what's discovered
wa ask "explain what this repository does"
```

---

## CLI command reference

| Command | What it does |
| --- | --- |
| `wa init` | Initialize the local Wazir control plane / config directory |
| `wa doctor` | Health check across config, persistence, runtimes, models, scheduler, policy |
| `wa status` | Concise operational snapshot |
| `wa ask <prompt>` | One-shot task with automatic model/computer selection |
| `wa task plan <prompt>` | Show the scheduling decision without executing (no execution record is created) |
| `wa task run <prompt>` | Run a task end-to-end through the real agent loop, policy-gated |
| `wa task status <id>` | Show a task's current status |
| `wa executions list` / `inspect <id>` / `replay <id>` | Inspect or replay a past execution's recorded event stream |
| `wa history` / `list` / `inspect <id>` | Browse persisted command history (Blocks) — see below |
| `wa context add/remove/list/clear <blockId>` | Manage what prior output feeds into the next task's context budget |
| `wa explain <ref>` | Explain the scheduling decision behind an execution, block, or job — see below |
| `wa chat` / `wa fleet` | Interactive fleet-scale multi-agent TUI |
| `wa jobs list` / `inspect <id>` / `merge <id>` | Manage fleet jobs, DAGs, and worktree merge-back |
| `wa computers list` / `inspect <id>` | Registered target computers (local + remote fleet) |
| `wa workers list` | Local worker daemon status |
| `wa runtimes list` / `inspect <id>` | Discovered Ollama/LM Studio runtimes and their health |
| `wa models list` / `inspect <id>` | Discovered models, capabilities, context window, instances |
| `wa agents list` | Registered coding agents |
| `wa tools list` | Registered tool implementations and their risk level |
| `wa policy inspect` | Current policy rules and configuration |
| `wa discover` | Force a fresh runtime/model discovery pass |
| `wa benchmark run` | Run a model benchmark |
| `wa config show` | Print effective configuration |

Most listing/inspection commands accept `--json` for machine-readable output.

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
```

---

## Fleet coding agent TUI (`wa chat` / `wa fleet`)

```bash
wa chat                                 # default concurrency limit of 4
wa chat --concurrency 8 --auto-merge    # higher concurrency, auto-merge on completion
wa chat --no-worktrees                  # run in-place, no git isolation
```

### Keyboard navigation

| Key | Action |
| --- | --- |
| `Tab` | Cycle views: Fleet Dashboard → Tail → Approval Queue → Worktrees → Help |
| `Up` / `Down` | Navigate agents in the fleet table |
| `Enter` | Tail the highlighted agent (live stream of turns/tool calls) |
| `Esc` | Return to the Fleet Dashboard |
| `y` / `n` | Approve / Deny the current pending policy request |
| `a` / `d` | Approve All / Deny All pending requests |

### In-TUI commands

- `/fanout t1; t2; t3` — decompose into N sub-tasks and run them concurrently, up to the concurrency limit
- `/steer <instruction>` — inject a mid-run instruction into the selected agent (or the whole fleet)
- `/cancel [taskId]` — cancel one agent, or the whole job if none is selected
- `/exit` or `q` — shut down the TUI

---

## Fleet job management (`wa jobs`)

```bash
wa jobs list
wa jobs inspect <job-id>              # per-task status + usage rollup
wa jobs merge <job-id> --target main  # merge completed worktree branches
```

---

## Distributed mode

By default the CLI only knows about the machine it's running on. Point it at a control-plane API to schedule across a real fleet:

```bash
export WAZIR_API_URL=http://control-plane-host:4800
wa ask "refactor the auth module" --computer dgx-primary
```

On startup, the CLI pulls the API's known computers/runtimes/models/instances into its own `Scheduler` registries (skipping anything matching its own local computer id), so a task can genuinely be placed on — and dispatched to — a remote machine over the API's SSE task-pull loop. See `Dockerfile`'s `api`/`worker` targets and `docker-compose.yml` for running the control plane itself.

### Control-plane authentication

A worker's reported result is fed straight back into the operator's agent loop as the model reply, so the control plane authenticates both sides:

| Variable | Where | Purpose |
| :-- | :-- | :-- |
| `WAZIR_API_TOKEN` | API, CLI, web | Operator bearer token for every `/api/v1/*` route and `/executions`. Optional on a loopback bind; the API refuses to bind any other address without it (override with `WAZIR_ALLOW_UNAUTHENTICATED=1`). |
| `WAZIR_REGISTRATION_TOKEN` | API, worker | Cluster secret a worker must present to register a new computer id or re-claim one after a restart. |
| `WAZIR_WORKER_TOKEN` | worker | Optional pre-shared per-computer token so a worker keeps a stable identity without the registration secret. |

Registration returns a per-computer token that the worker then sends on its heartbeat, task stream and result routes — only the process that registered a computer can receive its tasks or report on them. `local` is decided by the API from the transport, never from the registration payload, so `localOnly` tasks are never routed off-machine.

`docker-compose.yml` requires both cluster tokens and publishes every port on `127.0.0.1` only; put a TLS reverse proxy in front if other hosts must reach the API.

### Tool sandbox

Beyond the policy engine's allow/ask/deny decision, every `shell`, `git` and check-tool subprocess runs inside an OS sandbox when the host supports one: `bwrap` (bubblewrap) on Linux, `sandbox-exec` on macOS. Inside it the host filesystem is read-only, only the project directory and a private `/tmp` are writable, `$HOME` and other users' homes are hidden except for toolchain directories (`~/.nvm`, `~/.cargo`, package caches), runtime sockets under `/run` are masked, the network is unreachable unless the policy's `networkAccess` allows it, and on Linux a seccomp denylist refuses `mount`, `ptrace`, `unshare`/`setns`, module loading, `bpf` and similar. `WAZIR_SANDBOX=auto|required|bwrap|sandbox-exec|none` selects the backend — `required` fails closed instead of falling back to the host; the effective mode is stored on every tool call record and reported by `wa doctor`. On Ubuntu ≥ 23.10 install the shipped AppArmor profile (`scripts/apparmor/bwrap`) so bubblewrap may create user namespaces. See [docs/sandbox.md](docs/sandbox.md).

---

## Persistence

The default backend is a local JSON file at `~/.wazir/wazir.json` (`JsonFileStore`), safe for concurrent writers across processes via a cross-process file lock. Two other backends are available, checked in this order:

1. `WAZIR_DATABASE_URL=postgres://...` — `PostgresStore`, for a shared, multi-machine deployment. Run `docker compose up -d` to get one, or point at an existing instance.
2. `WAZIR_IN_MEMORY=1` — nothing persisted, useful for tests/CI.
3. Otherwise, the default local JSON file.

---

## Deployment

### Docker / Docker Compose

`Dockerfile` builds four targets from one multi-stage build: `api`, `worker`, `web`, `cli`.

```bash
docker compose up -d api worker web       # control plane + a worker + the dashboard
docker compose run --rm cli wa doctor     # one-off CLI commands against that stack
```

Set `WAZIR_OLLAMA_URL` / `WAZIR_LMSTUDIO_URL` in `.env` (see `.env.example`) so the `api`/`worker` containers can reach runtimes on the Docker host, e.g. `http://host.docker.internal:11434`.

### systemd (Linux)

Unit files in `scripts/systemd/`. Copy to `/etc/systemd/system/`, adjust the node/install paths, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wazir-api
sudo systemctl enable --now wazir-worker
```

### launchd (macOS)

For a headless compute worker (no dashboard) — distinct from the GUI `Wazir.app` produced by `npm run dmg`:

```bash
cp scripts/launchd/ai.wazir.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.wazir.worker.plist
```

---

## Directory structure

```
wazir/
├── apps/
│   ├── api/        # REST control plane (Express) — inventory + SSE task-pull dispatch
│   ├── web/         # Static dashboard, proxies to the API
│   ├── worker/       # Standalone worker daemon binary
│   └── cli/          # `wa` — commands, engine wiring, and the fleet TUI (src/tui/)
│
├── packages/
│   ├── core/               # Domain types, Scheduler, PolicyEngine, ExecutionEngine,
│   │                        # JobOrchestrator, ApprovalQueue, WorktreeManager, registries
│   ├── agents/              # CodingAgent turn loop (plan → implement → test → repair → verify)
│   ├── workers/             # Worker daemon: registration, heartbeat, SSE task-pull, remote dispatch
│   ├── runtimes/            # Runtime adapters: interfaces, Ollama, LM Studio
│   ├── scheduler/           # Deterministic, explainable task scheduling
│   ├── policies/            # Policy enforcement
│   ├── tools/                # Filesystem/shell/git/check tool implementations
│   ├── database/             # PostgresStore (KeyValueStore over Postgres) + reference SQL schema
│   ├── registry/              # Durable repository helpers over a KeyValueStore
│   ├── observability/         # Structured logging & metrics
│   ├── evaluation/            # Deterministic post-execution evaluation
│   ├── memory/                 # In-memory session/conversation store
│   └── shared/                  # KeyValueStore implementations (JSON file / in-memory), utils
│
├── scripts/            # macOS DMG builder, systemd units, launchd plist
├── docs/                # Feature/comparison notes
└── tests/                # Cross-cutting integration tests (package-local tests live in each package's own tests/)
```

## Cross-Platform Support

Wazir is engineered to run with zero OS emulation layers across Linux, macOS, and native Windows.

| Operating System | Architecture | Installation | Status | Verification & Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Linux** | x64 | `bash scripts/install.sh` | **VERIFIED** | GitHub Actions matrix (`ubuntu-latest`) & local runners. Bubblewrap sandbox supported. |
| **Linux** | ARM64 (DGX Spark) | `bash scripts/install.sh` | **VERIFIED** | Live validated on NVIDIA GB10 hardware. Local GPU telemetry & LM Studio routing active. |
| **macOS** | ARM64 (Apple Silicon) | `bash scripts/install.sh` | **VERIFIED** | GitHub Actions matrix (`macos-latest`). Mach-O binary packaging via Node SEA. |
| **macOS** | x64 (Intel) | `bash scripts/install.sh` | **VERIFIED** | Full CLI, TUI, and test suite compatible. Portable path & process-tree termination. |
| **Windows 11** | x64 (Native) | `& scripts\install.ps1` | **VERIFIED** | GitHub Actions matrix (`windows-latest`). Native launchers (`wa.cmd`, `wa.ps1`). No WSL2 required. Process trees terminated via `taskkill /T /F`. |
| **Windows 11** | ARM64 (Native) | `& scripts\install.ps1` | **VERIFIED** | Supported on Node.js ≥ 22.5 ARM64. Native PE binary packaging. |

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
- [Cross-Platform Compatibility Matrix](docs/compatibility-matrix.md)
- [Troubleshooting Guide](docs/troubleshooting.md)
- [Release Notes v0.1.59](docs/release-notes.md)

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
