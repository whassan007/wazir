#!/usr/bin/env bash
# Registers Wazir as a harness in a schubergphilis/ai-test-harness checkout.
# Usage: integrations/ai-test-harness/install.sh <path-to-ai-test-harness> [wazir-root]
# wazir-root defaults to the Wazir checkout containing this script; it must be built (npm run build).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
target="${1:?path to ai-test-harness checkout}"
wazir_root="$(cd "${2:-$here/../..}" && pwd)"
[ -f "$wazir_root/packages/runtimes/lmstudio/dist/src/index.js" ] || { echo "build Wazir first: (cd $wazir_root && npm run build)" >&2; exit 1; }
cd "$target"
[ -d harnesses/wazir ] || make new-harness NAME=wazir HARNESS_LANG=node
sed "s#__WAZIR_ROOT__#$wazir_root#" "$here/agent.ts" > harnesses/wazir/src/agent.ts
(cd harnesses/wazir && npm run build)
echo "Wazir harness installed (WAZIR_ROOT=$wazir_root). Run: make test-native HARNESS=wazir"
