# Model Verification — google/gemma-4-12b-qat

Audit run: 2026-10-17, local Mac (WaelMacPro.local, Apple Silicon, 24 GiB RAM, macOS 27.0.1)
Wazir version: v0.2.7 (channel homebrew, commit be64805)

## Inventory (expected, per audit spec)

- Model: google/gemma-4-12b-qat
- Parameters: 12B
- Approx size: 7.15 GB
- Runtime: Local (LM Studio)

## Actual runtime state

`lms ps`:

```
IDENTIFIER                MODEL                     STATUS    SIZE       CONTEXT    PARALLEL    DEVICE    TTL
google/gemma-4-12b-qat    google/gemma-4-12b-qat    IDLE      7.15 GB    8192       4           Local
```

- Model is loaded in LM Studio directly (confirmed via `lms`, independent of Wazir).
- Status IDLE = loaded, not currently generating. This is the correct/healthy state for "ready to serve."

`wa models health --detail` (lmstudio section):

```
lmstudio (lmstudio on local)
  Runtime     READY
  Inference   UNKNOWN
  Telemetry   UNKNOWN
  Memory      24 / 24 GiB CRITICAL
  Queue       unknown
  Model       google/gemma-4-12b-qat  LOADED loaded=true ready=false ctx=8192
  Model       qwen/qwen3.8-27b  INSTALLED loaded=false ready=false ctx=262144
```

### Finding M1 (candidate defect — see issues-ranked.md)

Wazir reports `ready=false` for a model that `lms ps` independently confirms is loaded and IDLE
(i.e., actually able to serve inference). This is a direct contradiction between ground truth
(LM Studio's own process state) and Wazir's own health model. If `ready=false` gates routing or
is surfaced to the user as "model not ready," this is a P1 observability defect at minimum, and
a P0 execution-reliability defect if it causes requests to be silently rerouted or blocked.

Also flagged: `Memory 24 / 24 GiB CRITICAL` for lmstudio runtime. Total system RAM is 24 GiB
(`sysctl hw.memsize` = 25769803776 bytes). Reporting "24/24 GiB CRITICAL" looks like total
capacity is being compared to itself (denominator bug), not actual used/available memory — needs
source inspection (see issues-ranked.md, pending root-cause).

## Execution dispatch test

Command:
```
wa run "What is 23 + 19? Return only the number." --model google/gemma-4-12b-qat --runtime lmstudio --routing-mode LOCAL_ONLY --json
```

Status: IN PROGRESS — exceeded 90s foreground timeout, moved to background task `bz2t7wjeh`.
This alone is a measurement: time-to-first-token / time-to-completion for a trivial arithmetic
prompt on a 12B local model exceeded 90 seconds. Awaiting completion to record actual duration,
actual model identifier used (confirm no silent substitution), and output correctness.

## Model substitution check

Pending first successful run — will record in execution-results.csv:
- Requested model: google/gemma-4-12b-qat
- Actual model used: TBD from --json output
- Runtime: TBD
- Substitution occurred: TBD
