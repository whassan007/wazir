#!/usr/bin/env bash
# Wazir Self-Improvement Builder — runs a multi-phase native Wazir coding job
# in a user-level systemd service, independently of the invoking SSH session.
# This BUILDS the future continuous supervisor; it does not claim one exists.
set -Eeuo pipefail
umask 077

APP="wazir-self-improvement-builder"
SERVICE="${APP}.service"
APP_DIR="${HOME}/.local/share/${APP}"
STATE_DIR="${HOME}/.local/state/${APP}"
SELF="${APP_DIR}/builder.sh"
PROMPT_DIR="${APP_DIR}/prompts"
CONFIG="${APP_DIR}/config.sh"
LOG="${STATE_DIR}/build.log"
PHASE_FILE="${STATE_DIR}/phase"
RESULT_FILE="${STATE_DIR}/result"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/${SERVICE}"
DEFAULT_REPO="${HOME}/Code/Wazir"

usage() {
  cat <<EOF
Wazir self-improvement implementation builder (not the future supervisor)

Usage:
  bash $0 start [--repo DIR] [--agent NAME] [--model ID] [--max-turns N]
  bash $0 status
  bash $0 logs [--follow]
  bash $0 stop
  bash $0 resume
  bash $0 path
  bash $0 help

Starts a multi-phase Wazir coding task using a SYSTEMD USER SERVICE.
The implementation is isolated in a separate Git worktree.
The service is persistent across SSH logout only when systemd user lingering is enabled.

For an SSH-independent user service (one-time, explicitly authorized):
  sudo loginctl enable-linger "\$USER"

Environment override: WAZIR_REPO=/path/to/repo
EOF
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"; }

# SSH, Conda and systemd user sessions may not inherit the Node version-manager PATH.
# Recover an existing Node installation; do not install software or modify dotfiles.
bootstrap_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local existing_major
    existing_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    if [[ "$existing_major" =~ ^[0-9]+$ ]] && (( existing_major >= 22 )); then return 0; fi
  fi
  if [[ -r "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    local was_nounset=0
    [[ "$-" == *u* ]] && was_nounset=1
    set +u
    # shellcheck disable=SC1090
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true
    if type nvm >/dev/null 2>&1; then
      nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent default >/dev/null 2>&1 || true
    fi
    ((was_nounset)) && set -u
  fi
  local candidate
  for candidate in "$HOME/.volta/bin" "$HOME/.local/share/mise/shims" "$HOME/.asdf/shims" \
      "$HOME/.local/share/fnm/aliases/default/bin"; do
    if [[ -x "$candidate/node" && -x "$candidate/npm" ]]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    local -a versions=()
    shopt -s nullglob
    versions=("$HOME"/.nvm/versions/node/v22*/bin "$HOME"/.nvm/versions/node/v24*/bin)
    shopt -u nullglob
    for candidate in "${versions[@]}"; do
      if [[ -x "$candidate/node" && -x "$candidate/npm" ]]; then
        export PATH="$candidate:$PATH"
        break
      fi
    done
  fi
  if ! command -v node >/dev/null 2>&1; then
    cat >&2 <<'EOF'
Node.js was not found in the current shell's PATH.
Inspect: command -v node; ls ~/.nvm/versions/node/*/bin/node 2>/dev/null
If using nvm: source ~/.nvm/nvm.sh && nvm use 22
Then retry the script. Node 22+ is required by Wazir.
EOF
    return 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo 'npm not found alongside Node.js; correct the Node toolchain PATH.' >&2
    return 1
  fi
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" || return 1
  if [[ ! "$major" =~ ^[0-9]+$ ]] || (( major < 22 )); then
    echo "Node.js 22+ required. Found: $(node --version) at $(command -v node)" >&2
    return 1
  fi
  return 0
}

load_config() { [[ -f "$CONFIG" ]] || fail "Not initialized. Run: bash $0 start"; source "$CONFIG"; }
logline() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
worktree_fingerprint() {
  (git rev-parse HEAD; git diff HEAD --binary; git ls-files --others --exclude-standard -z | LC_ALL=C sort -z | xargs -0 -r sha256sum) | sha256sum | cut -d' ' -f1
}
atomic_write() {
  local target="$1"; shift
  local tmp; tmp="$(mktemp "${target}.XXXXXX")"
  printf '%s\n' "$*" > "$tmp"
  sync -f "$tmp"
  mv -f "$tmp" "$target"
  sync -f "$(dirname "$target")"
}
classify_failure() {
  local code="$1" file="$2"
  if grep -Eq 'NO_PROGRESS|MODEL_PROTOCOL_BUDGET_EXHAUSTED|INVALID_JSON_ACTION|ACTION_VALIDATION_FAILED' "$file"; then echo PROTOCOL_OR_NO_PROGRESS
  elif [[ "$code" == 124 || "$code" == 137 ]]; then echo TIMEOUT
  elif grep -Eqi 'ECONNREFUSED|ECONNRESET|ETIMEDOUT|temporarily unavailable|HTTP 503' "$file"; then echo RUNTIME_UNAVAILABLE
  elif grep -Eqi 'quota|rate.limit|HTTP 429' "$file"; then echo QUOTA
  else echo EXECUTION_FAILED; fi
}
set_phase() { atomic_write "$PHASE_FILE" "$*"; logline "PHASE: $*"; }

make_prompts() {
  mkdir -p "$PROMPT_DIR"
  cat > "$PROMPT_DIR/common.txt" <<'PROMPT'
AUTONOMOUS EXECUTION MANDATE — APPLY TO THIS PHASE VERBATIM:
Operate in autonomous execution mode.
Proceed through investigation, implementation, testing, debugging, and verification without requesting routine confirmations.
Make reasonable technical decisions independently. Continue fixing failures and rerunning tests until the acceptance criteria are met or a genuine blocker is identified.
Do not pause between implementation phases or request approval for ordinary file edits, dependency installation, builds, tests, or reversible Git operations.
Use existing repository conventions and preserve backward compatibility.
Do not bypass platform security restrictions, expose credentials, execute destructive operations, or publish changes externally without the required authorization.
Provide a final report documenting changes, test results, remaining risks, and blockers.

GENERAL REQUIREMENTS:
You are implementing Wazir's real native Self-Improvement Supervisor in this EXISTING, ISOLATED GIT WORKTREE. Repository: https://github.com/whassan007/wazir. Target: NVIDIA DGX Spark, Ubuntu Linux ARM64, Node.js 22+, headless CLI, real LM Studio/Ollama and authorized external agents. Do not modify the parent source checkout, push, merge, deploy, or publish. Inspect existing code before editing. Reuse MetaOptimizerService, OpportunityDetector, BenchmarkService, RegressionGuard, CanaryDeploymentService, StrategyLearningService, MemoryService, WorktreeManager, VerificationEngine, ResourceRouter, ResourceLedger, and CrashHandler. Avoid duplicate infrastructure. Make real code changes; add executable tests. Missing evidence is NOT PASS. Treat simulated metrics as fixtures only. Do not weaken independent test oracles. Keep source-code integration reviewable, not automatic.

PHASE EXECUTION RULES:
Complete the phase independently using tools. Where a phase depends on previous phases, inspect actual code and verification results. Commit your completed phase changes to the local isolated branch with an appropriate descriptive commit message. If real dependency or infrastructure is unavailable, report BLOCKED honestly; do not invent a PASS. Be economical in tokens and favor targeted changes with robust tests. Preserve existing CLI and TUI behaviors.
PROMPT
  cat > "$PROMPT_DIR/1.txt" <<'PROMPT'
PHASE 1 / 4 — CORRECT IMPROVEMENT INTEGRITY BEFORE AUTONOMY
Inspect apps/cli/src/commands.ts improveRunCommand, improvePromoteCommand, packages/evaluation/src/metaOptimizerService.ts verifyCandidate, hydration, candidate lifecycle, and benchmark/evaluation services.
1. Remove synthetic production benchmark outcomes (hardcoded successful executions, test checks, model IDs, and artificial 28% token saving); use a real Wazir execution-backed BenchmarkRunner tied to measured execution events, persisted revisions and independent test oracles. Synthetic data allowed only inside clearly labeled deterministic tests, never production qualifications.
2. If zero real benchmark executions or a model is unavailable, report BLOCKED / INCONCLUSIVE, not QUALIFIED. Make fake success impossible even if all runs are absent.
3. Require registered, executed, passing oracles for every REQUIRED verification gate. Missing oracles, no candidate worktree, stale revision, or unverified source change must not pass. Keep legitimate configuration-only checks scoped to applicable requirements; no invented success.
4. Fix wa improve promote so it retrieves a real persisted candidate, verifies evidence freshness and authorization, and never constructs a fresh object labeled VERIFIED. Remove unsafe authorization bypass patterns.
5. Ensure the active optimized config, candidate metadata, history and rollback provenance persist and recover correctly across fresh process restarts. Add tests for fabricated results, absent tests, misleading runner, stale SHA, restart and rollback.
6. Run relevant builds and tests. Report what genuinely passes. If a necessary design ambiguity arises, choose conservative fail-closed behavior, and document compatibility implications.
Target actual implementation and regression tests, not design-only output.
PROMPT
  cat > "$PROMPT_DIR/2.txt" <<'PROMPT'
PHASE 2 / 4 — NATIVE PERSISTENT SUPERVISOR, HEADLESS COMMANDS AND SERVICE
Extend existing Wazir services with a SelfImprovementSupervisor (or equivalent) using the existing persistent store, scheduling, execution engine, and revision-fenced state. Design a durable lifecycle: IDLE, OBSERVING, DIAGNOSING, PLANNING, EXPERIMENTING, VERIFYING, QUALIFYING, STAGED, PAUSED, BLOCKED, FAILED. Track run and attempt IDs. Prevent duplicate supervisors and duplicate jobs across processes and restarts. Do not blindly repeat an uncertain external side effect.
Implement existing-compatible CLI operations: wa improve doctor; wa improve run --mode harden|optimize|evolve; wa improve start --continuous --mode harden,optimize [--foreground]; wa improve status [--live|--json]; wa improve pause; wa improve resume; wa improve stop; wa improve logs --follow; wa improve failures; wa improve recommendations; wa improve history. Preserve preexisting wa improve commands and semantics. New commands must execute actual service logic, not just print success.
Implement clean Linux ARM64 headless background supervisor with explicit install/start/stop/status commands or a carefully integrated systemd --user service. Persist state and log files under appropriate WAZIR_HOME/XDG paths, redact credentials, bound queues/logs and support safe shutdown. Never install a service or alter system security settings automatically; require explicit operator commands. Do not require a browser, TUI, Docker, root, or live SSH. Support machine-reboot persistence when user lingering and service enablement are explicitly configured. Protect everyday CLI operation from accidentally spawning a supervisor. Test process restarts, singleton behavior, CLI syntax, logging, and missing runtimes with actual subprocess-level evidence.
PROMPT
  cat > "$PROMPT_DIR/3.txt" <<'PROMPT'
PHASE 3 / 4 — HARDEN, OPTIMIZE, EVOLVE MODES, CRASH INTELLIGENCE AND LEARNING
Implement the three native modes in the actual supervised pipeline.
HARDEN (DEFAULT, prioritized): observe historical and new execution failures, tool/protocol errors, repeated build/test failures, timeouts, state inconsistencies, worker disconnects, and ~/.wazir/logs/crash-*.log (or configured WAZIR_HOME) crash reports. Parse crash records safely, redact, deduplicate by stable signature, cluster repeated incidents, prioritize and reproduce in disposable fixtures, generate bounded source repairs with existing coding agents, verify against reproducible independent oracles and regression tests. Also proactively identify reliability gaps without waiting for a crash. No new features required.
OPTIMIZE: find real inefficiency in task latency, input/output tokens, tool retries, context, routing, prompt cache, GPU memory usage, worker scheduling. Measure baseline vs candidate using comparable *real* workloads, repeat measurements when needed, retain uncertainty and reject correctness or security regressions.
EVOLVE: separate opt-in mode. Gather evidence-backed capability proposals into a persistent backlog, define scoped acceptance criteria, and implement only explicitly authorized features in isolated Git worktrees, independent tests and reviewable candidates. Never auto-merge code to protected branches.
All modes must use real configured local DGX models or authorized coding agents via existing Wazir routing and budget enforcement; honor quotas and policy. Use event-driven observation with periodic low-frequency sweeps, concurrency and token/wall-time/resource limits, backoff and durable work checkpoints. Auto-promote only policy-authorized reversible and qualified CONFIG changes. Record verified and failed strategies in existing learning/memory services. Include actual tests for recurring crash grouping, candidate verification, legitimate repair, bad optimization rejection, resource exhaustion, missing models, interrupted repair, and restart.
PROMPT
  cat > "$PROMPT_DIR/4.txt" <<'PROMPT'
PHASE 4 / 4 — INTEGRATE, HARDEN, QUALIFY ON DGX ARM64, DOCUMENT
Review all modifications made in phases 1–3, complete unfinished wiring, verify correctness of production paths end to end, remove mocks in production improvement paths, repair regressions, strengthen error handling, and test the whole supervisor. Build and typecheck the monorepo, run targeted and existing tests. Never weaken tests or falsify evidence to obtain green output.
Run real, disposable proof: reproduce a harmless bug/crash, observe and deduplicate it, have a real configured local model or authorized agent propose a repair in an isolated worktree, run actual independently defined tests and show verified outcome. Test rejecting a candidate that reduces tokens but breaks correctness. Test no qualified result with absent oracle. Verify background service operation after controlling shell terminates, durable singleton/restart/pause/stop, native Linux ARM64, missing optional Ollama, available LM Studio, read/write state without browser/TUI, and budget enforcement. If an OS/service capability is unavailable, mark that specific test BLOCKED; do not imply it passed.
Add concise operator documentation with precise commands for Ubuntu DGX Spark: `wa improve doctor`, `wa improve run --mode harden`, `wa improve start --continuous --mode harden,optimize`, `wa improve status --live`, `wa improve logs --follow`, `wa improve pause`, `wa improve resume`, `wa improve stop`, plus optional systemd user service guidance. Report real test evidence, limitations and exact local commit SHA. End with a concise final operational report under docs/, not just text output. Keep all changes on the isolated worktree branch; do not merge, deploy, or push.
PROMPT
}

ensure_linger() {
  require loginctl
  local linger
  linger="$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)"
  if [[ "$linger" != "yes" ]]; then
    cat >&2 <<EOF
Your systemd user instance may stop when your SSH session closes.
Enable lingering ONCE (this changes a system login-service setting):

    sudo loginctl enable-linger "$(id -un)"

Then run this start command again. No system setting was changed by this script.
EOF
    exit 2
  fi
}

start_job() {
  bootstrap_node || fail "Node.js/npm unavailable after checking common version-manager locations"
  require git; require systemctl; require node; require npm; require wa
  [[ "$(uname -s)" == "Linux" ]] || fail "This background-service script targets Linux (DGX Spark)."
  [[ "$(uname -m)" == "aarch64" ]] || echo "NOTICE: Architecture is $(uname -m), not DGX Spark aarch64; continuing."
  ensure_linger
  systemctl --user show-environment >/dev/null 2>&1 || fail "No systemd user manager; ensure this is an ordinary SSH login with XDG_RUNTIME_DIR configured."

  local repo="${WAZIR_REPO:-$DEFAULT_REPO}" agent="wazir-coding" model="" turns="120"
  while (($#)); do
    case "$1" in
      --repo) [[ $# -ge 2 ]] || fail "--repo requires a value"; repo="$2"; shift 2;;
      --agent) [[ $# -ge 2 ]] || fail "--agent requires a value"; agent="$2"; shift 2;;
      --model) [[ $# -ge 2 ]] || fail "--model requires a value"; model="$2"; shift 2;;
      --max-turns) [[ $# -ge 2 ]] || fail "--max-turns requires a value"; turns="$2"; shift 2;;
      *) fail "Unknown option: $1";;
    esac
  done
  [[ "$turns" =~ ^[1-9][0-9]*$ ]] || fail "--max-turns must be a positive integer"
  [[ -d "$repo/.git" || -f "$repo/.git" ]] || fail "Not a git checkout: $repo"
  repo="$(git -C "$repo" rev-parse --show-toplevel)"
  git -C "$repo" remote -v | grep -q 'whassan007/wazir' || fail "Expected whassan007/wazir checkout; refusing to work in another repository."
  if systemctl --user is-active --quiet "$SERVICE"; then
    echo "Already running. Use: bash $0 status"; return 0
  fi
  mkdir -p "$APP_DIR" "$STATE_DIR" "$UNIT_DIR"
  local worker_worktree="${repo%/*}/Wazir-self-improvement-candidate"
  local branch="feat/native-continuous-self-improvement"
  # Do not reset or delete an existing worktree/branch; continue safely.
  if [[ ! -d "$worker_worktree" ]]; then
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
      fail "Branch $branch already exists but expected worktree $worker_worktree does not. Inspect with git worktree list."
    fi
    git -C "$repo" worktree add -b "$branch" "$worker_worktree" HEAD
  fi
  [[ "$(git -C "$worker_worktree" rev-parse --show-toplevel)" == "$worker_worktree" ]] || fail "Worktree mismatch: $worker_worktree"
  [[ "$(git -C "$worker_worktree" branch --show-current)" == "$branch" ]] || fail "Wrong branch in worktree"

  install -m 700 "$(readlink -f "$0")" "$SELF"
  make_prompts
  {
    printf 'REPO=%q\n' "$repo"
    printf 'WORKTREE=%q\n' "$worker_worktree"
    printf 'WAZIR_AGENT=%q\n' "$agent"
    printf 'WAZIR_MODEL=%q\n' "$model"
    printf 'MAX_TURNS=%q\n' "$turns"
    printf 'WA_BIN=%q\n' "$(command -v wa)"
    printf 'CAPTURED_PATH=%q\n' "$PATH"
  } > "$CONFIG"
  chmod 600 "$CONFIG"
  local escaped_path; escaped_path="$(printf '%s' "$PATH" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Wazir native self-improvement feature implementation (coding task)
After=default.target

[Service]
Type=simple
WorkingDirectory=$worker_worktree
ExecStart=$SELF run-worker
Environment="PATH=$escaped_path"
Environment=NO_COLOR=1
Restart=no
TimeoutStartSec=0
KillMode=control-group

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  touch "$LOG"; atomic_write "$PHASE_FILE" PENDING
  printf 'STARTING\n' > "$RESULT_FILE"
  systemctl --user start "$SERVICE"
  echo "Started $SERVICE"
  echo "Branch/worktree: $branch | $worker_worktree"
  echo "Progress: bash $SELF status"
  echo "Live logs: bash $SELF logs --follow"
  echo "Stop: bash $SELF stop"
  echo "SSH can be closed; linger=$([[ $(loginctl show-user "$(id -un)" -p Linger --value) == yes ]] && echo yes || echo no)."
}

run_worker() {
  load_config
  export PATH="$CAPTURED_PATH" NO_COLOR=1
  bootstrap_node || fail "Node.js/npm unavailable in the systemd user service"
  mkdir -p "$STATE_DIR"
  exec >>"$LOG" 2>&1
  set -Eeuo pipefail
  require flock; require timeout; require git
  exec 9>"$STATE_DIR/worker.lock"
  flock -n 9 || fail "Another builder worker holds the lock"
  [[ -x "$WA_BIN" ]] || fail "Configured Wazir executable unavailable"
  [[ -d "$WORKTREE/node_modules" ]] || fail "Dependencies unavailable; run npm ci in the worktree"
  [[ "$(git -C "$WORKTREE" branch --show-current)" == "feat/native-continuous-self-improvement" ]] || fail "Unexpected implementation branch"
  if [[ "$WAZIR_AGENT" == wazir-coding && -z "$WAZIR_MODEL" ]]; then
    atomic_write "$RESULT_FILE" "BLOCKED MODEL_SELECTION_REQUIRED"
    fail "Select an explicit model with measured coding capability; auto routing previously failed protocol validation"
  fi
  [[ -s "$STATE_DIR/runtime-compatibility.json" ]] || fail "BLOCKED: runtime compatibility receipt missing"
  node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1])); if(r.model!==process.argv[2] || r.agent!==process.argv[3] || r.result!=="PASS") process.exit(1)' "$STATE_DIR/runtime-compatibility.json" "$WAZIR_MODEL" "$WAZIR_AGENT" || fail "BLOCKED: selected runtime has not passed compatibility"
  local start_time="$(date +%s)" rc=0
  WORKER_HEARTBEAT=""
  cleanup() {
    rc=$?
    if [[ -n "${WORKER_HEARTBEAT:-}" ]]; then kill "$WORKER_HEARTBEAT" 2>/dev/null || true; wait "$WORKER_HEARTBEAT" 2>/dev/null || true; fi
    if ((rc == 0)); then atomic_write "$RESULT_FILE" COMPLETED; logline "FINAL: COMPLETED (all phases)";
    elif [[ "$(cat "$RESULT_FILE" 2>/dev/null)" == BLOCKED* ]]; then logline "FINAL: $(cat "$RESULT_FILE")";
    elif ((rc == 130 || rc == 143)); then atomic_write "$RESULT_FILE" "INTERRUPTED rc=$rc";
    else atomic_write "$RESULT_FILE" "FAILED rc=$rc"; logline "FINAL: FAILED_OR_INTERRUPTED rc=$rc; see logs, worktree and phase markers"; fi
  }
  trap cleanup EXIT
  trap 'logline "INTERRUPTED"; exit 130' INT
  trap 'logline "SIGTERM received"; exit 143' TERM
  atomic_write "$RESULT_FILE" RUNNING
  logline "Starting phased implementation in $WORKTREE"
  logline "Model: ${WAZIR_MODEL:-auto} | Agent: $WAZIR_AGENT | Wazir CLI: $WA_BIN"
  cd "$WORKTREE"
  if [[ -n "$WAZIR_MODEL" ]]; then
    local loaded_models
    loaded_models="$(timeout 30s "$WA_BIN" models loaded)" || fail "Runtime availability check failed"
    grep -Fq -- "$WAZIR_MODEL" <<<"$loaded_models" || fail "Selected model is not loaded"
  fi
  # A heartbeat provides progress visibility even if wa buffers its own output.
  (while sleep 60; do logline "heartbeat: phase=$(cat "$PHASE_FILE" 2>/dev/null || echo UNKNOWN), elapsed=$(($(date +%s)-start_time))s"; done) & WORKER_HEARTBEAT="$!"
  if [[ ! -f "$STATE_DIR/dependencies-installed" ]]; then
    set_phase "PREPARING_DEPENDENCIES"
    CI=1 npm ci --ignore-scripts
    atomic_write "$STATE_DIR/dependencies-installed" "$(sha256sum package-lock.json)"
  fi
  local phase prompt rc_run snapshot_before
  for phase in 1 2 3 4; do
    if [[ -s "$STATE_DIR/done-$phase" ]]; then
      local completed_sha; completed_sha="$(head -1 "$STATE_DIR/done-$phase")"
      if git merge-base --is-ancestor "$completed_sha" HEAD 2>/dev/null && node "$WORKTREE/scripts/self-improvement-phase-receipt.mjs" "$STATE_DIR/review-$phase.json" "$phase" "$completed_sha" "$PROMPT_DIR/$phase.txt"; then
        logline "Skipping verified phase $phase at $completed_sha"; continue
      fi
      fail "Invalid phase checkpoint $phase; inspect before resuming"
    fi
    set_phase "PHASE_$phase/4"
    snapshot_before="$(worktree_fingerprint)"
    prompt="$(cat "$PROMPT_DIR/common.txt"; printf '\n'; cat "$PROMPT_DIR/$phase.txt")"
    # Review may resume verification without replaying a coding task with uncertain side effects.
    local review_sha="$(git rev-parse HEAD)" review_receipt="$STATE_DIR/review-$phase.json"
    local already_reviewed=0
    if [[ -s "$review_receipt" ]]; then
      if node "$WORKTREE/scripts/self-improvement-phase-receipt.mjs" "$review_receipt" "$phase" "$review_sha" "$PROMPT_DIR/$phase.txt"; then already_reviewed=1;
      else fail "Stale or invalid review receipt for phase $phase"; fi
    fi
    local args=(task run "$prompt" --type coding --agent "$WAZIR_AGENT" --max-turns "$MAX_TURNS")
    if [[ -n "$WAZIR_MODEL" ]]; then args+=(--model "$WAZIR_MODEL"); fi
    local attempt classification attempt_log
    if ((already_reviewed == 0)); then
    for attempt in 1 2 3; do
      attempt_log="$STATE_DIR/phase-${phase}-attempt-${attempt}-$(date +%s).log"
      atomic_write "$STATE_DIR/checkpoint" "phase=$phase attempt=$attempt state=EXECUTING head=$(git rev-parse HEAD) before=$snapshot_before log=$attempt_log"
      set +e
      timeout --kill-after=15s "${BUILDER_TIMEOUT_SECONDS:-1800}s" "$WA_BIN" "${args[@]}" >"$attempt_log" 2>&1
      rc_run=$?
      set -e
      cat "$attempt_log"
      if ((rc_run == 0)); then break; fi
      classification="$(classify_failure "$rc_run" "$attempt_log")"
      logline "FAILURE phase=$phase attempt=$attempt class=$classification exit=$rc_run"
      atomic_write "$STATE_DIR/checkpoint" "phase=$phase attempt=$attempt state=FAILED class=$classification exit=$rc_run log=$attempt_log"
      # Never replay a possibly mutating execution or repeat a protocol failure.
      if [[ "$classification" != RUNTIME_UNAVAILABLE || "$attempt" == 3 || "$(worktree_fingerprint)" != "$snapshot_before" ]]; then exit "$rc_run"; fi
      sleep "$((attempt * 5))"
    done
    fi
    logline "Phase $phase command exited 0; checking for a real change and phase-level sanity tests."
    if ((already_reviewed == 0)) && [[ "$(worktree_fingerprint)" == "$snapshot_before" ]]; then
      logline "Phase $phase produced no source changes or commits in the assigned worktree. Treating as INCONCLUSIVE, not completed."
      exit 1
    fi
    atomic_write "$STATE_DIR/checkpoint" "phase=$phase state=VERIFYING"
    npm run build
    npx vitest run packages/evaluation/tests apps/cli/tests/improve.test.ts
    if [[ -n "$(git status --porcelain)" ]] || ! node "$WORKTREE/scripts/self-improvement-phase-receipt.mjs" "$review_receipt" "$phase" "$(git rev-parse HEAD)" "$PROMPT_DIR/$phase.txt"; then
      atomic_write "$RESULT_FILE" "BLOCKED PHASE_ACCEPTANCE_REVIEW_REQUIRED phase=$phase"
      atomic_write "$STATE_DIR/checkpoint" "phase=$phase state=AWAITING_ACCEPTANCE head=$(git rev-parse HEAD)"
      fail "Build/tests are insufficient to establish phase acceptance. Recovery supervisor must review the original prompt, commit implementation, and record requirement-by-requirement evidence at $review_receipt before resume."
    fi
    atomic_write "$STATE_DIR/done-$phase" "$(git rev-parse HEAD)"
    atomic_write "$STATE_DIR/checkpoint" "phase=$phase state=VERIFIED head=$(git rev-parse HEAD)"
    logline "Phase $phase completed. HEAD=$(git rev-parse --short HEAD); dirty=$(test -z "$(git status --porcelain)" && echo no || echo yes)."
  done
  set_phase "ALL_PHASES_FINISHED"
  logline "Inspect git worktree: $WORKTREE"
  logline "Review changes and tests before merging; this script does not install/deploy the new supervisor."
}

show_status() {
  load_config
  echo "Wazir Self-Improvement FEATURE BUILD — not the future continuous supervisor"
  printf 'Service: '; systemctl --user is-active "$SERVICE" 2>/dev/null || true
  printf 'Systemd state: '; systemctl --user show "$SERVICE" -p SubState -p MainPID -p ExecMainStatus --no-pager 2>/dev/null || true
  printf 'Phase: '; cat "$PHASE_FILE" 2>/dev/null || echo UNKNOWN
  printf 'Result: '; cat "$RESULT_FILE" 2>/dev/null || echo UNKNOWN
  printf 'Completed phases: '; local i; for i in 1 2 3 4; do [[ -f "$STATE_DIR/done-$i" ]] && printf '%s ' "$i"; done; echo
  printf 'Git worktree: %s\n' "$WORKTREE"
  git -C "$WORKTREE" status --short --branch 2>/dev/null | head -n 14 || true
  printf 'Latest log lines:\n'; tail -n 16 "$LOG" 2>/dev/null || true
  echo "Full logs: bash $SELF logs --follow"
}

show_logs() {
  [[ -f "$LOG" ]] || fail "No log yet: $LOG"
  if [[ "${1:-}" == "--follow" || "${1:-}" == "-f" ]]; then tail -n 35 -F "$LOG"; else tail -n 100 "$LOG"; fi
}

case "${1:-help}" in
  start) shift; start_job "$@";;
  resume)
    shift
    (($# == 0)) || fail "resume uses the persisted configuration; no options accepted"
    load_config
    # Do not call start_job: it regenerates prompts/configuration and loses resume provenance.
    [[ -d "$WORKTREE" && -x "$WA_BIN" ]] || fail "Existing worktree/runtime unavailable"
    if systemctl --user is-active --quiet "$SERVICE"; then echo "Already running"; exit 0; fi
    systemctl --user start "$SERVICE"
    ;;
  run-worker) run_worker;;
  status) show_status;;
  logs) shift; show_logs "${1:-}";;
  stop) require systemctl; systemctl --user stop "$SERVICE"; echo "Stopped $SERVICE; current worktree and logs preserved.";;
  path) load_config; echo "$WORKTREE";;
  help|--help|-h) usage;;
  *) usage; exit 2;;
esac
