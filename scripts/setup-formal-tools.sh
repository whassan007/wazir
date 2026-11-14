#!/usr/bin/env bash
set -euo pipefail

# setup-formal-tools.sh
# Sets up the formal assurance toolchain for Wazir:
#   - Java 17+ (OpenJDK 21+)
#   - Alloy Analyzer 6.2.0 (org.alloytools.alloy.dist.jar)
#   - Python venv(s) with z3-solver, scenic, verifai (and symlinks z3-venv, scenic-venv, verifai-venv, formal-venv)
#   - Dafny 4.11.0

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

mkdir -p "${TOOLS_DIR}" "${HOME}/.local/bin"
TOOLS_DIR="$(cd "${TOOLS_DIR}" && pwd)"
echo "==> Setting up formal assurance tools in: ${TOOLS_DIR}"

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

# 1. Check / Install Java 17+
echo "==> [1/4] Checking Java 17+..."
JAVA_DIR="${TOOLS_DIR}/java"
mkdir -p "${JAVA_DIR}/bin"

check_java_17() {
  local jbin="$1"
  if [[ ! -x "$jbin" ]]; then
    return 1
  fi
  local ver
  ver="$("$jbin" -version 2>&1 | head -n 1 | sed -E 's/.*"([0-9]+).*/\1/' || true)"
  [[ "$ver" =~ ^[0-9]+$ ]] && (( ver >= 17 ))
}

if check_java_17 "${JAVA_DIR}/bin/java"; then
  echo "    Java 17+ already in ${JAVA_DIR}/bin/java"
elif [[ "${OS_NAME}" == "Darwin" && -x "/opt/homebrew/opt/openjdk@21/bin/java" ]]; then
  ln -sf "/opt/homebrew/opt/openjdk@21/bin/java" "${JAVA_DIR}/bin/java"
  ln -sf "/opt/homebrew/opt/openjdk@21/bin/java" "${HOME}/.local/bin/java"
elif [[ "${OS_NAME}" == "Darwin" && -x "/opt/homebrew/opt/openjdk/bin/java" ]]; then
  ln -sf "/opt/homebrew/opt/openjdk/bin/java" "${JAVA_DIR}/bin/java"
  ln -sf "/opt/homebrew/opt/openjdk/bin/java" "${HOME}/.local/bin/java"
elif command -v java >/dev/null 2>&1 && check_java_17 "$(command -v java)"; then
  ln -sf "$(command -v java)" "${JAVA_DIR}/bin/java"
elif [[ "${OS_NAME}" == "Linux" && ( "${ARCH_NAME}" == "aarch64" || "${ARCH_NAME}" == "arm64" ) ]]; then
  JDK_URL="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.13_9.tar.gz"
  echo "    Downloading Temurin OpenJDK 21 (Linux aarch64)..."
  curl -fsSL -L "${JDK_URL}" -o "${JAVA_DIR}/jdk21.tar.gz"
  tar -xzf "${JAVA_DIR}/jdk21.tar.gz" -C "${JAVA_DIR}" --strip-components=1
  rm -f "${JAVA_DIR}/jdk21.tar.gz"
  ln -sf "${JAVA_DIR}/bin/java" "${HOME}/.local/bin/java"
fi

if [[ -x "${JAVA_DIR}/bin/java" ]]; then
  "${JAVA_DIR}/bin/java" -version 2>&1 | head -n 3
else
  echo "WARNING: Java 17+ could not be configured at ${JAVA_DIR}/bin/java" >&2
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

if ! "${Z3_VENV}/bin/python" -c "import z3, scenic, verifai" >/dev/null 2>&1; then
  "${Z3_VENV}/bin/pip" install --upgrade pip wheel setuptools >/dev/null
  "${Z3_VENV}/bin/pip" install z3-solver scenic verifai
fi

for link_name in scenic-venv verifai-venv formal-venv; do
  link_path="${TOOLS_DIR}/${link_name}"
  if [[ ! -e "${link_path}" ]]; then
    ln -sfn "z3-venv" "${link_path}"
  fi
done

echo "    Z3 version: $("${Z3_VENV}/bin/python" -c 'import z3; print(z3.get_version_string())')"
echo "    Scenic version: $("${Z3_VENV}/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("scenic"))')"
echo "    VerifAI version: $("${Z3_VENV}/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("verifai"))')"

