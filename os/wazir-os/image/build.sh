#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-localhost/wazir-os:41}"
CONTAINER_TOOL="${CONTAINER_TOOL:-podman}"

echo "[wazir-os] Building Wazir JS/TS workspace & design tokens..."
cd "${ROOT_DIR}"
npm run build --workspace @wazir/design-tokens
npm run generate --workspace @wazir/design-tokens
npm run build --workspace @wazir/spotlight

echo "[wazir-os] Building OCI bootc image ${IMAGE_TAG} via ${CONTAINER_TOOL}..."
"${CONTAINER_TOOL}" build \
  -f "${ROOT_DIR}/os/wazir-os/image/Containerfile" \
  -t "${IMAGE_TAG}" \
  "${ROOT_DIR}"

echo "[wazir-os] Build complete: ${IMAGE_TAG}"
