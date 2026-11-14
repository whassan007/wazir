#!/usr/bin/env bash
# Alloy 6.2 verification harness. Requires Java 17+ and official Alloy JAR.
# This is a command runner; do NOT infer property success from shell exit 0.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /absolute/path/to/org.alloytools.alloy.dist.jar [output-dir]" >&2
  exit 2
fi
JAR="$1"
if [[ ! -f "$JAR" ]]; then
  echo "ERROR: Alloy JAR not found: $JAR" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -gt 1 ]]; then
  BASE="$2"
  mkdir -p "$BASE"
else
  BASE="$(mktemp -d "${TMPDIR:-/tmp}/alloy-skill-XXXXXX")"
fi
BASE="$(cd "$BASE" && pwd)"
echo "Alloy results: $BASE"
java -jar "$JAR" help >/dev/null

for model in "$ROOT"/examples/*.als; do
  name="$(basename "${model%.als}")"
  dir="$BASE/$name"
  echo "=== $name ==="
  # -c '*' runs all labeled run/check commands (Alloy 6.2 CLI).
  java -jar "$JAR" exec -c '*' -t text -o "$dir" "$model" 2>&1 | tee "$BASE/$name.log"
  if [[ -f "$dir/receipt.json" ]]; then
    echo "Receipt: $dir/receipt.json"
  else
    echo "WARNING: receipt.json not found at expected location ($dir). Inspect CLI output."
  fi
done

echo
 echo "Completed command invocation. Inspect each receipt.json and corresponding"
 echo "model instance/counterexample before assigning PASS/FAIL."
 echo "Evidence directory: $BASE"
