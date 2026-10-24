#!/usr/bin/env bash
set -euo pipefail

# setup-formal-tools.sh
# Sets up the formal assurance toolchain for Wazir:
#   - Java 17+ check
#   - Alloy Analyzer 6.2.0 (org.alloytools.alloy.dist.jar)
#   - Python venv(s) with z3-solver, scenic, verifai
#   - Dafny 4.x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOOLS_DIR="${WAZIR_TOOLS_DIR:-${REPO_ROOT}/tools}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tools-dir)
      TOOLS_DIR="$2"
      shift 2
      ;;
    --tools-dir=*)
      TOOLS_DIR="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--tools-dir <path>]" >&2
      exit 1
      ;;
  esac
done

mkdir -p "${TOOLS_DIR}"
TOOLS_DIR="$(cd "${TOOLS_DIR}" && pwd)"
echo "==> Setting up formal assurance tools in: ${TOOLS_DIR}"

# 1. Check Java 17+
echo "==> [1/4] Checking Java 17+..."
if command -v java >/dev/null 2>&1; then
  java -version 2>&1 | head -n 3
else
  echo "WARNING: java not found on PATH. Alloy Analyzer requires Java 17+." >&2
fi

# 2. Alloy Analyzer 6.2.0
ALLOY_DIR="${TOOLS_DIR}/alloy"
ALLOY_JAR="${ALLOY_DIR}/org.alloytools.alloy.dist.jar"
ALLOY_SHA256="6b8c1cb5bc93bedfc7c61435c4e1ab6e688a242dc702a394628d9a9801edb78d"
ALLOY_URL="https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v6.2.0/org.alloytools.alloy.dist.jar"

mkdir -p "${ALLOY_DIR}"

verify_sha256() {
  local file="$1"
  local expected="$2"
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  local actual=""
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    actual="$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$file")"
  fi
  [[ "$actual" == "$expected" ]]
}

echo "==> [2/4] Setting up Alloy Analyzer 6.2.0..."
if verify_sha256 "${ALLOY_JAR}" "${ALLOY_SHA256}"; then
  echo "    Alloy JAR already present and SHA-256 verified at ${ALLOY_JAR}"
else
  # Check local caches / Downloads before network fetch
  for candidate in \
    "${HOME}/Downloads/org.alloytools.alloy.dist.jar" \
    "${REPO_ROOT}/org.alloytools.alloy.dist.jar" \
    "/tmp/org.alloytools.alloy.dist.jar"; do
    if [[ -f "${candidate}" ]] && verify_sha256 "${candidate}" "${ALLOY_SHA256}"; then
      echo "    Copying verified Alloy JAR from ${candidate}..."
      cp "${candidate}" "${ALLOY_JAR}"
      break
    fi
  done

  if ! verify_sha256 "${ALLOY_JAR}" "${ALLOY_SHA256}"; then
    echo "    Downloading Alloy 6.2.0 from ${ALLOY_URL}..."
    curl -fsSL -L "${ALLOY_URL}" -o "${ALLOY_JAR}"
  fi

  if verify_sha256 "${ALLOY_JAR}" "${ALLOY_SHA256}"; then
    echo "    Alloy JAR SHA-256 verified: ${ALLOY_SHA256}"
  else
    echo "ERROR: Alloy JAR SHA-256 verification failed!" >&2
    exit 1
  fi
fi

# 3. Python formal tools venv (z3-solver, scenic, verifai)
echo "==> [3/4] Setting up Python formal venv (z3-solver, scenic, verifai)..."
PYTHON_BIN="${PYTHON_BIN:-python3}"
Z3_VENV="${TOOLS_DIR}/z3-venv"

if [[ ! -x "${Z3_VENV}/bin/python" ]]; then
  "${PYTHON_BIN}" -m venv "${Z3_VENV}"
fi

"${Z3_VENV}/bin/pip" install --upgrade pip wheel setuptools >/dev/null
"${Z3_VENV}/bin/pip" install z3-solver scenic verifai

# Ensure symlinks exist so tools/z3-venv, tools/scenic-venv, tools/verifai-venv, and tools/formal-venv all resolve
for link_name in scenic-venv verifai-venv formal-venv; do
  link_path="${TOOLS_DIR}/${link_name}"
  if [[ ! -e "${link_path}" ]]; then
    ln -s "z3-venv" "${link_path}"
  fi
done

echo "    Z3 version: $("${Z3_VENV}/bin/python" -c 'import z3; print(z3.get_version_string())')"
echo "    Scenic version: $("${Z3_VENV}/bin/python" -c 'import scenic; print(getattr(scenic, "__version__", "installed"))')"
echo "    VerifAI version: $("${Z3_VENV}/bin/python" -c 'import verifai; print(getattr(verifai, "__version__", "installed"))')"

# 4. Dafny
echo "==> [4/4] Checking / installing Dafny..."
DAFNY_DIR="${TOOLS_DIR}/dafny"
mkdir -p "${DAFNY_DIR}"

if [[ -x "${DAFNY_DIR}/dafny" ]]; then
  echo "    Dafny already installed at ${DAFNY_DIR}/dafny: $("${DAFNY_DIR}/dafny" --version)"
elif command -v dafny >/dev/null 2>&1; then
  SYS_DAFNY="$(command -v dafny)"
  ln -sf "${SYS_DAFNY}" "${DAFNY_DIR}/dafny"
  echo "    Linked system Dafny (${SYS_DAFNY}): $("${DAFNY_DIR}/dafny" --version)"
else
  DAFNY_VERSION="4.9.0"
  OS_NAME="$(uname -s)"
  ARCH_NAME="$(uname -m)"
  DAFNY_ZIP=""
  if [[ "${OS_NAME}" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      echo "    Installing Dafny via Homebrew..."
      brew install dafny || true
    fi
    if command -v dafny >/dev/null 2>&1; then
      ln -sf "$(command -v dafny)" "${DAFNY_DIR}/dafny"
    else
      DAFNY_ZIP="dafny-${DAFNY_VERSION}-arm64-macos-13.zip"
    fi
  elif [[ "${OS_NAME}" == "Linux" ]]; then
    if [[ "${ARCH_NAME}" == "aarch64" || "${ARCH_NAME}" == "arm64" ]]; then
      DAFNY_ZIP="dafny-${DAFNY_VERSION}-arm64-ubuntu-20.04.zip"
    else
      DAFNY_ZIP="dafny-${DAFNY_VERSION}-x64-ubuntu-20.04.zip"
    fi
  fi

  if [[ ! -x "${DAFNY_DIR}/dafny" && -n "${DAFNY_ZIP}" ]]; then
    DAFNY_URL="https://github.com/dafny-lang/dafny/releases/download/v${DAFNY_VERSION}/${DAFNY_ZIP}"
    echo "    Downloading Dafny from ${DAFNY_URL}..."
    TMP_ZIP="${TOOLS_DIR}/${DAFNY_ZIP}"
    curl -fsSL -L "${DAFNY_URL}" -o "${TMP_ZIP}"
    unzip -q -o "${TMP_ZIP}" -d "${TOOLS_DIR}"
    rm -f "${TMP_ZIP}"
  fi

  if [[ -x "${DAFNY_DIR}/dafny" ]]; then
    echo "    Dafny version: $("${DAFNY_DIR}/dafny" --version)"
  else
    echo "WARNING: Dafny binary could not be automatically verified at ${DAFNY_DIR}/dafny" >&2
  fi
fi

echo "==> Formal assurance toolchain setup complete."