# 4. Dafny 4.11.0
echo "==> [4/4] Checking / installing Dafny..."
DAFNY_DIR="${TOOLS_DIR}/dafny"
mkdir -p "${DAFNY_DIR}"
DAFNY_VERSION="4.11.0"

if [[ -x "${DAFNY_DIR}/dafny" ]] && "${DAFNY_DIR}/dafny" --version >/dev/null 2>&1; then
  echo "    Dafny already installed at ${DAFNY_DIR}/dafny: $("${DAFNY_DIR}/dafny" --version)"
elif [[ "${OS_NAME}" == "Darwin" ]]; then
  DAFNY_ZIP="dafny-${DAFNY_VERSION}-arm64-macos-13.zip"
  if [[ "${ARCH_NAME}" != "arm64" ]]; then
    DAFNY_ZIP="dafny-${DAFNY_VERSION}-x64-macos-13.zip"
  fi
  DAFNY_URL="https://github.com/dafny-lang/dafny/releases/download/v${DAFNY_VERSION}/${DAFNY_ZIP}"
  echo "    Downloading Dafny from ${DAFNY_URL}..."
  TMP_ZIP="${TOOLS_DIR}/${DAFNY_ZIP}"
  curl -fsSL -L "${DAFNY_URL}" -o "${TMP_ZIP}"
  unzip -q -o "${TMP_ZIP}" -d "${TOOLS_DIR}"
  rm -f "${TMP_ZIP}"
  xattr -dr com.apple.quarantine "${DAFNY_DIR}" 2>/dev/null || true
elif [[ "${OS_NAME}" == "Linux" && ( "${ARCH_NAME}" == "aarch64" || "${ARCH_NAME}" == "arm64" ) ]]; then
  DOTNET_DIR="${TOOLS_DIR}/dotnet"
  DAFNY_DOTNET_DIR="${TOOLS_DIR}/dafny-dotnet"
  mkdir -p "${DOTNET_DIR}" "${DAFNY_DOTNET_DIR}"
  if [[ ! -x "${DOTNET_DIR}/dotnet" ]]; then
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o "${DOTNET_DIR}/dotnet-install.sh"
    chmod +x "${DOTNET_DIR}/dotnet-install.sh"
    "${DOTNET_DIR}/dotnet-install.sh" --channel 8.0 --install-dir "${DOTNET_DIR}"
  fi
  if [[ ! -x "${DAFNY_DOTNET_DIR}/dafny" ]]; then
    DOTNET_ROOT="${DOTNET_DIR}" "${DOTNET_DIR}/dotnet" tool install --tool-path "${DAFNY_DOTNET_DIR}" dafny --version "${DAFNY_VERSION}"
  fi
  cat << EOF > "${DAFNY_DIR}/dafny"
#!/usr/bin/env bash
export DOTNET_ROOT="${DOTNET_DIR}"
export PATH="${Z3_VENV}/bin:${DOTNET_DIR}:\$PATH"
exec "${DAFNY_DOTNET_DIR}/dafny" "\$@"
EOF
  chmod +x "${DAFNY_DIR}/dafny"
elif [[ "${OS_NAME}" == "Linux" ]]; then
  DAFNY_ZIP="dafny-${DAFNY_VERSION}-x64-ubuntu-22.04.zip"
  DAFNY_URL="https://github.com/dafny-lang/dafny/releases/download/v${DAFNY_VERSION}/${DAFNY_ZIP}"
  echo "    Downloading Dafny from ${DAFNY_URL}..."
  TMP_ZIP="${TOOLS_DIR}/${DAFNY_ZIP}"
  curl -fsSL -L "${DAFNY_URL}" -o "${TMP_ZIP}"
  unzip -q -o "${TMP_ZIP}" -d "${TOOLS_DIR}"
  rm -f "${TMP_ZIP}"
fi

if [[ -x "${DAFNY_DIR}/dafny" ]]; then
  ln -sf "${DAFNY_DIR}/dafny" "${HOME}/.local/bin/dafny"
  echo "    Dafny version: $("${DAFNY_DIR}/dafny" --version)"
else
  echo "WARNING: Dafny binary could not be automatically verified at ${DAFNY_DIR}/dafny" >&2
fi

echo "==> Formal assurance toolchain setup complete."
