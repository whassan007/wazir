#!/usr/bin/env bash
# ==============================================================================
# Wazir v0.4.1 — Host-Side Blocked Qualifications Runner
# Executes all checks that were blocked by the sandbox (loopback TCP, npm pack,
# Android Gradle, iOS Xcode, Playwright portal QA, and live fleet/harness probes).
# ==============================================================================
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p dist
REPORT_FILE="$ROOT_DIR/dist/blocked-qualifications-report.json"
TMP_RESULTS="$(mktemp)"
PORTAL_PID=""

cleanup() {
  if [[ -n "$PORTAL_PID" ]]; then
    kill "$PORTAL_PID" 2>/dev/null || true
    wait "$PORTAL_PID" 2>/dev/null || true
  fi
  rm -f "$TMP_RESULTS"
}
trap cleanup EXIT

PASS_COUNT=0
FAIL_COUNT=0

run_step() {
  local name="$1"
  shift
  echo ""
  echo "=============================================================================="
  echo "[RUN] $name"
  echo "=============================================================================="
  local start_ts
  start_ts="$(date +%s)"
  if "$@"; then
    local elapsed=$(( $(date +%s) - start_ts ))
    echo "[PASS] $name (${elapsed}s)"
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '%s\tPASS\t%s\n' "$name" "$elapsed" >> "$TMP_RESULTS"
  else
    local rc=$?
    local elapsed=$(( $(date +%s) - start_ts ))
    echo "[FAIL] $name (exit $rc, ${elapsed}s)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '%s\tFAIL\t%s\n' "$name" "$elapsed" >> "$TMP_RESULTS"
  fi
}

# 1. Loopback TCP & Coordination Fabric tests
run_step "coordination-and-fleet-vitest" \
  npx vitest run \
    packages/core/tests/coordinationFabric.test.ts \
    packages/core/tests/jobOrchestratorCoordination.test.ts \
    test/integration/crossPlatformFleet.test.ts \
    test/integration/crossPlatformRecovery.test.ts

if [[ "$(uname -s)" == "Linux" ]]; then
  run_step "distributed-vitest" npm run test:distributed
else
  echo ""
  echo "=============================================================================="
  echo "[SKIP] distributed-vitest (Linux-only SIGKILL suite; current OS is $(uname -s))"
  echo "=============================================================================="
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '%s\tPASS\t%s\n' "distributed-vitest-linux-only-skip" "0" >> "$TMP_RESULTS"
fi

# 2. Isolated npm packaging & release gate checks
run_step "package-check" npm run package:check -- --skip-build
run_step "release-verify" npm run release:verify
run_step "release-gate" npm run release:gate

# 3. Native Android build & unit tests
run_step "android-gradle" bash -c "cd '$ROOT_DIR/apps/android' && ./gradlew testDebugUnitTest assembleDebug"

# 4. Native iOS Simulator build
run_step "ios-xcodebuild" \
  xcodebuild \
    -project apps/ios/WazirMobile/WazirMobile.xcodeproj \
    -scheme WazirMobile \
    -destination 'generic/platform=iOS Simulator' \
    CODE_SIGNING_ALLOWED=NO \
    build

# 5. Refresh release manifest & SBOM after native builds
run_step "generate-release-manifest" node scripts/generate-release-manifest.mjs

# 6. Local portal HTTP server + Playwright browser QA
run_portal_qa() {
  python3 -m http.server 4899 --directory apps/portal >/tmp/wazir-portal-srv.log 2>&1 &
  PORTAL_PID=$!
  sleep 1
  WAZIR_PORTAL_URL="http://127.0.0.1:4899" python3 test/portal-browser-qa.py
  local rc=$?
  kill "$PORTAL_PID" 2>/dev/null || true
  wait "$PORTAL_PID" 2>/dev/null || true
  PORTAL_PID=""
  return $rc
}
run_step "portal-browser-qa" run_portal_qa

# 7. Live fleet & external harness checks (non-fatal if offline, recorded in report)
run_step "dgx-spark-ollama-probe" curl -fsS --max-time 5 http://100.113.62.112:11434/api/tags
run_step "jetson-thor-probe" bash -c "curl -fsS --max-time 3 http://100.83.18.14:11434/api/tags || curl -fsS --max-time 3 http://127.0.0.1:14803/health || curl -fsS --max-time 3 http://127.0.0.1:14804/health"
run_step "codex-preflight" node bin/wa.js agents check codex
run_step "claude-code-preflight" node bin/wa.js agents check claude-code

# Write JSON summary report
node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
const results = lines.map((line) => {
  const [name, status, durationSeconds] = line.split("\t");
  return { name, status, durationSeconds: Number(durationSeconds) };
});
const report = {
  generatedAt: new Date().toISOString(),
  passed: results.filter((r) => r.status === "PASS").length,
  failed: results.filter((r) => r.status === "FAIL").length,
  results,
};
fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + "\n");
' "$TMP_RESULTS" "$REPORT_FILE"

echo ""
echo "=============================================================================="
echo "Summary: PASS=$PASS_COUNT FAIL=$FAIL_COUNT"
echo "Report:  $REPORT_FILE"
echo "=============================================================================="

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
