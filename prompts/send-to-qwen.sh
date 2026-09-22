#!/usr/bin/env bash
# Sends the Wazir evidence-bound-verification prompt to the local LM Studio
# instance running unsloth/qwen3-coder-next.
set -euo pipefail

MODEL="unsloth/qwen3-coder-next"
PROMPT_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wazir-evidence-bound-verification.md"
LMS_HOST="${LMS_HOST:-http://localhost:1234}"

if ! lms server status >/dev/null 2>&1; then
  echo "Starting LM Studio server..."
  lms server start
fi

if ! lms ps 2>/dev/null | grep -q "$MODEL"; then
  echo "Loading model $MODEL..."
  lms load "$MODEL"
fi

python3 - "$PROMPT_FILE" "$MODEL" "$LMS_HOST" <<'PY'
import json
import sys
import urllib.request

prompt_file, model, host = sys.argv[1:4]
with open(prompt_file, "r") as f:
    prompt = f.read()

payload = {
    "model": model,
    "messages": [{"role": "user", "content": prompt}],
    "stream": True,
    "temperature": 0.2,
}

req = urllib.request.Request(
    f"{host}/v1/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)

with urllib.request.urlopen(req) as resp:
    for line in resp:
        line = line.decode("utf-8").strip()
        if not line.startswith("data: "):
            continue
        data = line[len("data: "):]
        if data == "[DONE]":
            break
        chunk = json.loads(data)
        delta = chunk["choices"][0]["delta"].get("content", "")
        sys.stdout.write(delta)
        sys.stdout.flush()
print()
PY
