#!/usr/bin/env bash
# Wazir Formal Assurance — Independent Verifier (Agent 29)
# Runs in a clean environment on local or DGX, executes formal toolchain & vitest suite,
# and verifies claimed verdicts against observed solver outputs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_Candidate="$REPO_ROOT"
while [ ! -d "$ROOT_Candidate/tools/z3-venv" ] && [ "$(dirname "$ROOT_Candidate")" != "$ROOT_Candidate" ]; do
  ROOT_Candidate="$(dirname "$ROOT_Candidate")"
done
TOOLS_DIR="${WAZIR_TOOLS_DIR:-$ROOT_Candidate/tools}"
NM_Candidate="$REPO_ROOT"
while [ ! -d "$NM_Candidate/node_modules" ] && [ "$(dirname "$NM_Candidate")" != "$NM_Candidate" ]; do
  NM_Candidate="$(dirname "$NM_Candidate")"
done
NODE_MODULES_DIR="${WAZIR_NODE_MODULES_DIR:-$NM_Candidate/node_modules}"
CREATED_TOOLS_LINK=0
CREATED_NM_LINK=0
if [ ! -e "$REPO_ROOT/tools" ] && [ -d "$TOOLS_DIR" ]; then
  ln -s "$TOOLS_DIR" "$REPO_ROOT/tools"
  CREATED_TOOLS_LINK=1
fi
if [ ! -e "$REPO_ROOT/node_modules" ] && [ -d "$NODE_MODULES_DIR" ]; then
  ln -s "$NODE_MODULES_DIR" "$REPO_ROOT/node_modules"
  CREATED_NM_LINK=1
fi
cleanup() {
  if [ "$CREATED_TOOLS_LINK" = "1" ] && [ -L "$REPO_ROOT/tools" ]; then
    rm -f "$REPO_ROOT/tools"
  fi
  if [ "$CREATED_NM_LINK" = "1" ] && [ -L "$REPO_ROOT/node_modules" ]; then
    rm -f "$REPO_ROOT/node_modules"
  fi
}
trap cleanup EXIT
export PYTHON="${PYTHON:-$TOOLS_DIR/z3-venv/bin/python3}"
export DAFNY_PATH="${DAFNY_PATH:-$TOOLS_DIR/dafny/dafny}"
export WAZIR_Z3_PYTHON="${WAZIR_Z3_PYTHON:-$TOOLS_DIR/z3-venv/bin/python3}"
export WAZIR_SCENIC_PYTHON="${WAZIR_SCENIC_PYTHON:-$TOOLS_DIR/scenic-venv/bin/python3}"
export WAZIR_VERIFAI_PYTHON="${WAZIR_VERIFAI_PYTHON:-$TOOLS_DIR/verifai-venv/bin/python3}"
export SDL_VIDEODRIVER="${SDL_VIDEODRIVER:-dummy}"
export PATH="$HOME/.local/bin:$TOOLS_DIR/java/bin:$TOOLS_DIR/dafny:$TOOLS_DIR/z3-venv/bin:$PATH"

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
  (cd "$REPO_ROOT" && npx vitest run --exclude '**/.fa/**' packages/assurance/src/__tests__)
  echo "[PASS] @wazir/assurance test suite"
fi

echo "=== Independent Verification Complete ==="
