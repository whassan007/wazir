#!/usr/bin/env bash
set -Eeuo pipefail

# =============================================================================
# Wazir autonomous component implementation loop
#
# Controller: Bash
# Coding model: unsloth/qwen3-coder-next
# Runtime: LM Studio OpenAI-compatible API
#
# The model proposes patches.
# This script:
#   - inspects the repository
#   - sends bounded tasks to Qwen
#   - applies patches
#   - runs real tests
#   - feeds failures back to Qwen
#   - advances only when a component passes
#
# Qwen never decides whether a test passed. The shell does.
#
# NOTE: This repo runs vitest, not jest. Test filters below are plain
# substrings/paths matched by `vitest run <filter>`, NOT jest's
# --runInBand/--testPathPattern flags (those do not exist in vitest and
# would make every "test" step silently run the full suite or fail).
# =============================================================================

MODEL="${WAZIR_CODER_MODEL:-unsloth/qwen3-coder-next}"
LMSTUDIO_URL="${LMSTUDIO_URL:-http://127.0.0.1:1234/v1/chat/completions}"

CONTEXT_LENGTH="${WAZIR_CONTEXT_LENGTH:-96000}"
MAX_COMPONENT_ATTEMPTS="${MAX_COMPONENT_ATTEMPTS:-8}"
MAX_TOTAL_CALLS="${MAX_TOTAL_CALLS:-55}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="${ROOT}/.wazir-qwen-loop"
LOG_DIR="${STATE_DIR}/logs"
PROMPT_DIR="${STATE_DIR}/prompts"
RESPONSE_DIR="${STATE_DIR}/responses"
PATCH_DIR="${STATE_DIR}/patches"

mkdir -p "$LOG_DIR" "$PROMPT_DIR" "$RESPONSE_DIR" "$PATCH_DIR"

cd "$ROOT"

TOTAL_CALLS=0

# -----------------------------------------------------------------------------
# Feature specification
# -----------------------------------------------------------------------------

