#!/usr/bin/env bash
# Build a standalone native executable for Wazir using Node.js Single Executable Application (SEA)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO_ROOT/scripts/build-binary.mjs" "$@"
