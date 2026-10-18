# Ranked Issues

1. P0 — Required local model `google/gemma-4-12b-qat` is absent from Wazir registration and loaded inventory; live execution cannot be validated.
2. P0 — LM Studio local runtime is unreachable while Wazir reports 23/24 GiB memory usage (CRITICAL); local inference cannot safely start.
3. P1 — `wa doctor` cannot open `/Users/wael/.wazir/wazir.json.lock` and reports MCP registry unavailable; configuration/diagnostic health is degraded.
4. P2 — NVIDIA telemetry is reported UNKNOWN for prompt-cache telemetry; unrelated to the required Gemma path but limits observability.

No code repair selected: none can be reproduced safely without the required model/runtime, and speculative changes would violate STOP-08/STOP-02 constraints.