FEATURE_SPEC=$(cat <<'EOF'
Implement Wazir Model Lifecycle & Resource Admission.

The final architecture must support:

1. authoritative model lifecycle states:
   DISCOVERED
   INSTALLED
   LOADING
   LOADED
   READY
   UNLOADING
   UNLOADED
   FAILED
   UNAVAILABLE

2. computer resource snapshots:
   total/available RAM
   VRAM where applicable
   unified-memory awareness
   current reservations

3. model load estimation:
   model weights
   context memory
   runtime overhead
   safety reserve
   total estimated requirement

4. context planning:
   requested context
   model maximum
   runtime maximum
   configured maximum
   machine-safe maximum
   effective context

5. AUTO context selection.

6. explicit context requests.

7. --fit behavior for explicit context downshift.

8. admission control BEFORE runtime allocation.

9. atomic computer-level resource reservations.

10. lifecycle service:
    discover
    estimate
    load
    unload
    reload
    reconcile
    ensureReady

11. runtime adapter integration, initially LM Studio and Ollama where
    supported by existing architecture.

12. unload protection for active executions.

13. drain semantics.

14. model pinning.

15. optional idle-model eviction.

16. runtime reconciliation.

17. task-time automatic model readiness:
       WAITING_FOR_MODEL
          -> load
          -> READY
          -> resume same task

18. CLI:
       wa models list
       wa models discover
       wa models loaded
       wa models inspect
       wa models estimate
       wa models load
       wa models unload
       wa models pin
       wa models unpin
       wa models reconcile

19. Fleet model-state presentation.

20. semantic lifecycle/resource events.

CRITICAL INVARIANTS:

- installed != loaded != ready != eligible
- unsafe loads must be rejected before RuntimeAdapter.loadModel()
- context length is a resource decision
- context downshift must never be silent
- failed load must never become READY
- active models must not be evicted
- pinned models must not be automatically evicted
- concurrent loads must not overcommit the computer
- runtime observed state must reconcile Wazir state
- CLI/UI must use ModelLifecycleService, not call runtime adapters directly
- existing Wazir Registry, Scheduler, PolicyEngine, RuntimeAdapter,
  Observability and Persistence abstractions should be extended rather
  than duplicated

REPOSITORY BASELINE (read before writing patches):

- @wazir/core already exports ModelLifecycleService
  (packages/core/src/services/modelLifecycleService.ts) with
  assessResources, loadModel, loadRecommendedModels,
  loadAllEligibleModels, unloadModel, restoreLastModelSet,
  persistReadyModelSet and discoverAndReconcile already implemented.
  EXTEND this service; do not create a second lifecycle service.
- packages/core/src/types/model.ts and
  packages/core/src/types/resource.ts already define the model/resource
  record shapes. Reuse and extend them instead of inventing parallel
  types.
- packages/core/src/services/modelRegistry.ts is the existing
  ModelRegistry; contextCompiler.ts handles context assembly.
- Runtime adapters for LM Studio and Ollama already exist under
  packages/runtimes/*; tests/runtime/adapterContract.suite.ts is the
  shared contract both must satisfy.
- No ContextPlanner, AdmissionController, or a dedicated atomic
  reservation class exists yet; these are the components still missing.
EOF
)

# -----------------------------------------------------------------------------
# Components
#
# Format:
#   id|description|test command
#
# Test commands run under this repo's vitest setup:
#   npm test -- <filter>   ==   npm run build && vitest run <filter>
# <filter> is a plain path/substring vitest matches against test file
# paths (NOT a jest --testPathPattern regex).
#
# Test file targets below map onto this repo's already-designed test
# layout:
#   tests/model-cycle/*.test.ts   - domain/service-level model lifecycle
#   tests/runtime/*.test.ts       - runtime adapter contract/integration
#   apps/cli/tests/*.test.ts      - CLI + TUI/Fleet behavior
#   tests/integration/*.test.ts   - cross-service integration
#
# Components 01, 04, 07, 08, 09, 14 extend EXISTING test files.
# The rest introduce NEW test files following the same naming
# convention, since the corresponding source does not exist yet.
# -----------------------------------------------------------------------------

COMPONENTS=(
  "01-lifecycle|Implement/extend authoritative model lifecycle state model and transitions|npm test -- tests/model-cycle/lifecycleAndExplainability.test.ts"
  "02-resources|Implement computer ResourceSnapshot and unified-memory semantics|npm test -- tests/model-cycle/resourceSnapshot.test.ts"
  "03-estimator|Implement model load estimation and safety reserve|npm test -- tests/model-cycle/loadEstimation.test.ts"
  "04-context|Implement ContextPlanner, AUTO context, explicit context and --fit semantics|npm test -- tests/model-cycle/contextBudgeting.test.ts"
  "05-admission|Implement AdmissionController and reject unsafe loads before runtime invocation|npm test -- tests/model-cycle/admissionControl.test.ts"
  "06-reservations|Implement atomic computer-level resource reservations|npm test -- tests/model-cycle/resourceReservations.test.ts"
  "07-service|Extend ModelLifecycleService with reload/ensureReady orchestration|npm test -- apps/cli/tests/modelLifecycle.test.ts"
  "08-runtime|Integrate lifecycle operations with existing LM Studio and Ollama adapters|npm test -- tests/runtime/lmstudioAdapter.test.ts tests/runtime/ollamaAdapter.test.ts tests/runtime/adapterContract.suite.ts"
  "09-reconcile|Extend discoverAndReconcile for runtime-to-registry model state reconciliation|npm test -- tests/model-cycle/discoveryAndRegistries.test.ts"
  "10-readiness|Implement ensureReady and WAITING_FOR_MODEL task resumption|npm test -- tests/model-cycle/ensureReady.test.ts"
  "11-drain|Implement active-use protection, draining and pinning|npm test -- tests/model-cycle/drainAndPinning.test.ts"
  "12-eviction|Implement safe idle-model eviction planning|npm test -- tests/model-cycle/idleEviction.test.ts"
  "13-cli|Implement/extend wa models CLI commands|npm test -- apps/cli/tests/modelsCli.test.ts"
  "14-ui|Integrate model lifecycle state into Fleet TUI without duplicating control-plane state|npm test -- apps/cli/tests/fleetTui.test.ts"
  "15-e2e|Implement complete model lifecycle integration coverage|npm test -- tests/model-cycle/lifecycleE2e.test.ts tests/integration/goldenScenariosAndScheduler.test.ts"
)

# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------

die() {
  echo "ERROR: $*" >&2
  exit 1
}

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

repo_summary() {
  {
    echo "=== GIT STATUS ==="
    git status --short || true

    echo
    echo "=== TOP LEVEL ==="
    find . -maxdepth 2 -type f \
      \( -name 'package.json' \
      -o -name 'tsconfig.json' \
      -o -name 'vitest.config.*' \) \
      2>/dev/null | sort | head -80

    echo
    echo "=== RELEVANT MODEL/RUNTIME FILES ==="
    find . \
      \( -path './node_modules' -o -path './.git' -o -path './dist' \) \
      -prune -o \
      -type f \
      \( -iname '*model*' \
      -o -iname '*runtime*' \
      -o -iname '*computer*' \
      -o -iname '*scheduler*' \
      -o -iname '*resource*' \) \
      -print 2>/dev/null | head -160
  }
}

git_diff_compact() {
  git diff --stat
  echo
  git diff -- \
    ':!package-lock.json' \
    ':!pnpm-lock.yaml' \
    ':!yarn.lock' \
    | tail -n 1200
}

# -----------------------------------------------------------------------------
# LM Studio health
# -----------------------------------------------------------------------------

check_lmstudio() {
  log "Checking LM Studio..."

  curl -fsS \
    "${LMSTUDIO_URL%/chat/completions}/models" \
    >/dev/null \
    || die "LM Studio API unavailable at ${LMSTUDIO_URL}"

  log "LM Studio reachable."
}

# -----------------------------------------------------------------------------
# Qwen API call
# -----------------------------------------------------------------------------

ask_qwen() {
  local prompt_file="$1"
  local response_file="$2"

  if (( TOTAL_CALLS >= MAX_TOTAL_CALLS )); then
    die "Maximum Qwen calls reached: ${MAX_TOTAL_CALLS}"
  fi

  TOTAL_CALLS=$((TOTAL_CALLS + 1))

  log "Qwen call ${TOTAL_CALLS}/${MAX_TOTAL_CALLS}"

  python3 - "$LMSTUDIO_URL" "$MODEL" "$prompt_file" "$response_file" <<'PY'
import json
import sys
import urllib.request
import urllib.error

url, model, prompt_path, output_path = sys.argv[1:]

with open(prompt_path, "r", encoding="utf-8") as f:
    prompt = f.read()

payload = {
    "model": model,
    "messages": [
        {
            "role": "system",
            "content": """
You are the primary coding specialist for the Wazir repository.

You do NOT have shell, filesystem, Git, or test execution access.

The controller will provide current repository evidence.

Never claim that you ran a command, edited a file, or passed a test.

Your job is to reason from supplied evidence and produce implementation
patches.

When asked to modify code, return ONE unified Git diff inside:

<patch>
...unified diff...
</patch>

The patch must be directly applicable with git apply.

Do not use markdown fences inside <patch>.

After the patch return:

<analysis>
brief root cause/design explanation
</analysis>

<tests>
commands or tests the controller should run
</tests>

Prefer extending existing Wazir abstractions over creating parallel
subsystems.

Never weaken tests simply to obtain a pass.
"""
        },
        {
            "role": "user",
            "content": prompt
        }
    ],
    "temperature": 0.2,
    "stream": False
}

request = urllib.request.Request(
    url,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(request, timeout=1800) as response:
        result = json.load(response)
except Exception as exc:
    print(f"LM Studio request failed: {exc}", file=sys.stderr)
    sys.exit(2)

try:
    content = result["choices"][0]["message"]["content"]
except Exception:
    print(json.dumps(result, indent=2), file=sys.stderr)
    sys.exit(3)

with open(output_path, "w", encoding="utf-8") as f:
    f.write(content)

print(content)
PY
}

# -----------------------------------------------------------------------------
# Extract <patch>...</patch>
# -----------------------------------------------------------------------------

extract_patch() {
  local response_file="$1"
  local patch_file="$2"

  python3 - "$response_file" "$patch_file" <<'PY'
import re
import sys

source, target = sys.argv[1:]

text = open(source, encoding="utf-8").read()

match = re.search(r"<patch>\s*(.*?)\s*</patch>", text, re.S)

if not match:
    print("No <patch> block returned.", file=sys.stderr)
    sys.exit(1)

patch = match.group(1).strip() + "\n"

if not (
    "diff --git " in patch
    or ("--- " in patch and "+++ " in patch)
):
    print("Returned block does not appear to be a unified diff.", file=sys.stderr)
    sys.exit(2)

open(target, "w", encoding="utf-8").write(patch)
PY
}

# -----------------------------------------------------------------------------
# Patch safety
# -----------------------------------------------------------------------------

validate_patch() {
  local patch="$1"

  # Basic anti-test-theater checks (vitest equivalents of jest's skip/mocks).
  if grep -Eqi \
    '(\|\|[[:space:]]*true|describe\.skip|it\.skip|test\.skip|expect\(true\)|process\.exit\(0\))' \
    "$patch"; then
    echo "Patch contains suspicious test-bypass pattern." >&2
    return 1
  fi

  git apply --check "$patch"
}

apply_patch() {
  local patch="$1"

  validate_patch "$patch" || return 1

  git apply "$patch"
}

# -----------------------------------------------------------------------------
# Test runner
# -----------------------------------------------------------------------------

run_test() {
  local command="$1"
  local output_file="$2"

  log "TEST: $command"

  set +e
  bash -lc "$command" >"$output_file" 2>&1
  local rc=$?
  set -e

  cat "$output_file"

  return "$rc"
}

# -----------------------------------------------------------------------------
# Determine repository's actual baseline test tooling
# -----------------------------------------------------------------------------

baseline_validation() {
  local logfile="${LOG_DIR}/baseline.log"

  log "Running repository baseline validation"

  if [[ -f package.json ]] && command -v npm >/dev/null 2>&1; then
    if node -e \
      'const p=require("./package.json"); process.exit(p.scripts?.test ? 0 : 1)' \
      2>/dev/null; then

      set +e
      npm test >"$logfile" 2>&1
      local rc=$?
      set -e

      if (( rc != 0 )); then
        echo "Baseline suite already contains failures."
        echo "This is recorded but does not automatically abort the repair loop."
      fi
    fi
  fi
}

# -----------------------------------------------------------------------------
# Build initial component prompt
# -----------------------------------------------------------------------------

make_component_prompt() {
  local id="$1"
  local description="$2"
  local test_cmd="$3"
  local attempt="$4"
  local output="$5"

  {
    echo "WAZIR FEATURE IMPLEMENTATION"
    echo
    echo "COMPONENT: $id"
    echo "ATTEMPT: $attempt"
    echo
    echo "OBJECTIVE:"
    echo "$description"
    echo
    echo "OVERALL FEATURE CONTRACT:"
    echo "$FEATURE_SPEC"

    echo
    echo "CONTROLLER TEST COMMAND:"
    echo "$test_cmd"

    echo
    echo "REPOSITORY SUMMARY:"
    repo_summary

    echo
    echo "CURRENT DIFF:"
    git_diff_compact

    echo
    echo "TASK:"
    cat <<EOF
Inspect the supplied repository information and implement this component
using the existing Wazir architecture.

Do not invent a parallel subsystem if an existing abstraction should be
extended.

If the repository evidence is insufficient to produce a safe patch, do NOT
invent paths or APIs. Instead return:

<needs_context>
one path/symbol/search request per line
</needs_context>

Otherwise return exactly one directly applicable unified diff in <patch>.

The controller will apply the patch and run:

    ${test_cmd}

This project uses vitest, not jest: any test file you add or extend must
use vitest's describe/it/expect imports (as in the existing tests/
directory), and any filter you rely on is a path/substring, not a jest
--testPathPattern regex.

You do not run the test yourself.
EOF
  } >"$output"
}

# -----------------------------------------------------------------------------
# Repair prompt after real test failure
# -----------------------------------------------------------------------------

make_repair_prompt() {
  local id="$1"
  local description="$2"
  local test_cmd="$3"
  local attempt="$4"
  local test_log="$5"
  local output="$6"

  {
    echo "WAZIR REPAIR REQUEST"
    echo
    echo "COMPONENT: $id"
    echo "ATTEMPT: $attempt"
    echo
    echo "OBJECTIVE:"
    echo "$description"

    echo
    echo "THE CONTROLLER APPLIED THE PREVIOUS PATCH."
    echo "THE REAL TEST FAILED."
    echo
    echo "TEST COMMAND:"
    echo "$test_cmd"

    echo
    echo "ACTUAL TEST OUTPUT:"
    tail -n 500 "$test_log"

    echo
    echo "CURRENT GIT DIFF:"
    git_diff_compact

    echo
    echo "RELEVANT REPOSITORY FILES:"
    repo_summary

    cat <<'EOF'

Diagnose the ACTUAL failure above.

Do not repeat the previous patch unless the evidence proves it was incomplete.

Identify the first point where expected behavior diverges from actual
behavior.

Return a corrective unified diff inside <patch>.

Do not claim the test passes. The controller will execute it.
EOF
  } >"$output"
}

# -----------------------------------------------------------------------------
# Component loop
# -----------------------------------------------------------------------------

run_component() {
  local entry="$1"

  IFS='|' read -r id description test_cmd <<<"$entry"

  log "================================================================="
  log "COMPONENT: $id"
  log "$description"
  log "================================================================="

  local skip_log="${LOG_DIR}/${id}-skip-check.log"

  log "Checking whether ${id} already passes (e.g. from a prior run)..."

  if run_test "$test_cmd" "$skip_log"; then
    log "SKIPPING ${id}: test already passes, no Qwen call needed."
    return 0
  fi

  local attempt=1
  local previous_test_log=""

  while (( attempt <= MAX_COMPONENT_ATTEMPTS )); do

    if (( TOTAL_CALLS >= MAX_TOTAL_CALLS )); then
      die "Qwen call budget exhausted while processing ${id}"
    fi

    local prompt="${PROMPT_DIR}/${id}-attempt-${attempt}.txt"
    local response="${RESPONSE_DIR}/${id}-attempt-${attempt}.txt"
    local patch="${PATCH_DIR}/${id}-attempt-${attempt}.diff"
    local test_log="${LOG_DIR}/${id}-attempt-${attempt}-test.log"

    if (( attempt == 1 )); then
      make_component_prompt \
        "$id" "$description" "$test_cmd" "$attempt" "$prompt"
    else
      make_repair_prompt \
        "$id" "$description" "$test_cmd" "$attempt" \
        "$previous_test_log" "$prompt"
    fi

    ask_qwen "$prompt" "$response"

    # ---------------------------------------------------------------
    # Model may request additional context rather than hallucinating.
    # For the first version we stop explicitly instead of blindly
    # fabricating repository information.
    # ---------------------------------------------------------------

    if grep -q '<needs_context>' "$response"; then
      echo
      echo "Qwen requested additional repository context:"
      sed -n '/<needs_context>/,/<\/needs_context>/p' "$response"
      echo
      echo "Extend the context collector for these paths/symbols, then resume."
      return 2
    fi

    if ! extract_patch "$response" "$patch"; then
      log "Qwen did not return a valid patch. Retrying."
      attempt=$((attempt + 1))
      continue
    fi

    log "Validating patch..."

    if ! validate_patch "$patch"; then
      log "Patch rejected by safety/applicability validation."
      attempt=$((attempt + 1))
      continue
    fi

    log "Applying patch..."
    git apply "$patch"

    if run_test "$test_cmd" "$test_log"; then
      log "COMPONENT PASSED: ${id}"

      # Record successful component checkpoint without forcing a commit.
      git diff --stat

      return 0
    fi

    log "Component test failed: ${id}"
    previous_test_log="$test_log"

    attempt=$((attempt + 1))
  done

  log "FAILED after ${MAX_COMPONENT_ATTEMPTS} attempts: ${id}"
  return 1
}

# -----------------------------------------------------------------------------
# Final qualification
# -----------------------------------------------------------------------------

final_qualification() {
  log "================================================================="
  log "FINAL QUALIFICATION"
  log "================================================================="

  local failures=0

  for entry in "${COMPONENTS[@]}"; do
    IFS='|' read -r id description test_cmd <<<"$entry"

    local logfile="${LOG_DIR}/final-${id}.log"

    if run_test "$test_cmd" "$logfile"; then
      printf '  PASS %s\n' "$id"
    else
      printf '  FAIL %s\n' "$id"
      failures=$((failures + 1))
    fi
  done

  # Also run the complete repository test suite.
  if [[ -f package.json ]] && \
     node -e 'const p=require("./package.json"); process.exit(p.scripts?.test ? 0 : 1)' \
       2>/dev/null; then

    log "Running complete repository test suite..."

    set +e
    npm test >"${LOG_DIR}/final-full-suite.log" 2>&1
    local rc=$?
    set -e

    cat "${LOG_DIR}/final-full-suite.log"

    if (( rc != 0 )); then
      failures=$((failures + 1))
    fi
  fi

  if (( failures != 0 )); then
    echo
    echo "FINAL QUALIFICATION: FAIL"
    echo "Failures: $failures"
    return 1
  fi

  echo
  echo "FINAL QUALIFICATION: PASS"
}

# =============================================================================
# MAIN
# =============================================================================

echo
echo "WAZIR MODEL LIFECYCLE AUTONOMOUS IMPLEMENTATION"
echo "================================================"
echo "Repository : $ROOT"
echo "Model      : $MODEL"
echo "Context    : $CONTEXT_LENGTH"
echo "LM Studio  : $LMSTUDIO_URL"
echo "Call limit : $MAX_TOTAL_CALLS"
echo

check_lmstudio
baseline_validation

for component in "${COMPONENTS[@]}"; do
  run_component "$component" || {
    echo
    echo "AUTONOMOUS LOOP STOPPED"
    echo "A component could not be qualified."
    echo
    echo "State preserved under:"
    echo "  $STATE_DIR"
    exit 1
  }
done

final_qualification

echo
echo "================================================"
echo "WAZIR IMPLEMENTATION LOOP COMPLETE"
echo "Qwen calls: $TOTAL_CALLS"
echo
echo "Artifacts:"
echo "  prompts   $PROMPT_DIR"
echo "  responses $RESPONSE_DIR"
echo "  patches   $PATCH_DIR"
echo "  logs      $LOG_DIR"
echo
git status --short
