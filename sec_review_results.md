# Wazir Security Assessment — Results

Scope: `sec_review.md` Part 3 prompt, applied to the working tree at commit
`209257b` (plus uncommitted changes to `policyEngine.ts` and friends) on
2026-09-18. Method: source reading of every file named in the Part 2 surface
map, plus empirical probes run with `vite-node` against the **TypeScript
source** (the `packages/*/dist` build output is three days stale relative to
`policyEngine.ts` and gives different, wrong answers — see F-16). No repository
files were modified; probe scripts live only in the session scratchpad.

> **Update 2026-09-18 (mitigation pass):** every finding in Section 11 has
> been remediated or explicitly accepted; see **Part 4** at the end of this
> file for the per-finding outcome, verification evidence and the revised
> verdict. Sections 1–15 below are the original assessment, unchanged.

**Verdict: SECURITY REVIEW PASSED WITH FINDINGS** — with two important
qualifications (Section 15). Wazir is usable by a single trusted operator on a
machine they control, but the policy perimeter that PROGRESS.md and the README
describe as "every tool call is authorized before it runs" can be bypassed by a
model-controlled agent in at least five independent ways without any human
approval, and every network-facing route is unauthenticated. In distributed
mode those two facts chain into remote code execution on the operator's
machine (Section 12, AP-1).

---

## 1. Trust boundary map

| Component | Files | Trust level | Notes |
| :-- | :-- | :-- | :-- |
| Operator CLI (`wa`) | `apps/cli/src/*` | **Trusted** | Runs tools on the host with the operator's UID; holds the only `PolicyEngine` instance that gates tool calls (`apps/cli/src/run.ts:260`). |
| PolicyEngine + ApprovalQueue | `packages/core/src/services/policyEngine.ts`, `approvalQueue.ts` | **Trusted (security perimeter)** | Only enforcement point between model output and host. Bypasses in Section 4. |
| Filesystem/shell/git/check tools | `packages/tools/src/*` | **Semi-trusted** | `assertInsideProject` is sound for `read`/`write`/`edit`; `shell` runs `sh -c <model text>` (`process.ts:18-21`) with the operator's full environment. |
| CodingAgent | `packages/agents/src/codingAgent.ts` | **Untrusted input, trusted code** | Every tool call it emits originates from model text. |
| Model / runtime (Ollama, LM Studio) | `packages/runtimes/*` | **Untrusted** | Output is attacker-controlled under the "compromised model" persona. Adapters talk plain HTTP to `localhost` ports with no auth (inherent to those products). |
| Control-plane API | `apps/api/src/server.ts`, `main.ts` | **Untrusted network surface** | Zero authentication on every route. Binds `127.0.0.1` by default (`main.ts:4`), but the Docker image sets `WAZIR_HOST=0.0.0.0` (`Dockerfile:33`) and Compose publishes `4800:4800`. |
| Worker | `packages/workers/src/worker.ts` | **Semi-trusted** | Executes *inference only* (`taskExecutor.ts`), never tools — so a malicious control plane cannot get shell on a worker, only consume its GPU and read its prompts. |
| Persistence | `packages/shared/src/store.ts`, `packages/database/src/postgresStore.ts` | **Trusted** | Correct parameterised SQL; JSON store is world-readable (F-12). |
| MCP client | `packages/core/src/services/mcpClient.ts` | **Inactive** | Never instantiated anywhere outside its own file (confirmed by grep). Only `mcp:*` policy denial is live. |
| External agent (OpenCode) | `packages/agents/src/externalAgent.ts` | **Semi-trusted, opt-in** | Only reachable via `--agent opencode`; `taskTypes: []` keeps it out of auto-routing (already regression-tested in `tests/runtime/liveModelMatrix.test.ts`). |

Documentation vs. implementation deltas found:
- README says "every tool call — shell, git, filesystem — is authorized before it runs." True at the call site; false in effect (Section 4).
- PROGRESS.md says "permissive CORS." There is **no** CORS middleware at all in `server.ts`; browsers will block cross-origin *reads*, and `express.json()` requires a JSON content-type so browser CSRF needs a preflight (which fails). The real problem is the absence of auth, not CORS.
- `approve.ts` promises "Non-interactive sessions always deny." That code path is unreachable — see F-9.

---

## 2. Threat model results

| Persona | Can they… | Result |
| :-- | :-- | :-- |
| Unauthenticated network attacker (API reachable) | register a rogue computer, subscribe to any computer's SSE stream, read every prompt (which embeds repository context), forge task outcomes, dispatch inference to any worker | **Yes to all** (F-1, F-2, F-3). |
| Malicious / compromised model | run arbitrary commands with no approval | **Yes** — five independent routes (F-4..F-8). |
| Malicious model | read files outside the project root | **Yes** via `cat`/`head`/`grep` (F-5); **no** via the `read` tool. |
| Malicious model | write files outside the project root | **Yes** via `sort -o`, `find -fprint`, `git log --output=` (F-8); **no** via `write`/`edit`/redirects. |
| Malicious model | tamper with sibling worktrees | Only through the shell bypasses above; `assertInsideProject` itself holds. |
| Rogue worker | spoof hardware to attract scheduling | **Yes** (F-3); impact is limited to compute-theft/DoS and prompt disclosure because workers only run inference. |
| Malicious MCP server | reach execution | **No** — `MCPClient` is unwired; `mcp:*` tools are denied unless allow-listed. Policy check is on server name only, so a server that is allow-listed can expose any tool name (design note, not a live bug). |

---

## 3. API surface audit (`apps/api/src/server.ts`)

Every route below accepts requests with no credential of any kind. There is no
middleware between `express.json()` (`server.ts:222`) and the handlers.

| Route | Auth | Concrete abuse |
| :-- | :-- | :-- |
| `POST /computers/register` (`:319`) | none | Register any id with any `hardware` claims; **re-registering an existing id overwrites its record** (`ComputerRegistry.register` merges by id). |
| `POST /computers/:id/heartbeat` (`:329`) | none | Forge load/health for any computer → steer the scheduler. |
| `GET /computers/:id/tasks/stream` (`:346`) | none | **Stream hijack**: `TaskDispatcher.subscribe` (`:54`) does `streams.set(computerId, res)`, silently replacing the legitimate worker's stream. All subsequent dispatches (full prompt, tools, repo context) go to the attacker; queued tasks are flushed to the first subscriber. |
| `POST /api/v1/tasks/dispatch` (`:369`) | none | Send inference to any registered worker (compute theft; also the only place `WorkerExecutionRequest` enters the system — the worker trusts it). |
| `GET /api/v1/tasks/:requestId/status` (`:395`) | none | Read another operator's streamed model output. `requestId` is `generateId()` = `Date.now()` + `Math.random().toString(36)` (`packages/shared/src/utils.ts:2`) — not cryptographically random, and the timestamp half is guessable. |
| `POST /computers/:id/executions/:requestId/{events,result}` (`:405`, `:421`) | none; `:id` is never checked against the channel's `computerId` | **Outcome forgery**: any client that knows a `requestId` can resolve it with arbitrary `output`. The CLI treats that output as the model's reply and feeds it to the agent loop (`run.ts:235-246`). |
| `POST /executions` (`:438`) | none | Unbounded append to `state.executions` (memory DoS). |
| `GET /api/v1/executions/:id` (`:307`) | none | Uses `includes()` — substring match returns arbitrary other executions. |

Cross-reference: `tests/integration/trackedSecurityDebt.test.ts` already
asserts the no-auth state for `/computers/register` and `/tasks/dispatch`.
It does **not** cover stream hijack or result forgery, which are the two
routes that turn "no auth" into an active attack.

---

## 4. PolicyEngine audit — bypass verification

All probes were executed with `vite-node` against
`packages/core/src/services/policyEngine.ts` (current source) using
`PolicyEngine.classify()` exactly as `run.ts:261` calls it. The shell tool
executes the *same string* via `sh -c` (`packages/tools/src/process.ts:18-21`).

### 4.1 What holds (verified)

`&&`, `||`, `;`, `|`, `&`, `$(...)`, backticks, `env`/`xargs` unwrapping,
`find -exec`, redirects outside the project, `eval`, `exec`, absolute paths to
denied binaries, and `X=sudo; $X id` all classify as `deny` or `ask`. The
uncommitted diff adding substitution inspection inside quoted words works.
`node`/`npm`/`npx`/`bun`/`pip` → `ask`. Git verbs `push`/`clean`/`reset --hard`
→ `deny`. `write`/`edit` to `../x` or `/etc/passwd` → `deny`.

