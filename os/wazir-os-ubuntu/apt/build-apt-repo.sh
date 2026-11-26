#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APT_DIR="${ROOT_DIR}/dist/apt"
POOL_DIR="${APT_DIR}/pool/main/w/wazir"
DIST_DIR="${APT_DIR}/dists/stable/main/binary-all"

mkdir -p "$POOL_DIR" "$DIST_DIR"
cp "${ROOT_DIR}"/dist/deb/wazir_*_all.deb "$POOL_DIR/" 2>/dev/null || cp "${ROOT_DIR}"/dist/wazir_*_all.deb "$POOL_DIR/"

if command -v dpkg-scanpackages >/dev/null 2>&1; then
  (cd "$APT_DIR" && dpkg-scanpackages --multiversion pool/ > "${DIST_DIR}/Packages")
  gzip -9c "${DIST_DIR}/Packages" > "${DIST_DIR}/Packages.gz"
  echo "Generated APT Packages and Packages.gz in ${DIST_DIR}."
else
  echo "dpkg-scanpackages not available; staged .deb in ${POOL_DIR}."
fi
