# Model Verification

Result: FAILED — required model unavailable.

- Required model: `google/gemma-4-12b-qat`
- Wazir: `0.2.7`, source commit `be64805de60d`
- Platform: macOS 27.0.1, arm64
- `wa models list --json`: required model absent; only three NVIDIA hosted models listed.
- `wa models loaded --json`: required model absent; only three NVIDIA models loaded/READY.
- `wa models health --detail`: Google runtime UNAVAILABLE; LM Studio UNREACHABLE; memory 23/24 GiB CRITICAL.
- `lms ps` and `lms ls`: attempted to wake LM Studio but did not yield a usable local model inventory within the 20-second diagnostic bound.
- No model load attempt was made: the required model was not registered and system memory was critical.

Live benchmark validity: `INVALID/NOT RUN`. No request was sent, so no alternate model or hosted inference was used.

Raw diagnostic observations are recorded in checkpoint `0001-model-unavailable.md`.

