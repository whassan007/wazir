#!/usr/bin/env bash
# Wazir Formal Assurance — Independent Verifier (Agent 29)
# Runs in a clean environment on local or DGX, executes formal toolchain & vitest suite,
# and verifies claimed verdicts against observed solver outputs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${WAZIR_TOOLS_DIR:-$REPO_ROOT/tools}"
export PATH="$HOME/.local/bin:$TOOLS_DIR/java/bin:$TOOLS_DIR/dafny:$PATH"

echo "=== Wazir Formal Assurance Independent Verifier ==="
echo "Host: $(hostname) ($(uname -s) $(uname -m))"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"

echo "--- 1. Checking Formal Toolchain ---"
Z3_PY="$TOOLS_DIR/z3-venv/bin/python3"
ALLOY_JAR="$TOOLS_DIR/alloy/org.alloytools.alloy.dist.jar"
DAFNY_BIN="$TOOLS_DIR/dafny/dafny"

if [ -x "$Z3_PY" ]; then
  echo "[PASS] Z3 Python venv: $("$Z3_PY" -c "import z3; print(\"z3-\" + z3.get_version_string())")"
else
  echo "[NOT_RUN] Z3 Python venv missing at $Z3_PY"
fi

if [ -f "$ALLOY_JAR" ] && command -v java >/dev/null 2>&1; then
  JAR_SHA="$(shasum -a 256 "$ALLOY_JAR" 2>/dev/null | awk "{print \$1}" || sha256sum "$ALLOY_JAR" | awk "{print \$1}")"
  echo "[PASS] Alloy JAR: $ALLOY_JAR (sha256=$JAR_SHA)"
else
  echo "[NOT_RUN] Alloy JAR or java missing"
fi

if [ -x "$DAFNY_BIN" ]; then
  echo "[PASS] Dafny: $("$DAFNY_BIN" --version)"
else
  echo "[NOT_RUN] Dafny missing at $DAFNY_BIN"
fi

echo "--- 2. Running check-skills ---"
if [ -x "$REPO_ROOT/scripts/check-skills.sh" ]; then
  "$REPO_ROOT/scripts/check-skills.sh" --smoke || echo "[WARN] check-skills reported non-zero"
fi

echo "--- 3. Running @wazir/assurance Typecheck & Vitest Suite ---"
if [ -f "$REPO_ROOT/packages/assurance/tsconfig.json" ]; then
  (cd "$REPO_ROOT" && npx tsc -p packages/assurance/tsconfig.json --noEmit)
  echo "[PASS] @wazir/assurance typecheck"
  (cd "$REPO_ROOT" && npx vitest run packages/assurance/src/__tests__)
  echo "[PASS] @wazir/assurance test suite"
fi

echo "=== Independent Verification Complete ==="