### 4.2 Confirmed bypasses (all produce `allow`)

| # | Input (`shell` tool unless noted) | Classification | What `sh -c` actually does |
| :-- | :-- | :-- | :-- |
| B-1 | `"ls\nsudo reboot"` | `allow` / `shell-safe-allow` | Runs `ls`, then `sudo reboot`. `shell-quote` treats `\n` as whitespace, so both lines land in one segment whose first word is `ls`. Proven: `sh -c 'echo first\necho INJECTED'` prints both. |
| B-2 | `rg --pre "sh -c <anything>" pattern .` | `allow` | ripgrep executes the `--pre` command on every file. Arbitrary code under an allow-listed binary. |
| B-3 | `cat /etc/passwd`, `cat ~/.ssh/id_rsa`, `head`, `grep -r . /home` | `allow` | Unrestricted host **read**; the `read` tool would deny the same path. Contents are persisted into the execution record and `~/.wazir/wazir.json`. |
| B-4 | `sort -o /tmp/pwned /etc/hostname`, `find . -fprint /tmp/out` | `allow` | Host **write** outside the project; redirect detection only covers shell `>` operators, not flag-based output. |
| B-5 | `git` tool: `["config","core.fsmonitor","<cmd>"]` then `["status"]` | `allow` (both, `git-read-allow`) | Git runs the fsmonitor hook on the next `status`/`diff`. Proven in a temp repo: `git config core.fsmonitor 'echo FSMONITOR-EXECUTED'` + `git status` printed the marker. `config alias.status '!cmd'` is equivalent. |
| B-6 | `git` tool: `["branch","-D","main"]`, `["remote","set-url","origin",…]`, `["--git-dir=/x","status"]`, `["log","--output=/tmp/x"]` | `allow` | Branch deletion, remote rewrite, out-of-repo access, out-of-project write — all under the "read-only" rule. |
| B-7 | `write` tool: `package.json` (`allow`), then `test` tool | `allow` (`filesystem-project-allow` + `project-checks-allow`) | The check-tool gate (`process-tools.ts:113`) only verifies the script *name* exists. The agent can first write `"scripts":{"test":"curl … \| sh"}` and then call `test`. `npm run` also executes `pretest`/`posttest`. This bypasses the `npm`→`ask` rule entirely. |
| B-8 | `write` tool: `.git/hooks/pre-commit`, `.git/hooks/post-checkout`, `.git/config` | `allow` | `.git` is inside the project root and not excluded. `fleetRunner.ts` and `WorktreeManager` then run `git worktree add` / `git commit` as **trusted orchestrator code with no policy check**, executing the hook. |
| B-9 | `printenv` / `env` | `allow` | Dumps the CLI process environment (child inherits `process.env`, `process.ts:48`) — `WAZIR_DATABASE_URL` credentials, any API keys — into the execution record. |

Wrapper edge (informational): `nice -n 5 sudo id` → `ask` (safe, because
`resolveCommand` mis-parses `5` as the command; conservative but by accident).

### 4.3 Enforcement invariants

- `apps/cli/src/run.ts:261` — every agent tool call goes through
  `policy.authorize()`. ✔
- `packages/core/src/services/jobOrchestrator.ts` — receives `policy` and the
  fleet path uses the same `executeTool` shape. ✔ (not re-probed; same engine
  instance).
- Worker loop — executes no tools, so nothing to authorize. ✔
- `wa exec replay` (`commands.ts:351`) only **renders** stored events; it never
  re-executes anything, so "replay under current policy" is trivially
  satisfied. `tests/integration/policyBypassSweep.test.ts` entry point 4 tests
  a real re-authorize call, which is stronger than what the CLI does.
