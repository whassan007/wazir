# Changelog

## v0.1.57 — 2026-10-12

A persistence release. Checkpoints and long-term memory now survive restarts, the coding
agent keeps native tool-call history, and the web dashboard is no longer exposed beyond
localhost by default.

**Verification:** typecheck and build pass; 1964 tests pass, 0 fail (18 skipped:
PostgreSQL, bwrap sandbox and live lifecycle infrastructure); acceptance gates
80/80 PASS, verdict READY FOR RELEASE. Live (LM Studio `qwen/qwen3.8-27b`): every
`wa run` outcome matched an independent `npm test`.

### ⚠️ Behaviour changes

- **Web dashboard binds `127.0.0.1` by default.** Set `WAZIR_WEB_HOST=0.0.0.0` to
  restore network access.
- **A corrupt or unsupported persisted checkpoint stops engine startup** with
  `INVALID_CHECKPOINT` or `CHECKPOINT_DIGEST_MISMATCH` naming the record. Wazir fails
  closed rather than overwrite evidence. Move the named record aside to recover.
- **`integrations/ai-test-harness/install.sh` requires the pinned upstream revision**
  listed in `upstream-revisions.json`.

### Added

- **Durable checkpoints:** persisted to the host store with a version and digest,
  restored and verified at startup.
- **Durable episodic and procedural memory** in the SQLite store, reloaded on startup.
- **Native tool-call history in the coding agent:** provider call IDs are kept through
  assistant and tool messages, and a plain-text final answer from a native
  function-calling provider is accepted, subject to the usual verification.
- **Pinned upstream revisions** for ai-test-harness and Qwen-Live-Harness.

### Fixed

- A parallel batch of tool calls (common with Qwen models) aborted the whole run. It
  is now rejected as one invalid attempt: nothing in it executes, and the model is
  asked to issue one call. Live runs with 3 and 6 batches completed.
- The web dashboard never timed out stalled API requests, and kept proxying after the
  client disconnected.
- Checkpoint digests could collide for different path/content pairs.

## v0.1.56 — 2026-10-12

A reliability release. It adds the Qwen-Live-Harness integrations and fixes 22 defects
found by a stability audit and by running Wazir through
[schubergphilis/ai-test-harness](https://github.com/schubergphilis/ai-test-harness)
against a live local model.

**Verification:** typecheck and build pass; 1957 tests pass, 0 fail (18 skipped:
PostgreSQL, bwrap sandbox and live lifecycle infrastructure); acceptance gates
80/80 PASS, verdict READY FOR RELEASE.

### ⚠️ Behaviour changes

- **ACP permission requests now fail closed.** An `AcpClientAdapter` without an
  `onRequestPermission` resolver denies every request; previously it auto-approved.
- **Environment variables override `config.json`** for `WAZIR_OLLAMA_URL`,
  `WAZIR_LMSTUDIO_URL`, `WAZIR_API_URL`, `WAZIR_API_TOKEN` and
  `WAZIR_REGISTRATION_TOKEN`.
- **Reasoning is no longer part of model answers.** OpenAI-compatible / LM Studio
  streams emit model thinking as separate `reasoning` events. A reasoning model that
  runs out of tokens while thinking now returns an empty answer with
  `finishReason: 'length'` instead of its chain-of-thought.

### Added

- **Qwen-Live-Harness integration:** ACP client adapter (stdio delegation to Qwen
  Code, Claude Code, Codex, Gemini CLI), Subagents Ledger, Permission Broker, Tool
  Receipts, and a SQLite memory store with lexical ranking and time decay.
- **ai-test-harness integration** (`integrations/ai-test-harness/`): runs Wazir under
  the same compat-contract, Inspect and behaviour-scenario suites as Strands and other
  reference harnesses.
- **`/canary` view** in Mission Control (tabs, history selection), which existed but
  was unreachable.
- **`WAZIR_LMSTUDIO_API_KEY`** for authenticated OpenAI-compatible endpoints (LiteLLM,
  vLLM `--api-key`, LM Studio with auth).
- **`finishReason`** on `completed` runtime events (`content_filter`, `length`, …,
  or `cancelled` when the stream was aborted).
- **Acceptance gates G97–G100** (semantic strategy retrieval, false-positive control,
  cross-language transfer, anti-strategy). The harness reports `UNDEFINED` and `ERROR`
  separately from `FAIL`.

### Fixed

**Security and safety**
- ACP delegated agents were auto-approved when no operator decided. ACP options are
  now classified by their protocol `kind`, so a reject option labelled "No" is no
  longer read as approve.
- Mission Control `why …` explanations showed fabricated hashes, benchmark scores and
  health values. They now report only observed state, or `UNKNOWN`.

**Lifecycle and cancellation**
- External agent harnesses ignored cancellation until exit (up to 10 min), and their
  timeout never ended the run because child processes held the output pipe open.
  Cancellation now takes about 360 ms and kills the whole process tree.
- `cancelTask` on a finished task overwrote `completed` with `cancelled`.
- Provider streams are aborted when the consumer stops reading, so local models no
  longer keep generating.
- ACP: a missing executable or a failed turn crashed the host process. `initialize`
  is now bounded by a timeout.
- A job deleted while running was re-added to the TUI when it finished.

**Accuracy**
- All five provider adapters corrupted multi-byte UTF-8 (emoji, Arabic, CJK) split
  across stream chunks.
- Model reasoning leaked into answers and corrupted them. Seen live: "Answer
  8888888." + "8888888" was read as `88888888888888`.
- Tool results are sent in the native tool-call format when call IDs are known,
  instead of always as user text.

**Persistence and availability**
- One model that could not be inspected (e.g. LM Studio holding two instances of it)
  took the whole runtime offline, so every `wa run` failed. Only that model is now
  marked unavailable.
- Worker task streams leaked (registration and keep-alive timer) when a worker
  disconnected during subscribe.
- SQLite memory search could never return segments older than the newest 100.
- `config.json` silently overrode `WAZIR_*` environment variables, which broke the
  documented container setup.
- Ollama model listing could hang without a timeout.
- The acceptance harness crashed on undefined gates and on an absolute `--report`
  path.

### Docs

- `docs/audits/`: baseline, code audit, repairs, functional tests, performance,
  remaining risks and external-harness results.

### Known issues

See `docs/audits/WAZIR_REMAINING_RISKS.md`. In short: API dispatch records have no
retention policy; ACP is not yet wired into any CLI path; the tool sandbox needs
unprivileged user namespaces (unavailable on some Ubuntu hosts).

## v0.1.55 — 2026-09-24

Canary stage transitions refined; TUI prompt hotkey handling fixed.

## v0.1.54

TUI navigation hotkeys refined.
