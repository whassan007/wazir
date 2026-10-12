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
expected_revision="$(node -e 'process.stdout.write(require(process.argv[1])["ai-test-harness"].commit)' "$here/upstream-revisions.json")"
[ "$(git rev-parse HEAD)" = "$expected_revision" ] || { echo "Unsupported upstream revision; checkout $expected_revision first" >&2; exit 1; }
[ -d harnesses/wazir ] || make new-harness NAME=wazir HARNESS_LANG=node
node - "$here" "$wazir_root" <<'JS'
const fs = require('node:fs');
const [here, root] = process.argv.slice(2);
const source = fs.readFileSync(`${here}/agent.ts`, 'utf8');
fs.writeFileSync('harnesses/wazir/src/agent.ts', source.replace("'__WAZIR_ROOT__'", JSON.stringify(root)));
const server = 'harnesses/wazir/src/server.ts';
fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replace('process.env.HOST ?? "0.0.0.0"', 'process.env.HOST ?? "127.0.0.1"'));
JS
(cd harnesses/wazir && npm run build)
echo "Wazir harness installed (WAZIR_ROOT=$wazir_root). Run: make test-native HARNESS=wazir"
