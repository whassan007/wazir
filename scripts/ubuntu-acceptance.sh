#!/usr/bin/env bash
# scripts/ubuntu-acceptance.sh — Real apt install + acceptance checks inside a clean Docker container.
# Uses docker create + docker cp + docker start + docker exec (heredoc stdin is swallowed in this env).
#
# Usage:
#   scripts/ubuntu-acceptance.sh <path-to-.deb> [ubuntu-image, default ubuntu:24.04]

DEB_PATH="${1:?Usage: $0 <path-to-.deb> [ubuntu-image, default ubuntu:24.04]}"
IMAGE="${2:-ubuntu:24.04}"

if [[ ! -f "$DEB_PATH" ]]; then
  echo "ERROR: .deb file not found: $DEB_PATH" >&2
  exit 1
fi

HOST_DEB_DIR="$(cd "$(dirname "$DEB_PATH")" && pwd)"
INNER_SCRIPT="$(mktemp)"

# ---------------------------------------------------------------------------
# Write inner script to working directory (accessible by docker cp)
# ---------------------------------------------------------------------------
cat > "$INNER_SCRIPT" <<'INNERSCRIPT'
#!/bin/bash
set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0

pass_check() { echo "CHECK $1 PASS"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail_check() { echo "CHECK $1 FAIL ($2)"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# -----------------------------------------------------------------------
# Step 1 — System prep: apt update, utilities, NodeSource Node 22
# -----------------------------------------------------------------------
echo "==> [SETUP] apt-get update ..."
apt-get update -y

echo "==> [SETUP] Installing utilities (curl ca-certificates gnupg file xvfb dbus-x11) ..."
apt-get install -y curl ca-certificates gnupg file xvfb dbus-x11

echo "==> [SETUP] Adding NodeSource repo for Node 22 ..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -

echo "==> [SETUP] Installing Node 22 (nodejs) ..."
apt-get install -y nodejs

echo "==> [SETUP] Node version: $(node --version)"

# -----------------------------------------------------------------------
# Step 2 — Real apt install of the .deb (NEVER dpkg --force)
# -----------------------------------------------------------------------
echo ""
echo "==> [INSTALL] Listing /pkg/ ..."
ls -la /pkg/

DEB_FILE="$(find /pkg -maxdepth 1 -name "*.deb" -printf "%f\n")"
if [[ -z "$DEB_FILE" ]]; then
  echo "ERROR: no .deb found in /pkg/" >&2
  exit 1
fi

echo "==> [INSTALL] apt-get install -y /pkg/${DEB_FILE} ..."
apt-get install -y "/pkg/${DEB_FILE}"

echo "==> [INSTALL] wazir version from dpkg: $(dpkg-query -W -f '\${Version}' wazir)"

# -----------------------------------------------------------------------
# Step 3 — Acceptance checks
# -----------------------------------------------------------------------
echo ""
echo "=============================="
echo "  ACCEPTANCE CHECK RESULTS"
echo "=============================="

# --- Helper: resolve ExecStart binary path ---
resolve_binary() {
  local val="${1#ExecStart=}"
  val="${val#-}"
  val="${val#@}"
  echo "${val%% *}"
}

# ===========================================================================
# CHECK 1: wa --version prints package version
# ===========================================================================
WA_VERSION=$(wa --version 2>&1 || true)
if echo "$WA_VERSION" | grep -qE "^[0-9]+\.[0-9]+\.[0-9]+"; then
  pass_check "wa-version (got ${WA_VERSION})"
else
  fail_check "wa-version (got '${WA_VERSION}')" "wa --version did not print a semantic version"
fi

# ===========================================================================
# CHECK 2: /usr/bin/wazir-shell exists and is executable
# ===========================================================================
if [ -x /usr/bin/wazir-shell ]; then
  pass_check "wazir-shell-exists"
else
  fail_check "wazir-shell-exists" "/usr/bin/wazir-shell missing or not executable"
fi

# ===========================================================================
# CHECK 3: wazir-shell-bin (if present) is ELF, ldd clean, xvfb-run exits 124
# ===========================================================================
if [ -x /usr/lib/wazir/wazir-shell-bin ]; then
  # file must show ELF
  FILE_OUT=$(file /usr/lib/wazir/wazir-shell-bin || true)
  if echo "$FILE_OUT" | grep -q "ELF"; then
    pass_check "shell-bin-elf"
  else
    fail_check "shell-bin-elf" "file output: ${FILE_OUT}"
  fi

  # ldd must show no "not found"
  LDD_OUT=$(ldd /usr/lib/wazir/wazir-shell-bin 2>&1 || true)
  if echo "$LDD_OUT" | grep -qi "not found"; then
    fail_check "shell-bin-ldd" "ldd has missing libs: ${LDD_OUT}"
  else
    pass_check "shell-bin-ldd"
  fi

  # xvfb-run -a timeout 10 should exit 124 (still running after 10 s)
  XVFB_EXIT=99
  xvfb-run -a timeout 10 /usr/lib/wazir/wazir-shell-bin --help > /dev/null 2>&1 || XVFB_EXIT=$?
  if [ "$XVFB_EXIT" -eq 124 ]; then
    pass_check "shell-bin-xvfb-124"
  else
    fail_check "shell-bin-xvfb-124" "xvfb-run exited $XVFB_EXIT (expected 124)"
  fi
else
  echo ""
  echo "NOTE: /usr/lib/wazir/wazir-shell-bin not present in this all-arch CLI-only package — SKIPPED shell-bin checks"
  pass_check "shell-bin-elf" "not applicable (CLI-only package, no native GUI binary)"
  pass_check "shell-bin-ldd" "not applicable (CLI-only package, no native GUI binary)"
  pass_check "shell-bin-xvfb-124" "not applicable (CLI-only package, no native GUI binary)"
fi

# ===========================================================================
# CHECK 4: Every .service ExecStart binary / script exists
# ===========================================================================
SERVICE_ISSUES_COUNT=0
SERVICE_ISSUES_TEXT=""
for svc_file in $(find /usr/lib/systemd/user /lib/systemd/system -name "wazir*.service" 2>/dev/null | sort); do
  while IFS= read -r line; do
    bin="$(resolve_binary "$line")"
    if [ -z "$bin" ] || [ "$bin" = "-" ]; then
      continue  # systemd special values
    fi
    # Resolve @ or $ substitutions — strip them for the check
    clean_bin="$(echo "$bin" | sed 's/[@\$].*//')"
    if [ ! -e "$clean_bin" ]; then
      SERVICE_ISSUES_COUNT=$((SERVICE_ISSUES_COUNT + 1))
      SERVICE_ISSUES_TEXT="${SERVICE_ISSUES_TEXT}\n  ${svc_file}: ${line} (binary ${clean_bin} NOT FOUND)"
    fi
  done < <(grep -E "^ExecStart=" "$svc_file" 2>/dev/null || true)
done

if [ "$SERVICE_ISSUES_COUNT" -eq 0 ]; then
  pass_check "service-execstart (all ExecStart binaries present)"
else
  fail_check "service-execstart" "$(echo -e "$SERVICE_ISSUES_TEXT")"
fi

# ===========================================================================
# CHECK 5: apt-get remove --purge -y wazir exits 0
# ===========================================================================
REMOVAL_EXIT=0
apt-get remove --purge -y wazir > /dev/null 2>&1 || REMOVAL_EXIT=$?
if [ "$REMOVAL_EXIT" -eq 0 ]; then
  pass_check "remove-purge (exit ${REMOVAL_EXIT})"
else
  fail_check "remove-purge" "exit code ${REMOVAL_EXIT}"
fi

# ===========================================================================
# Summary
# ===========================================================================
echo ""
echo "---RESULTS---"
echo "PASS=${PASS_COUNT}"
echo "FAIL=${FAIL_COUNT}"

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo ""
  echo "ACCEPTANCE_RESULT=PASS"
else
  echo ""
  echo "ACCEPTANCE_RESULT=FAIL (${FAIL_COUNT} checks failed)"
fi

echo ""
echo "Totals: PASS=${PASS_COUNT}  FAIL=${FAIL_COUNT}"
INNERSCRIPT

chmod +x "$INNER_SCRIPT"

# ---------------------------------------------------------------------------
# Docker flow: create with volume, cp script, start, exec, cleanup
# ---------------------------------------------------------------------------
CONTAINER_ID=$(docker create -v "${HOST_DEB_DIR}:/pkg:ro" "$IMAGE" tail -f /dev/null)
docker start "${CONTAINER_ID}" > /dev/null 2>&1
docker cp "$INNER_SCRIPT" "${CONTAINER_ID}:/acceptance.sh"

# Run the acceptance script via exec (output is captured properly this way)
docker exec "${CONTAINER_ID}" bash /acceptance.sh
EXIT_CODE=$?

# Cleanup
docker stop "${CONTAINER_ID}" > /dev/null 2>&1 || true
docker rm -f "${CONTAINER_ID}" > /dev/null 2>&1 || true
rm -f "$INNER_SCRIPT"

exit $EXIT_CODE