- Orchestrator-initiated git operations (`worktreeManager.ts:133-153`,
  `189-190`, `242-247`) are **not** policy-gated. That is by design (they are
  Wazir's own commands) but it is what makes B-8 exploitable.

---

## 5. Agent isolation & worktrees (`worktreeManager.ts`)

- `worktreeDir = path.resolve(rootDir, \`${jobId}-${taskId}\`)` (`:92`) with no
  validation, and **`cleanupDirectory(worktreeDir)` runs `fs.rm(…,
  {recursive:true, force:true}) before creation** (`:115`, `:302`). A `jobId`
  of `../../..` would delete an arbitrary directory. Today `jobId` comes from
  `JobManager` (generated) and `taskId` may be caller-supplied
  (`jobManager.ts:55-68`) but only through the operator's own TUI, so this is
  **latent**, not reachable by an attacker. Rated MEDIUM as a missing
  defence-in-depth check.
- Branch names `wazir/<jobId>/<taskId>` are passed as positional args after a
  fixed verb; a value starting with `-` would be interpreted as a flag by
  `git worktree add -b <branch>` — same latent-only status.
- `mergeBranch` runs `git checkout <target>` where `<target>` is `wa jobs
  merge --target` (operator input). Low.
- The `--force -B` fallback (`:148-153`) will reset an existing branch on
  retry — data-loss risk, not security.
- Non-git fallback copies the whole project with a substring filter
  (`!source.includes('.wazir')`) — any path containing the string `.wazir`
  or `node_modules` anywhere is skipped; harmless.
- Failure isolation: a hook installed via B-8 executes in the *main*
  repository's `.git` (worktrees share it), so one agent can affect all
  siblings and the operator's next manual `git commit`.

---

## 6. Filesystem sandboxing (`packages/tools/src/paths.ts`, `filesystem.ts`)

- `assertInsideProject` checks lexically, then `realpath`s the root and the
  deepest existing ancestor of the target. Symlink-inside-pointing-outside,
  symlink chains, and `..`+symlink combinations are all rejected. ✔
- TOCTOU: the check and the `fs.readFile`/`fs.writeFile` are separate
  syscalls with no `O_NOFOLLOW`/fd-relative access; a symlink swapped in
  between would win. Exploiting it requires a concurrent writer inside the
  project (i.e. the agent itself via shell — which already has B-1). Rated
  LOW on its own.
- `.git/` and `package.json` are not protected from `write`/`edit` (B-7, B-8).
- Policy-layer check (`policyEngine.ts:321`) is lexical only; the realpath
  check lives in the tool. Both run, so the layering is fine.
- Temporary files: `JsonFileStore.persist` writes `<file>.<pid>.<ts>.tmp`
  then renames — atomic. ✔

---

## 7. Secrets, environment & redaction

- `grep -rniE "redact|sanitize|scrub"` across `packages/` and `apps/`: **zero
  hits**. There is no redaction layer anywhere.
- Tool output (first 4000 chars) is persisted per call (`run.ts:292`),
  `Block.stdout` up to `MAX_STDOUT_SIZE`, and check output 4000 chars — all
  into `~/.wazir/wazir.json` (currently 1.5 MB, mode `0664`, F-12) or
  Postgres.
- The shell child inherits the full `process.env` (`process.ts:48`) and
  `env`/`printenv` are on the safe list (B-9). `WAZIR_DATABASE_URL` in the
  Compose `cli` service (`docker-compose.yml`) contains credentials.
- `--json` outputs (`wa exec inspect --json`, `wa history list --json`) dump
  the raw records — no sanitisation is applied anywhere, so `--json` doesn't
  "bypass" a filter; there is none to bypass.
- `wa explain` renders scheduling reasons only; no secret material observed
  in `SchedulerDecision`.

---

## 8. Persistence & data integrity

- **`PostgresStore`**: all statements parameterised (`$1`), `escapeLike`
  escapes `%` and `_` for the prefix `LIKE`. No injection. ✔
- **`JsonFileStore`**: `open(…, 'wx')` lock, 30 s stale expiry, 10 s wait.
  Two processes that both observe a stale lock can both `unlink` and both
  acquire (`store.ts:46-50`) — a narrow double-writer window after a crash;
  LOW.
- `reviveDates` regex could turn a legitimately ISO-shaped *string* value into
  a `Date` (data fidelity, not security).
- `reviveDatesDeep` assigns `out[k] = …` for every key including `__proto__`,
  which sets that object's prototype rather than polluting the global
  prototype. Only reachable if hostile JSON is already in the store. LOW/INFO.
- File is created with default umask → `-rw-rw-r--` on this host (F-12).

---

## 9. Terminal / CLI / references

- `@file:<path>` (`references.ts:88-94`): `path.resolve(projectRoot, value)`
  with **no containment check**, then `fs.access`. `@file:../../../../etc/shadow`
  reveals existence of any host path (oracle only; no content read). LOW —
  operator-only input, but inconsistent with the "existence-checked against
  project root" claim in the README.
- `@job:`/`@agent:`/`@model:`/`@computer:` are registry lookups. ✔
- ANSI: tool output and model text are printed via `color.*` helpers without
  stripping escape sequences from *content*; a model can emit terminal escape
  sequences into the operator's terminal. LOW.

---

## 10. Worker, runtime & model-provider security

- Workers execute **inference only** (`taskExecutor.ts:31-40`); tool calls
  are returned as events and executed on the CLI side under policy. A
  malicious control plane therefore cannot obtain shell on a worker. ✔
- A malicious/hijacked control plane *can*: read every prompt the worker is
  sent (nothing to prevent — the worker asked for them), keep the GPU busy
  indefinitely (no per-request timeout on the worker side), and route unknown
  `modelId`s to "the first healthy runtime" (`worker.ts:140`).
- Worker registration is `local: true` for every remote worker
  (`worker.ts:197`) — this makes `policy.localOnly` meaningless in
  distributed mode: the scheduler's "local-only" filter
  (`scheduler.ts:252`) would accept a remote computer. MEDIUM correctness/
  security gap.
- `contextTokens` → `num_ctx` (Ollama) is a numeric field in a JSON body; no
  injection. Model ids are JSON string values; no SSRF vector (base URL is
  operator-configured).
- `hardwareDiscovery.ts` uses `execSync` with fixed strings — no injection.
- Ollama/LM Studio on `localhost:11434`/`1234` are unauthenticated by nature;
  Wazir adds no additional exposure.

---

## 11. Security gap register


Severity is assessed for the **intended deployment models** stated in
README/PROGRESS.md: (a) single operator, local CLI; (b) distributed mode with
`apps/api` reachable by workers. "Reproducibility" cites the probe used
(`vite-node` against TS source, temp git repo, or `curl` against a local
`apps/api` instance) or the existing test that already pins the behaviour.

| ID | Severity | Component & File | Finding Title | Type | Evidence (Line & Code) | Exploit / Abuse Path | Impact | Existing Control | Missing Control | Reproducibility |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| F-1 | **CRITICAL** (distributed) / INFO (local-only bind) | `apps/api/src/server.ts:346`, `:54` | SSE task-stream hijack by `computerId` | Missing AuthN + insecure design | `TaskDispatcher.subscribe()` does `streams.set(computerId, res)` — last subscriber wins; no identity proof on `GET /computers/:id/tasks/stream` | Attacker `curl -N /computers/<victim-id>/tasks/stream` → receives every subsequent `WorkerExecutionRequest` (prompt, repo context, tool schema) for that worker; legitimate worker silently starved | Prompt/source disclosure; DoS of the victim worker; precondition for F-2 | None (tracked as debt: "Zero API Authentication") | Per-computer bearer token issued at registration, verified on stream/heartbeat/result; reject duplicate live streams | `curl` against `npm run dev -w @wazir/api`; not covered by `trackedSecurityDebt.test.ts` |
| F-2 | **CRITICAL** (distributed) | `apps/api/src/server.ts:405`, `:421`; `apps/cli/src/run.ts:235-246` | Task-outcome forgery → RCE on operator machine | Missing AuthN/AuthZ (result path) | `POST /computers/:id/executions/:requestId/result` never checks that `:id` matches the channel's `computerId` or that the caller is the dispatched worker; CLI feeds `output` into the agent loop as the model reply | Attacker (with F-1, or a guessed `requestId`) posts `{"output":"<tool call: shell, ls\nsudo …>"}`; CLI parses it as a model action and runs it under policy — which F-4..F-8 bypass | Arbitrary code execution on the operator's host without approval | None | Result must carry a per-request nonce/HMAC bound to the dispatched computer; reject results from any other channel | `curl` + local `wa run --computer <remote>`; **not** tested anywhere |
| F-3 | HIGH (distributed) | `apps/api/src/server.ts:319`, `:329`; `packages/core/src/services/computerRegistry.ts` (`register` merges by id) | Rogue/spoofed worker registration & record overwrite | Missing AuthN + missing attestation | Any client can `POST /computers/register` with arbitrary `hardware`, and re-registering an existing `id` overwrites the trusted record; heartbeats likewise unauthenticated | Attacker claims 8×H100 → scheduler routes all jobs to it; or overwrites the real worker's `runtimes`/`endpoint` fields | Compute theft, prompt disclosure, scheduler manipulation/DoS | None; `trackedSecurityDebt.test.ts:36` pins the no-auth state | Registration token; first-writer-wins on `id` or signed re-registration; hardware claims marked "self-reported" and not trusted for priority | `trackedSecurityDebt.test.ts` (partial) |
| F-4 | **HIGH** | `packages/core/src/services/policyEngine.ts` (`splitSegments`, shell-quote parse) ; `packages/tools/src/process.ts:18-21` | Newline command injection bypasses shell policy | Policy bypass (parser/executor mismatch) | `shell-quote` treats `\n` as whitespace, so `"ls\nsudo reboot"` is one segment with first word `ls` → `shell-safe-allow`; `sh -c` executes both lines | Model emits `{"tool":"shell","command":"ls\nrm -rf ~"}` | Arbitrary command execution with zero approval | AST-based segment splitting (`&&`, `;`, `\|`, subshells all handled) | Reject or split on `\n`/`\r` before parsing; or execute `sh -c` only on a single re-serialised segment | `vite-node` probe: `classify({tool:'shell',input:{command:'ls\nsudo reboot'}})` → `allow` |
| F-5 | HIGH | `policyEngine.ts` safe-command allow-list (`cat`, `head`, `grep`, `rg`, …) | Unrestricted host **read** through allow-listed commands | Policy design gap (path containment not applied to shell args) | `cat /etc/passwd`, `cat ~/.ssh/id_rsa`, `grep -r . /home` → `shell-safe-allow`; `read` tool on same path → `deny` | Model reads any file the operator can read; output persisted (`run.ts:292`) into `~/.wazir/wazir.json` / Postgres | Secret exfiltration (SSH keys, `.env`, cloud creds) via execution records | `assertInsideProject` for `read`/`write`/`edit` only | Apply the same lexical containment to path-shaped args of safe commands, or run shell in a sandbox with project-only mounts | `vite-node` probe |
| F-6 | HIGH | `policyEngine.ts` safe list (`rg`) | `rg --pre` executes arbitrary command under an allow-listed binary | Policy bypass (dangerous flag on safe binary) | `rg --pre "sh -c id" x .` → `allow`; ripgrep runs the preprocessor per file | Model uses `--pre` to run any payload | Arbitrary code execution, no approval | Flag inspection exists for `find -exec`/`-delete` only | Deny-list of code-executing flags per safe binary (`rg --pre`, `git -c core.*`, `sort --compress-program`, `less`/`vim` shells, `awk system()`, …) | `vite-node` probe |
| F-7 | HIGH | `policyEngine.ts` `git-read-allow` rule (`git` tool) | `git config` / non-read verbs allowed as "read-only" → hook-based code execution & destructive ops | Policy bypass (verb classification) | `["config","core.fsmonitor","<cmd>"]` then `["status"]` → both `allow`; `["branch","-D","main"]`, `["remote","set-url",…]`, `["--git-dir=/x","status"]`, `["log","--output=/tmp/x"]` → `allow` | Model sets `core.fsmonitor`/`alias.status='!cmd'` then triggers it; or deletes branches / rewrites remotes | Code execution; repository destruction; write outside project | `push`/`clean`/`reset --hard` → `deny`; commit/add → `ask` | Whitelist of read verbs (`status`,`log`,`diff`,`show`,`rev-parse`,`ls-files`, …) with flag validation; deny `config`, `--git-dir`, `--work-tree`, `-c`, `--output` | Reproduced in temp repo: fsmonitor marker printed on `git status` |
| F-8 | HIGH | `policyEngine.ts` redirect detection (`>` operators only) | Host **write** outside project via flag-based output (`sort -o`, `find -fprint`, `git log --output=`) | Policy bypass (output path not via shell redirect) | `sort -o /tmp/pwned /etc/hostname`, `find . -fprint /tmp/out` → `allow` | Model writes attacker content to `~/.bashrc`, `~/.ssh/authorized_keys`, cron dirs | Persistence / host takeover | Redirects outside project → `deny` | Same per-binary flag deny-list as F-6, or sandboxed execution | `vite-node` probe |
| F-9 | HIGH (operational) / MEDIUM (security) | `apps/cli/src/engine.ts:240-251`; `policyEngine.ts:206-236`; `approvalQueue.ts:44-47` | `ask` tier: interactive approver is dead code; headless runs hang forever; `WAZIR_AUTO_APPROVE=1` converts every `ask` to `allow` | Broken control / unsafe env override | `approvalQueue` is always passed, so `resolveAsk` returns before ever reaching `approveCallback` (`createApprover`, with its TTY/deny logic, is unreachable). Only `FleetTui` (`fleetTui.ts:188-206`) resolves queue items. `defaultTimeoutMs`/`autoDenyNonInteractive` are declared but never read | (a) `wa run` outside the TUI blocks indefinitely on the first `ask`; (b) any process/CI that sets `WAZIR_AUTO_APPROVE=1` (or a model that persuades the operator to) silently elevates all `ask` → `allow`, including `npm`, `node`, `git commit` | Silent privilege elevation of the whole middle tier; "never silently allows" promise not met | `WAZIR_AUTO_DENY=1` honoured | Wire timeout/deny fallback in `enqueue`; fall back to `approveCallback` when no TUI subscriber; gate `WAZIR_AUTO_APPROVE` behind explicit config, log loudly | Code reading; `policyEngineShell.test.ts` does not cover the queue path |
| F-10 | HIGH | `packages/tools/src/process-tools.ts:113` (`checkTool`); `policyEngine.ts` `project-checks-allow` | Check-tool gate validates script *name* only → `npm run` of model-written script | Policy bypass (two-step) | `write package.json` → `filesystem-project-allow`; `test` tool → `project-checks-allow`; `npm run test` executes `pretest`/`test`/`posttest` | Model writes `"test":"curl … \| sh"` then calls `test` | Arbitrary code execution; sidesteps the `npm`→`ask` rule | Script must exist in `package.json` | Treat `package.json` (and lockfiles, `.npmrc`) as protected paths requiring `ask`; snapshot script bodies at session start and require `ask` if changed | `vite-node` probe of both classifications |
| F-11 | HIGH | `policyEngine.ts:321` (lexical containment); `worktreeManager.ts:133-153,189-190,242-247`; `apps/cli/src/fleetRunner.ts` | `.git/` writable by `write`/`edit` → hooks executed by ungated orchestrator git calls | Policy design gap (no protected-path list) | `write .git/hooks/post-checkout` → `allow`; `WorktreeManager` runs `git worktree add` (executes `post-checkout`) with no `policy.authorize()` | Model plants a hook; next job/worktree/commit by Wazir or the operator runs it in the *shared* `.git` | Code execution; cross-agent contamination; persists after session | None | Deny `write`/`edit`/`shell` targets under `.git/`, `.wazir/`, `.husky/`, `package.json`; run orchestrator git with `-c core.hooksPath=/dev/null` | `vite-node` probe; temp-repo hook test |
| F-12 | MEDIUM | `packages/shared/src/store.ts` (`persist`) | `~/.wazir/wazir.json` created with default umask (`0664`), holds tool output/prompts/env dumps unencrypted | Data-at-rest exposure | `ls -la ~/.wazir/wazir.json` → `-rw-rw-r--`, 1.5 MB | Any local user/group member reads all execution history incl. F-5/F-13 leakage | Secret disclosure | Atomic tmp+rename | `mode: 0o600` on tmp file and directory `0700`; optional redaction before persist | `ls -la` |
| F-13 | MEDIUM | `policyEngine.ts` safe list (`env`, `printenv`); `packages/tools/src/process.ts:48` | Environment dump into execution records | Secret leakage | Child inherits full `process.env`; `env`/`printenv` → `allow`; output stored (`run.ts:292`) | Model runs `env` → `WAZIR_DATABASE_URL`, API keys, tokens land in store/Postgres/`--json` output | Credential disclosure | None (no redaction layer anywhere — `grep -rniE redact\|sanitize\|scrub` → 0 hits) | Minimal env for children (allow-list); remove `env`/`printenv` from safe list; redaction filter on persisted output | `vite-node` probe + `grep` |
| F-14 | MEDIUM (latent) | `packages/core/src/services/worktreeManager.ts:92`, `:115`, `:302` | Unvalidated `jobId`/`taskId` in worktree path; `fs.rm(recursive,force)` before create | Missing input validation (defence-in-depth) | `path.resolve(rootDir, \`${jobId}-${taskId}\`)`; `cleanupDirectory()` recursively deletes it first | `taskId='../../..'` → deletes an arbitrary directory. Currently only reachable from operator's own TUI/CLI input | Data destruction if IDs ever come from network/model (e.g. via `POST /api/v1/tasks/dispatch` payloads in future) | IDs generated by `JobManager` today | Regex-validate ids (`^[A-Za-z0-9_-]+$`), assert resolved path under `rootDir`, and pass `--` before positional git args | Code reading |
| F-15 | MEDIUM | `packages/workers/src/worker.ts:197`; `packages/core/src/services/scheduler.ts:252` | Remote workers register `local: true` → `policy.localOnly` filter is void | Policy correctness gap | Registration payload hard-codes `local: true`; scheduler's local-only filter therefore admits remote computers | Task marked `localOnly` (e.g. sensitive repo) is dispatched over network to a remote/rogue worker (F-3) | Data-locality promise broken; prompt/source leaves the machine | `localOnly` flag exists | Server derives `local` from transport (in-process registry vs. HTTP registration), never from the client | Code reading; `goldenScenariosAndScheduler.test.ts` does not cover it |
| F-16 | MEDIUM (process) | `packages/core/dist/services/policyEngine.js` (Sep 15) vs `src/…ts` (Sep 18); `apps/cli/package.json` `main: ./dist/index.js` | Shipped `dist/` is stale relative to policy source; `wa` runs the old engine | Build/release integrity | `ls -la` timestamps; CLI resolves `@wazir/core` via `dist/src/index.js` | Operator runs `wa` believing the newer (quoted-substitution) fixes are active; the uncommitted policy hardening is not in effect until `npm run build` | False sense of security; test results (vitest on TS) diverge from runtime behaviour | Vitest runs against source | CI step that fails when `dist` is older than `src`; `prepack`/`postinstall` build; or ship via `tsx` | `ls -la` |
| F-17 | MEDIUM | `apps/api/src/server.ts:395`; `packages/shared/src/utils.ts:2` | Guessable `requestId`/`executionId` (`Date.now()` + `Math.random`) | Weak identifier entropy | `generateId()` is non-cryptographic; timestamp prefix narrows search space | Enumerate `GET /api/v1/tasks/:requestId/status` to read others' streamed output; pair with F-2 to forge results without F-1 | Disclosure; enables forgery | None | `crypto.randomUUID()` / 128-bit random ids | Code reading |
| F-18 | MEDIUM | `apps/api/src/server.ts:307` | `GET /api/v1/executions/:id` uses substring `includes()` | Broken object-level authorisation | Match on `id.includes(param)` returns first partial match | `GET /api/v1/executions/a` returns an arbitrary execution | Disclosure | None | Exact-match lookup | `curl` |
| F-19 | MEDIUM | `apps/api/src/server.ts:438`, `TaskDispatcher.queues` | Unbounded in-memory growth (`POST /executions`, queued tasks per computer) | DoS | No size caps, no eviction | Loop `POST /executions` or dispatch to an offline computer | Control-plane OOM | None | Bounded queues; per-source rate limit; body size limit on `express.json()` | `curl` loop (not run) |
| F-20 | LOW | `packages/tools/src/paths.ts` + `filesystem.ts` | TOCTOU between `assertInsideProject` and `fs.readFile/writeFile` | Race | Separate `realpath` check and open; no `O_NOFOLLOW` / fd-relative ops | Requires a concurrent writer inside project (the agent via F-4) — already superseded | Symlink escape | Realpath check | Open with `O_NOFOLLOW`, verify via `fstat`, or operate on an fd | Code reading |
| F-21 | LOW | `packages/shared/src/store.ts:46-50` | Stale-lock double-acquire | Race | Two processes both see stale lock, both `unlink`+`open('wx')` | Post-crash concurrent CLIs | Lost write | 30 s stale expiry | Rename-based lock steal or `flock` | Code reading |
| F-22 | LOW | `apps/cli/src/references.ts:88-94` | `@file:` reference resolver has no project containment (existence oracle) | Path traversal (info) | `path.resolve(projectRoot, value)` + `fs.access` | `@file:../../../../etc/shadow` reveals existence | Info disclosure (operator input only) | None | `assertInsideProject` on the resolved path | Code reading |
| F-23 | LOW | `apps/cli/src/*` output helpers | Model/tool output printed without stripping ANSI/OSC escapes | Terminal injection | `color.*` wraps but does not strip content | Model emits OSC 52 / cursor tricks / title changes | Operator terminal spoofing | None | Strip `\x1b[...`, `\x1b]...` from untrusted content | Code reading |
| F-24 | LOW | `packages/shared/src/store.ts` (`reviveDatesDeep`) | Prototype-key assignment on hostile JSON | Data integrity | `out[k] = …` including `__proto__` sets that object's prototype (not global) | Requires hostile JSON already in the store | Object behaviour change | JSON.parse (no global pollution) | Skip `__proto__`/`constructor` keys | Code reading |
| F-25 | INFO | `packages/core/src/services/mcpClient.ts`; `policyEngine.ts` `mcp-explicit-approval` | MCP policy checks server name only, not tool name; client unwired | Design note | `mcp:<server>:<tool>` → allow if `<server>` allow-listed regardless of `<tool>` | None today (unwired) | Future: allow-listed server exposes dangerous tool | Server allow-list; `policyBypassSweep` entry point 5 | Tool-level allow-list before wiring | `policyBypassSweep.test.ts:225` |
| F-26 | INFO | `Dockerfile:33`, `docker-compose.yml:27` | Container image binds `0.0.0.0:4800` and publishes the port | Insecure default (container) | `ENV WAZIR_HOST=0.0.0.0`, `- '4800:4800'` | Turns F-1/F-2/F-3 from "loopback-only" into LAN/Internet-reachable | Escalates every API finding | Local default `127.0.0.1` (`main.ts:4`) | Publish on `127.0.0.1:4800:4800`; document that auth is absent | Config reading |
| F-27 | INFO (tracked debt) | Host process execution | No container/sandbox for tool execution | Tracked architectural debt | `trackedSecurityDebt.test.ts:102` | Root cause that makes F-4..F-8, F-10, F-11 host-level rather than sandbox-level | Host takeover | None | gVisor/bwrap/Docker sandbox with project-only mounts and minimal env | `trackedSecurityDebt.test.ts` |
| F-28 | INFO (tracked debt) | `apps/api` `/metrics` | Metrics exporter unwired | Tracked debt | `trackedSecurityDebt.test.ts:123` | n/a | Observability only | — | — | `trackedSecurityDebt.test.ts` |

---

## 12. Attack-path mapping (HIGH / CRITICAL)

### AP-1 — Remote attacker → operator host RCE (distributed mode)

```
Unauthenticated network attacker (API reachable: Docker default 0.0.0.0:4800, F-26)
  │
  ▼ [Entry Point]
GET /computers/<victim>/tasks/stream            (F-1: last subscriber wins)
  │   ← receives WorkerExecutionRequest {requestId, prompt, tools, repo context}
  ▼ [Trust Boundary Crossing]
POST /computers/<any>/executions/<requestId>/result   (F-2: no channel/identity check)
  │   body.output = a well-formed agent action: {"tool":"shell","command":"ls\ncurl … | sh"}
  ▼ [Privilege Escalation]
CLI run.ts treats output as model reply → policy.authorize()
  │   → 'allow' via F-4 (newline) — or F-6 / F-7 / F-8 / F-10 / F-11 as alternates
  ▼ [Target & Impact]
sh -c on the operator's machine, operator UID, full env (F-13) → host takeover,
credential exfiltration, persistence via ~/.bashrc (F-8) or .git/hooks (F-11)
```
Without F-1 the attacker can still reach step 2 by guessing `requestId` (F-17).

### AP-2 — Compromised / prompt-injected model → host RCE (local mode)

```
Malicious model output (or prompt injection in repo files / web content the agent reads)
  │
  ▼ [Entry Point]
CodingAgent.parseAction → tool call {shell|git|write|test}
  │
  ▼ [Trust Boundary Crossing]  PolicyEngine.classify → 'allow'
  F-4  "ls\n<payload>"                       F-6  rg --pre "<payload>"
  F-7  git config core.fsmonitor + git status F-10 write package.json → test
  F-11 write .git/hooks/* → orchestrator git  F-8  sort -o ~/.bashrc
  │
  ▼ [Privilege Escalation / Lateral Movement]
Host shell as operator; F-5 reads ~/.ssh, .env; F-11 hook persists into the shared
.git and fires for every sibling worktree and for the operator's own next commit
  │
  ▼ [Target & Impact]
Host takeover, secret exfiltration (results stored world-readable, F-12),
repository destruction (git branch -D / remote rewrite, F-7)
```

### AP-3 — Rogue worker → prompt/source disclosure & scheduler capture

```
Attacker machine on the network
  ▼ POST /computers/register {id:<victim>|new, hardware:{gpus:8×H100}}   (F-3)
  ▼ Registers with local:true → passes localOnly filter                   (F-15)
  ▼ Scheduler routes high-priority / localOnly tasks to attacker
  ▼ Receives full prompts + repository context; returns forged output      (→ AP-1 step 2)
Impact: source/prompt exfiltration, compute theft, DoS of legitimate workers.
```

### AP-4 — `ask` tier neutralised (F-9)

```
Operator/CI sets WAZIR_AUTO_APPROVE=1 to stop headless runs hanging (because the
queue never times out and the TTY approver is unreachable)
  ▼ every 'ask' (npm/node/python/git commit/redirects-to-unknown) becomes 'allow'
  ▼ Model now has interpreters and package managers with no human in the loop
Impact: the middle tier collapses; combined with F-5/F-13 → exfiltration at will.
```

---

## 13. Security control verification matrix

| Control Domain | Implementation Target | Present? | Enforced? | Tested in CI/Suite? | Bypass or Gap Identified? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| API Authentication | `apps/api/src/server.ts` | **No** | No | Yes — absence pinned (`trackedSecurityDebt.test.ts:36,60`) | F-1, F-2, F-3, F-17, F-18 |
| Role-Based Access Control | `apps/api/src/server.ts` | **No** | No | Absence pinned | All routes equal; no operator/worker distinction |
| Shell Command Policy | `packages/core/src/services/policyEngine.ts` | Yes | Yes (`run.ts:261`) | Yes (`policyEngineShell.test.ts`, `policyBypassSweep.test.ts`, `packages/tools/tests/security.test.ts`) | **Yes** — F-4, F-5, F-6, F-8, F-13 (shell); F-7 (git); F-10 (check); tests cover operators/wrappers but not newline, flags, or git verbs |
| 3-Tier Approval Flow | `packages/core/src/services/approvalQueue.ts` | Partial | Only inside `FleetTui` | Queue enqueue/resolve unit-level only | **Yes** — F-9: no timeout, dead TTY approver, `WAZIR_AUTO_APPROVE` global override |
| Project Root Containment | `packages/tools/src/paths.ts` | Yes | Yes for `read`/`write`/`edit` | Yes (`security.test.ts`) | Holds for tools; not applied to shell args (F-5/F-8); `.git`/`package.json` unprotected (F-10/F-11); TOCTOU (F-20) |
| Git Worktree Isolation | `packages/core/src/services/worktreeManager.ts` | Yes | Yes | Partially (`jobRecovery.test.ts`) | Shared `.git` hooks/config (F-11); unvalidated ids (F-14) |
| Container / Sandbox Isolation | Host process execution | **No** | — | Absence pinned (`trackedSecurityDebt.test.ts:102`) | F-27 root cause |
| Worker Identity Attestation | `packages/workers/src/worker.ts` | **No** | — | No | F-3, F-15 |
| Secret Redaction Filter | Logging / `BlockStore` / CLI | **No** | — | No | F-12, F-13; `--json` dumps raw |
| Replay Policy Re-validation | `apps/cli/src/run.ts` / `commands.ts:351` | N/A (replay only renders) | Trivially | Yes (`policyBypassSweep.test.ts:194`) | None — but the test exercises a stronger path than the CLI uses |
| Store Lock & Concurrency | `packages/shared/src/store.ts` | Yes | Yes | Partially | F-21 (stale-lock race); F-12 (file mode) |
| Reference Path Sanitization | `apps/cli/src/references.ts` | **No** | — | No | F-22 |
| Build/Runtime Parity | `packages/*/dist` | — | — | No | F-16 |

---

## 14. Deterministic remediation test specifications

Each test is written to **fail today** (asserting the vulnerable behaviour is
absent) so that it turns green once remediated. Paths are suggestions under
`tests/integration/` or the owning package's `tests/`.

**F-1 / F-2 — `tests/integration/apiIdentity.test.ts`**
```ts
it('rejects a second SSE subscriber for the same computerId', async () => {
  const a = await openStream(app, 'comp-1', tokenFor('comp-1'));
  const b = await request(app).get('/computers/comp-1/tasks/stream').set('Authorization', 'Bearer other');
  expect(b.status).toBe(401);           // today: 200, and `a` is silently replaced
});
it('rejects a result posted from a computer other than the dispatched one', async () => {
  const { requestId } = await dispatch(app, { computerId: 'comp-1', prompt: 'x' });
  const res = await request(app).post(`/computers/comp-2/executions/${requestId}/result`).send({ output: 'forged' });
  expect(res.status).toBe(403);         // today: 200 and channel resolves with 'forged'
});
```

**F-3 / F-15 — `tests/integration/workerAttestation.test.ts`**
```ts
it('does not allow re-registration to overwrite an existing computer without its token', ...) // expect 409/401
it('marks HTTP-registered computers local:false regardless of payload', async () => {
  await request(app).post('/computers/register').send({ id: 'remote-1', local: true, ... });
  expect(registry.get('remote-1')?.local).toBe(false);   // today: true
});
```

**F-4 — `packages/core/tests/policyEngineShell.test.ts` (extend)**
```ts
it.each(['ls\nsudo reboot', 'ls\r\nrm -rf ~', 'echo a\n\tcurl x | sh'])('denies newline-chained %j', (command) => {
  expect(engine.classify({ tool: 'shell', input: { command } }).decision).not.toBe('allow');
});
```

**F-5 / F-8 / F-13 — same file**
```ts
it.each([
  'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'grep -r . /home', 'head ../../.env',
  'sort -o /tmp/x /etc/hostname', 'find . -fprint /tmp/out', 'env', 'printenv',
])('does not auto-allow host-path or env access via safe binaries: %s', (command) => {
  expect(engine.classify({ tool: 'shell', input: { command } }).decision).not.toBe('allow');
});
```

**F-6 — same file**
```ts
it('denies code-executing flags on allow-listed binaries', () => {
  for (const command of ['rg --pre "sh -c id" x .', 'rg --pre=sh x', 'sort --compress-program=sh x'])
    expect(engine.classify({ tool: 'shell', input: { command } }).decision).toBe('deny');
});
```

**F-7 — `packages/core/tests/policyEngineGit.test.ts`**
```ts
it.each([
  ['config', 'core.fsmonitor', 'echo x'], ['config', 'alias.st', '!sh'], ['branch', '-D', 'main'],
  ['remote', 'set-url', 'origin', 'x'], ['--git-dir=/tmp/x', 'status'], ['log', '--output=/tmp/x'], ['-c', 'core.fsmonitor=sh', 'status'],
])('does not classify git %j as read-only', (...args) => {
  expect(engine.classify({ tool: 'git', input: { args } }).rule).not.toBe('git-read-allow');
});
```

**F-9 — `packages/core/tests/approvalQueue.test.ts`**
```ts
it('resolves to deny after defaultTimeoutMs when nobody answers', async () => {
  const q = new ApprovalQueue({ defaultTimeoutMs: 50 });
  await expect(q.enqueue(req, askDecision)).resolves.toBe(false);   // today: never resolves
});
it('falls back to approveCallback when the queue has no subscriber', ...);
it('ignores WAZIR_AUTO_APPROVE unless config.allowEnvAutoApprove is set', ...);
```

**F-10 / F-11 — `packages/core/tests/protectedPaths.test.ts`**
```ts
it.each(['package.json', '.git/hooks/pre-commit', '.git/config', '.wazir/config.json', '.npmrc'])
  ('requires approval to write %s', (path) => {
    expect(engine.classify({ tool: 'write', input: { path, content: 'x' } }).decision).toBe('ask');  // today: allow
  });
it('check tool re-asks when package.json scripts changed since session start', ...);
it('orchestrator git commands run with hooks disabled', async () => {
  // plant .git/hooks/post-checkout that writes a marker; run WorktreeManager.create(); expect marker absent
});
```

**F-12 — `packages/shared/tests/store.test.ts`**
```ts
it('creates the store file with mode 0600', async () => {
  await store.persist(); expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
});
```

**F-14 — `packages/core/tests/worktreeManager.test.ts`**
```ts
it.each(['../../escape', 'x/../../y', '--force', 'a;b'])('rejects unsafe id %j', async (id) => {
  await expect(manager.create({ jobId: 'job', taskId: id })).rejects.toThrow(/invalid/);
});
```

**F-16 — `scripts/check-dist-fresh.test.ts` (CI)**
```ts
it('dist is not older than src for every workspace', ...); // compare newest mtime, or `git diff --exit-code` after build
```

---

## 15. Final assessment classification

**Verdict: SECURITY REVIEW PASSED WITH FINDINGS** — with two qualifications that
each move the verdict to **BLOCKED** for a specific deployment model:

1. **Distributed mode (`apps/api` reachable beyond loopback, as the shipped
   Docker/Compose configuration does) is BLOCKED.** F-1 + F-2 (+ F-17 as a
   fallback) let an unauthenticated network peer inject a "model reply" into
   the operator's CLI, and F-4 turns that into host code execution with no
   human approval (AP-1). This is remote exploitation under an intended
   deployment model.
2. **Any deployment where the model is not fully trusted is BLOCKED.** The
   `allow` tier of the PolicyEngine is bypassable in at least six independent
   ways (F-4, F-6, F-7, F-8, F-10, F-11) and permits unrestricted host reads
   (F-5) and env dumps (F-13). Since the README's threat model explicitly
   covers "a compromised model," the perimeter does not currently deliver
   the stated guarantee (AP-2).

For a **single operator, local-only bind (`127.0.0.1`), running a model they
trust**, Wazir is usable today: filesystem tools are correctly contained,
SQL is parameterised, the worker never executes tools, MCP is inert, and the
denial tier catches the obvious destructive commands.

**Minimum hardening before any multi-machine or untrusted-model use, in
priority order:**
1. Reject `\n`/`\r` in shell commands (F-4) — one-line fix, closes the most
   direct RCE.
2. Per-binary flag deny-list and git verb allow-list (F-6, F-7, F-8).
3. Protected-path list (`.git/`, `.wazir/`, `package.json`, lockfiles) →
   `ask`; orchestrator git with `core.hooksPath` disabled (F-10, F-11).
4. Fix the `ask` tier: queue timeout, live TTY fallback, gate
   `WAZIR_AUTO_APPROVE` (F-9).
5. Per-computer bearer tokens on every `/computers/*` and result route;
   cryptographic `requestId`s; exact-match execution lookup (F-1, F-2, F-3,
   F-17, F-18).
6. Minimal child environment + `0600` store + redaction pass (F-12, F-13).
7. Rebuild `dist` in CI and fail on drift (F-16).
8. Longer term: sandboxed execution (F-27) removes the whole class of
   "safe-binary abuse" findings rather than chasing flags.

Existing test coverage to extend: `trackedSecurityDebt.test.ts` (add
F-1/F-2/F-9/F-15 as tracked debt until fixed), `policyEngineShell.test.ts`
(F-4..F-8, F-13), `security.test.ts` (F-10/F-11 protected paths).


---
---

# Part 4 — Mitigation implementation results

Applied to the working tree on 2026-09-18 following `sec_review_mitigation.md`
(model-generated plan) cross-checked against the gap register in Section 11
(the plan's F-numbers drift from Section 11 in places — Section 11 numbering
is authoritative below). Every change was implemented against the TypeScript
source, then `npm run build`, `npm run typecheck`, `npm run check-dist` and
the full vitest suite were run.

## 16. Verification summary

| Check | Result |
| :-- | :-- |
| `npm run build` (all workspaces) | exit 0 |
| `npm run typecheck` (`tsc --build --force`) | 0 errors |
| `npm run check-dist -- --quiet` (new, F-16) | exit 0 — no workspace has `dist/` older than `src/` |
| `npx vitest run` | **47 files, 461 passed, 11 skipped, 0 failed** (baseline before this pass: 43 files, 337 passed, 1 failed — the failure was the environment-dependent live LM Studio matrix, which passed on the final run) |
| Empirical probe of all Section 4.2/12 bypasses via `vite-node` against `policyEngine.ts` | 58/58 classify as intended (no `allow`) |

New test files (all deterministic, no live services): `apps/api/tests/apiAuth.test.ts` (14),
`packages/core/tests/policyEngineHardening.test.ts` (83), `packages/shared/tests/sanitize.test.ts` (6),
`apps/cli/tests/references.test.ts` (1); extended: `approvalQueue.test.ts` (+4), `store.test.ts` (+3),
`worktreeManager.test.ts` (+9), `packages/tools/tests/security.test.ts` (+3). Tests that pinned the
insecure behaviour were flipped: `trackedSecurityDebt.test.ts` (F-3 now RESOLVED; the residual
"tokens optional on loopback dev instance" remains tracked), `policyEngineShell.test.ts` (`env` no
longer auto-allowed), `taskDispatch.test.ts` / `tests/integration/worker.test.ts` (workers must
present the token minted at registration).

## 17. Per-finding outcome

Status legend: **FIXED** (control implemented + test pins it), **HARDENED** (defence-in-depth
added; root cause is architectural and tracked), **ACCEPTED** (no code change; rationale given).

| ID | Sev. | Status | What changed | Where | Pinned by |
| :-- | :-- | :-- | :-- | :-- | :-- |
| F-1 | CRITICAL | **FIXED** | Registration mints a 256-bit per-computer bearer token (`ApiAuth`); `GET /computers/:id/tasks/stream`, heartbeat, events and result all require it (401 otherwise, 404 for unknown ids). A second *authenticated* stream replaces the first (legitimate reconnect); an unauthenticated peer can never subscribe. Token rotation on re-registration ends any stale stream. | `apps/api/src/auth.ts` (new), `apps/api/src/server.ts` | `apiAuth.test.ts` "F-1 …" ×2 |
| F-2 | CRITICAL | **FIXED** | `/computers/:id/executions/:requestId/{events,result}` require the computer token **and** `dispatcher.ownerOf(requestId) === :id` (403 otherwise). Outcome body is schema-checked (`ok` boolean, `output` string) and sanitized before it can become a "model reply"; malformed bodies → 400. | `server.ts` (`requireChannelOwner`, `parseOutcome`) | `apiAuth.test.ts` "F-2 …" ×2 |
| F-3 | HIGH | **FIXED** | First-writer-wins on `id`: replacing an existing registration needs that computer's token or the cluster `WAZIR_REGISTRATION_TOKEN`; new ids need the registration token when configured; ids are format-validated; the in-process `local` computer holds a private token. Worker (`packages/workers/src/worker.ts`) stores the issued token and sends `Authorization: Bearer` on every call; auth failures are fatal (no retry loop). | `server.ts`, `auth.ts`, `worker.ts`, `apps/worker/src/index.ts` | `apiAuth.test.ts` "F-3 …" ×3; `trackedSecurityDebt.test.ts` "RESOLVED (F-3)" |
| F-4 | HIGH | **FIXED** | Any `\r`/`\n` in a shell command → `deny` (`shell-dangerous-deny`) before parsing; git argument arrays likewise. | `policyEngine.ts` `classifyShell`, `classifyGit` | `policyEngineHardening.test.ts` "F-4" ×5 |
| F-5 | HIGH | **FIXED** | Every path-shaped argument of a path-reading safe command (`cat`, `head`, `grep`, `rg`, `find`, `ls`, `sort`, …) is resolved against the project root; absolute, `~` or `..`-escaping paths → `deny` (`filesystem-outside-deny`). `--files0-from=`, `grep -f FILE`, attached `-f/etc/x` forms are covered; grep/rg pattern positionals and non-path flag values (`-e`, `-A 3`, `-d/`) are skipped. Shell expansions (`$HOME/…`, `$(pwd)/…`) are kept as markers (parse with env callback) and classified `ask`, never `allow`. | `policyEngine.ts` `classifySafeCommandArgs`, `classifyReadPath`, `NON_PATH_VALUE_FLAGS` | "F-5" ×19 incl. 19 allow-preserving cases |
| F-6 | HIGH | **FIXED** | Per-binary exec-flag deny list: `rg --pre/--hostname-bin`, `sort --compress-program`, `find -exec*` (classified by the inner command, as before). | `EXEC_FLAGS` | "F-6" ×6 |
| F-7 | HIGH | **FIXED** | `git`: global options before the verb (`-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, `--config-env`, `--bare`) → `deny`; read verbs reject `--output`, `--ext-diff`, `--textconv`, `--exec`; `branch`/`remote`/`config` are read-only only in their listing/get forms (`branch -a`, `remote -v`, `config --get/--list`), every write shape → `ask`; `config`, `branch`, `remote` removed from the unconditional allow list. | `classifyGit`, `classifyGitConditionalVerb` | "F-7" ×11 ask + ×9 deny + 18 allow-preserving |
| F-8 | HIGH | **FIXED** | Output-flag targets (`sort -o/-T`, `find -fprint*/-fls`, `tree -o`) get the same containment as `>` redirects; outside → `deny`, `$`/`~` → `ask`, protected path → `ask`. | `OUTPUT_FLAGS`, `classifyWriteTarget` | "F-8" ×8 |
| F-9 | HIGH/MED | **FIXED** | `ApprovalQueue`: `defaultTimeoutMs` now enforced (unanswered → deny), `autoDenyNonInteractive` honoured, `WAZIR_AUTO_APPROVE=1` ignored (with a one-time warning) unless the host passes `allowEnvAutoApprove: true`. `PolicyEngine.resolveAsk` falls back to the interactive `approveCallback` when the queue has no subscriber, so headless `wa run` no longer hangs. CLI engine constructs the queue with a 5-minute timeout. | `approvalQueue.ts`, `policyEngine.ts`, `types/policy.ts`, `apps/cli/src/engine.ts` | `approvalQueue.test.ts` "F-9" ×4 |
| F-10 | HIGH | **FIXED** | Protected-path list: `package.json`, lockfiles, `.npmrc`/`.yarnrc*`, `.pnpmfile.cjs`, `.envrc` (any depth) and `.git/`, `.wazir/`, `.husky/`, `.githooks/`, `node_modules/`, `.github/` (top level). `write`/`edit`, shell redirects and output flags into them → `ask` (`filesystem-protected-ask`, new rule). Reads unaffected. | `protectedPathReason` (exported), `doClassify`, `classifyRedirect`, `classifyWriteTarget` | "F-10 / F-11" ×13 + 3 |
| F-11 | HIGH | **FIXED** | Same protected-path control for `.git/`; additionally every orchestrator git call runs with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, so a planted hook is never executed by Wazir's own `worktree add`/`commit`/`merge`. | `worktreeManager.ts` `GIT_NO_HOOKS` | `worktreeManager.test.ts` "F-11: orchestrator git runs with hooks disabled" (plants a real `post-checkout`) |
| F-12 | MEDIUM | **FIXED** | Store tmp file written with `mode 0o600` and `chmod 0600` after rename; `~/.wazir` (or `.rook`) created `0700` and tightened if wider; lock file `0600`. | `packages/shared/src/store.ts` | `store.test.ts` "F-12" |
| F-13 | MEDIUM | **FIXED** | (a) `env`/`printenv` removed from the safe list (→ `ask`); (b) tool subprocesses get an allow-listed environment (`PATH`, `HOME`, `LANG`, `TERM`, toolchain homes, …) plus `WAZIR_CHILD_ENV=A,B` passthrough — API keys/DB URLs never reach a child; (c) `redactSecrets()`/`sanitizeUntrustedOutput()` applied in `ExecutionEngine.recordToolCall/recordCheck/setResult` and to worker-reported outcomes in the API. | `policyEngine.ts`, `packages/tools/src/process.ts` `childEnvironment`, `packages/shared/src/sanitize.ts` (new), `executionEngine.ts`, `server.ts` | "F-13" ×6 (policy), `security.test.ts` "F-13" (real subprocess), `sanitize.test.ts` ×4 |
| F-14 | MEDIUM | **FIXED** | `jobId`/`taskId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; resolved worktree path must be a child of the worktree root; `cleanupDirectory` refuses anything not under a `.wazir/worktrees` tree or the configured override. | `worktreeManager.ts` | `worktreeManager.test.ts` "F-14" ×8 |
| F-15 | MEDIUM | **FIXED** | API forces `local: false` on every HTTP registration; worker no longer claims `local: true`. | `server.ts`, `worker.ts` | `apiAuth.test.ts` "F-15" |
| F-16 | MEDIUM | **FIXED** | `scripts/check-dist-fresh.mjs` + `npm run check-dist` fail when any workspace's `dist/` is older than its `src/`; wired into `.github/workflows/ci.yml` after typecheck. (Ran locally: correctly flagged the three stale apps before the rebuild, passes after.) | `scripts/`, `package.json`, `ci.yml` | CI step; manual run recorded above |
| F-17 | MEDIUM | **FIXED** | `generateId()` → `crypto.randomBytes(16)` hex (128-bit, no timestamp prefix). `requestId`s in dispatch are format-validated. | `packages/shared/src/utils.ts`, `server.ts` | `sanitize.test.ts` "F-17"; `apiAuth.test.ts` "F-17" |
| F-18 | MEDIUM | **FIXED** | Exact-match lookup only. | `server.ts` | `apiAuth.test.ts` "F-18" |
| F-19 | MEDIUM | **FIXED** | `express.json({ limit: '1mb' })` (413); ≤100 queued requests per offline computer and duplicate `requestId`s → 429; channel table capped at 5 000 (evicts resolved channels first); execution history capped at 5 000; events per channel capped at 10 000; outputs truncated at 1 MB; `?wait=` clamped to 10 min. | `server.ts` | `apiAuth.test.ts` "F-19" ×3 |
| F-20 | LOW | **HARDENED** | `read`/`write`/`edit` now open the *canonical* path with `O_NOFOLLOW`, then verify the descriptor's `dev/ino` against a fresh `stat` + containment re-check before I/O (`readProjectFile`/`writeProjectFile`). A final-component symlink swapped in after the check is rejected; intermediate-directory races remain theoretically possible (fd-relative `openat` would close them fully). | `packages/tools/src/paths.ts`, `filesystem.ts` | `security.test.ts` "F-20" ×2 |
| F-21 | LOW | **FIXED** | Stale-lock steal is now an atomic `rename` (only one contender can win) followed by unlink, instead of a bare `unlink` both could perform. | `store.ts` `withFileLock` | `store.test.ts` "F-21" |
| F-22 | LOW | **FIXED** | `@file:` references pass `assertInsideProject` (lexical + realpath); anything outside — including an in-project symlink pointing out — resolves as `exists: false`. | `apps/cli/src/references.ts` | `references.test.ts` |
| F-23 | LOW | **FIXED** | `stripTerminalEscapes()` (CSI/OSC/DCS/C1 + stray C0) applied to model/tool text interpolated into `wa run` log lines and, via `sanitizeUntrustedOutput`, to everything persisted. Wazir's own colour codes are added *after* stripping so they are unaffected. | `sanitize.ts`, `apps/cli/src/run.ts` | `sanitize.test.ts` "F-23" |
| F-24 | LOW | **FIXED** | `reviveDatesDeep` skips `__proto__`, `constructor`, `prototype`. | `store.ts` | `store.test.ts` "F-14" (register numbering) |
| F-25 | INFO | **FIXED** | MCP allow-list entries may be `server` (all tools), `server:*`, or `server:tool`; a tool-scoped entry no longer allows the server's other tools. | `policyEngine.ts` | "F-25" ×2 |
| F-26 | INFO | **FIXED** | `docker-compose.yml`: every port published on `127.0.0.1` only; `WAZIR_API_TOKEN` and `WAZIR_REGISTRATION_TOKEN` are **required** (`${VAR:?}`) for `api`, `worker`, `web`, `cli`. `apps/api/src/main.ts` refuses a non-loopback bind without an operator token unless `WAZIR_ALLOW_UNAUTHENTICATED=1`. Web dashboard proxy injects the operator token server-side. README + `.env.example` document the variables. | `docker-compose.yml`, `Dockerfile`, `main.ts`, `apps/web/server.js`, `README.md`, `.env.example` | Config review; `main.ts` guard is startup logic (not unit-tested) |
| F-27 | INFO | **ACCEPTED** (tracked debt) | No sandbox added — out of scope for this pass (L effort, needs container infra). The flag/path controls above shrink the blast radius of "safe-binary abuse", but the root cause stands and `trackedSecurityDebt.test.ts` keeps pinning it. | — | `trackedSecurityDebt.test.ts` (unchanged) |
| F-28 | INFO | **ACCEPTED** | Observability only; no change. | — | unchanged |

## 18. Deviations from `sec_review_mitigation.md`

The plan was model-generated and marked unreviewed; the following items were implemented differently, deliberately:

- **Duplicate SSE subscriber (plan F-1: 409).** A second stream *with a valid token* replaces the first instead of being refused: the only party that can present the token is the legitimate worker, and refusing its reconnect after a half-open socket would starve it until the server noticed the dead connection. Unauthenticated/foreign-token subscribers get 401, which is the property the finding needed.
- **HMAC/nonce on results (plan F-2).** Not needed: the per-computer bearer token plus the `channel.computerId === :id` check gives the same binding with one credential. A nonce would only add value over a transport where the token could be replayed, which is the TLS-proxy question documented in the README.
- **Hardware-mismatch 409 on re-registration (plan F-3).** Replaced by token ownership: hardware is self-reported either way, so equality proves nothing; possession of the computer (or registration) token does.
- **Redirect detection by `arg.includes('-o')` (plan F-8).** Far too broad (would deny `ls -o`, `sort -on`); implemented as a per-binary output-flag table instead.
- **`sanitizeOutput` regexes in the plan (F-13)** redacted every e-mail address and every `x=y`; the shipped patterns target credential-shaped keys, bearer headers, URL credentials, PEM blocks and known token formats, and are pinned to leave ordinary code/output untouched.
- **`JsonFileStore.persist` rewrite with `open('wx')` per persist (plan F-11/F-21).** The existing lock already does this; only the stale-steal was racy, so only that was changed.
- **Docker test spawning a container (plan F-26).** Not added — CI has no Docker daemon guarantee; the bind/token requirement is enforced in compose config and in `main.ts` instead.
- **`WAZIR_AUTO_APPROVE` gating (plan F-9)** is implemented at the `ApprovalQueue` level (`allowEnvAutoApprove`) rather than in `engine.ts` per-decision, so every consumer of the queue gets the same guarantee.

## 19. Residual risk and follow-ups

1. **Tokens are optional on a loopback development instance.** A server started with neither `WAZIR_API_TOKEN` nor `WAZIR_REGISTRATION_TOKEN` still accepts anonymous new registrations and dispatches (existing records are protected regardless). This is intentional for `wa` single-machine use and is pinned as tracked debt in `trackedSecurityDebt.test.ts`. Making the tokens mandatory is a one-line change in `ApiAuth` once every launcher sets them.
2. **No RBAC.** One operator token grants all `/api/v1` routes.
3. **No TLS in the API.** Tokens travel in clear text unless a reverse proxy terminates TLS (documented).
4. **Per-computer tokens live in API memory.** An API restart forgets them; workers re-register with the registration token (or `WAZIR_WORKER_TOKEN`). Persisting hashed tokens would let workers survive an API restart without the cluster secret.
5. **F-27 sandboxing** remains the structural fix; the shell allow-list is now materially harder to abuse but is still a deny-list-of-flags approach for `find`/`sort`/`rg`.
6. **Path-containment false positives.** Absolute paths outside the project are now denied even for harmless reads (`ls /`, `df /`, `ls /tmp`), and once `-e PATTERN` is given to grep/rg every positional is treated as a file. Operators can whitelist specific prefixes with `allowCommands`.
7. **Child environment allow-list** may break tools that need bespoke variables (e.g. `WAZIR_TEST_DATABASE_URL` for `npm test` run by the `test` tool); forward them with `WAZIR_CHILD_ENV`.

## 20. Revised assessment classification

**Verdict: SECURITY REVIEW PASSED.**

- The two BLOCKED qualifications from Section 15 are lifted: (1) distributed mode now authenticates every worker-protocol route per computer and every control route with an operator token, the shipped Compose configuration requires both and binds loopback only, so AP-1 (remote → operator RCE) no longer has an unauthenticated entry point; (2) every reproduced `allow`-tier bypass (F-4, F-5, F-6, F-7, F-8, F-10, F-11, F-13) now classifies `deny` or `ask`, so the "compromised model" threat model in the README is delivered by the policy perimeter for the tool surface Wazir ships (AP-2 requires human approval at every step).
- Remaining items are the tracked architectural debts (F-27 sandbox, optional-tokens-on-loopback, no RBAC/TLS) listed in Section 19; none is exploitable under the documented deployment (loopback bind, or TLS proxy + tokens).
