# Fixes applied

Base: `e87d7e3`. Integrated commits:

| Commit | Correction | Evidence |
|---|---|---|
| ab88a30 | Count message framing and native tool payloads; reserve only native schemas sent outside the system text | Compaction regression tests |
| 2b7587d | Separate resident model reuse/context growth from new full loads; respect stale local telemetry | 25 admission tests |
| 263aaf7 | Avoid adding overlapping purgeable pages to macOS reclaimable memory | Hardware telemetry regression |
| 48fd1e1 | Fence late job events/promises, cancel replaced jobs, clear streaming buffers and prevent repeated start listeners | Lifecycle and conversation projection tests |
| 8c98c6e | Lazy SQLite lookup/database initialization; remove global warning interception and eager bundle probe | Lazy ledger and cross-process tests |
| a8f6808 | Retry scheduling after a selected model fails placement; exclude rejected candidates with bounded attempts; retain pins and policy gates | Scheduler regression |
| 156d20c | Prefer the lowest known suitable execution cost after placement rejection | Three-candidate fallback regression |
| 880185e | Task-aware output reserve shared by compilation, revisions, compaction and actual generation caps | Compiler and CodingAgent tests |
| d18dd67 | Preserve small-code output capacity on 8K contexts and carry discovered provider output ceilings | Compiler planning tests and TypeScript builds |
| 4e818cb | Isolate compaction threshold fixture from task-aware output policy | Eight compaction tests |
| 7b39b51, 305ee6f, 13fdb3a | Runnable 20-area manifest, consecutive ChatAgent regression, CLI-only build | 19 deterministic files: 212 passed, 1 skipped in first integrated run |
| c880b17 | Treat arithmetic/reply-only prompts as non-mutating while retaining program-writing requirements | 13 planner tests |
| bf0191c | Clamp explicit NVIDIA generation requests at the adapter boundary and expand suite coverage | 16 adapter tests; final integrated run: 21 files, 241 passed, 1 skipped |

The original `8609` output-reserve value cannot be derived from the inspected current branches: the former CLI reserve was 4096, the former compiler default was 8000, and the agent's former percentage branch never exceeded 3200. It is not treated as a proven hardcoded value. The repair removes those task-insensitive policies without inventing a numeric trace.

The natural-language `Tip: Use !...` string is absent from this checkout. Existing direct-command recognition accepts a narrow set of literal commands and excludes natural-language questions. No new shell suggestion or execution permission was introduced.

The live baseline used the real chat path before the output-policy integration: arithmetic returned the right value with extra wording; quicksort hit the configured 60-second timeout; a subsequent arithmetic job succeeded without repeating the prior failure. Final results must be evaluated separately from these baseline observations.
