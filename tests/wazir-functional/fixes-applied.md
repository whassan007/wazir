# Fixes applied

Base: `e87d7e3`. Integrated commits on `integration/cross-harness-outcome-recovery`:

| Commit | Correction | Evidence |
|---|---|---|
| `ab88a30` | Count message framing and native tool payloads; reserve only native schemas sent outside the system text | Compaction regression tests (`codingAgent.contextCompaction.test.ts`) |
| `2b7587d` | Separate resident model reuse/context growth from new full loads; respect stale local telemetry | 25 admission tests (`modelLifecycleAdmission.test.ts`) |
| `263aaf7` | Avoid adding overlapping purgeable pages to macOS reclaimable memory | Hardware telemetry regression (`hardwareDiscovery.test.ts`) |
| `48fd1e1` | Fence late job events/promises, cancel replaced jobs, clear streaming buffers and prevent repeated start listeners | Lifecycle and conversation projection tests (`tuiSessionLifecycle.test.ts`, `conversationProjection.test.ts`) |
| `8c98c6e` | Lazy SQLite lookup/database initialization; remove global warning interception and eager bundle probe | Lazy ledger and cross-process tests (`resourceLedgerLazyStartup.test.ts`) |
| `a8f6808` | Retry scheduling after a selected model fails placement; exclude rejected candidates with bounded attempts; retain pins and policy gates | Scheduler regression (`scheduler.test.ts`) |
| `156d20c` | Prefer the lowest known suitable execution cost after placement rejection | Three-candidate fallback regression (`scheduler.test.ts`) |
| `880185e` | Task-aware output reserve shared by compilation, revisions, compaction and actual generation caps | Compiler and CodingAgent tests (`contextCompiler.comprehensive.test.ts`, `codingAgent.contextCompaction.test.ts`) |
| `d18dd67` | Preserve small-code output capacity on 8K contexts and carry discovered provider output ceilings | Compiler planning tests and TypeScript builds |
| `4e818cb` | Isolate compaction threshold fixture from task-aware output policy | Eight compaction tests (`codingAgent.contextCompaction.test.ts`) |
| `7b39b51`, `305ee6f`, `13fdb3a` | Runnable 20-area manifest, consecutive ChatAgent regression, CLI-only build | 19 deterministic files: 212 passed, 1 skipped in first integrated run |
| `c880b17` | Treat arithmetic/reply-only prompts as non-mutating while retaining program-writing requirements | 13 planner tests (`planner.test.ts`) |
| `bf0191c` | Clamp explicit NVIDIA generation requests at the adapter boundary and expand suite coverage | 16 adapter tests (`nvidiaAdapter.test.ts`); integrated run: 21 files, 241 passed, 1 skipped |
| `55549ba`, `820cdab`, `0b28484` | Preserve baseline/handoff findings, startup evidence, and regression execution logs | `evidence/baseline-chat-jobs.json`, `evidence/final-deterministic-run.log` |
| `555f083` | Instruct verbatim user format compliance in `CodingAgent` fast-answer summary, raise factual output reserve floor from 128 to 256 tokens (preventing `reasoning_content` from truncating the JSON action envelope on local reasoning models), and support interactive policy approval in `live-pty.py` | 21 deterministic files (241 passed, 1 skipped) + live exact arithmetic (`"391"`), live same-session recovery, and live Python completion |

## Unconfirmed historical symptom details

- **Original `8609` output reserve**: Cannot be derived from inspected current source branches (the former CLI reserve was `4096`, the former compiler default was `8000`, and `CodingAgent`'s former percentage branch never exceeded `3200`). It is not treated as a proven hardcoded value. The repair removes those task-insensitive policies without inventing a numeric trace.
- **Historical `0.1 GiB` telemetry**: Immediately free memory on this 24 GiB macOS unified-memory host can legitimately drop below `0.4 GiB` while reclaimable (`inactive` + `speculative`) memory remains multi-GiB. The exact historical `0.1 GiB` sample is unavailable, so no fabricated trace is claimed; `263aaf7` and `2b7587d` fix purgeable double-counting and resident model memory accounting.
- **Natural-language `Tip: Use !...` suggestion**: This string is absent from the current codebase. Existing direct-command recognition accepts only a narrow allowlist of literal read-only commands (`ls`, `pwd`, `git status`, `git diff`, `git log`) and excludes natural-language questions.
