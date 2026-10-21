# Fixes Applied — P0 Execution Reliability & Verification Repair

## Fix 1 (P0-A) — scope VERIFY's build/test/lint/typecheck to the workspace(s) actually touched

**Files:**
- `packages/tools/src/process-tools.ts` — `makeCheckTool` accepts `workspaces?: string[]`; when given,
  runs `npm run <script> --workspace <name> --if-present` per workspace instead of the root script.
  `--if-present` means a workspace missing that script is skipped, not treated as a failure.
- `packages/agents/src/verificationScope.ts` (new) — `resolveVerificationScope(projectRoot,
  changedFiles)` maps changed files to the workspace package(s) that own them, mirroring this repo's
  `packages/*`, `packages/runtimes/*`, `apps/*` workspace globs. Reports `fullScopeRequired` when any
  changed file falls outside every known workspace — the signal to fall back to a full run rather than
  silently narrow verification.
- `packages/agents/src/codingAgent.ts` VERIFY phase — computes scope from `filesChangedSet`; runs
  checks scoped when safe (not `fullScopeRequired`, at least one workspace resolved, and
  `fullVerification` not requested), otherwise the original full/unscoped run. Emits a `message` turn
  reporting the decision and justification either way.
- `packages/core/src/types/agent.ts` — new `AgentRunRequest.fullVerification?: boolean`.
- `apps/cli/src/run.ts`, `commands.ts`, `index.ts` — new `wa run --full-verify` flag threading this
  through, satisfying "preserve comprehensive verification when explicitly requested."

**Tests:** `packages/agents/tests/verificationScope.test.ts` (6, pure mapping logic),
`packages/agents/tests/codingAgent.verificationScope.test.ts` (3, wiring through a mocked runtime —
single workspace scoped, outside-workspace falls back to full, `--full-verify` forces full),
`packages/tools/tests/checkToolsScoping.test.ts` (2, against a REAL temp npm-workspace repo — confirms
the actual spawned `npm run build --workspace @fake/a --if-present` runs only that workspace's script).

**Live verification (real Gemma model, LM Studio):**
- T3: `wa run "Create a file at packages/agents/src/mathHelpers.ts containing a function that returns
  the square of an integer."` → scoped to `@wazir/agents`, build/test/typecheck **actually passed**,
  `"success": true`, 73s. First verified-successful file-mutating task in either audit session.
- T2: a task whose model wrote to a brand-new top-level directory outside every workspace correctly
  fell back to the full, unscoped run (same pre-existing Tauri/network failure as before) — the safety
  fallback working as designed, not a scoping bug.

## Fix 2 (P0-B) — fast-answer prompt hint for textual-only task contracts

**File:** `packages/agents/src/codingAgent.ts` — a per-request system-prompt addendum, added when
`taskType === 'chat'` or `mutationRequired === false`, telling the model it may respond
`{"action":"done",...}` immediately instead of producing a plan first. Reuses the EXISTING `done`
acceptance already present in the PLAN loop (`action.action === 'done'` branch) — purely a prompt
change, not a new control path, to keep risk low given the time budget.

**Deliberately not changed:** `mutationRequired`'s default for `chat`-type tasks. Tracing the existing
`skipChecks` formula (`filesChangedSet.size === 0 && (groundedResearch || mutationRequired)`, from the
prior session's P0-2 fix) showed that defaulting `mutationRequired` to `false` for chat tasks would
have broken that formula — it would stop skipping the check battery for a chat task that (correctly)
changed nothing, the opposite of the intent. Caught this via tracing before committing the change;
reverted the attempted default change and kept only the additive prompt hint.

**Tests:** `packages/agents/tests/codingAgent.fastAnswerHint.test.ts` (3) — hint present for `chat` type
and for `mutationRequired: false`, absent for ordinary `coding` tasks.

**Separately discovered, not authored this session:** `wa run --type chat` already routes to a
lightweight `wazir-step` agent (pre-existing in the codebase, previously untried in either audit
session) — single inference turn, no PLAN/VERIFY loop at all. Live: T1, 15.8s, `success: true`. This
does more for P0-B's intent than the prompt-hint fix alone, for any caller willing to pass `--type chat`.

**Live verification:** T1 above.

## P0-C — confirmed preserved

Full regression suite re-run after all changes in this session: 296/297 passed (1 pre-existing,
unrelated skip), covering every test file from both this session and the prior one (M1/P1-1 readiness
retention, repoIntegrityGuard, codingAgent no-mutation skip, executeTask answer-visibility). `npx tsc
--build packages/core packages/agents packages/tools apps/cli` clean throughout.

## Not fixed this session (tracked for follow-up)
- `wa run`'s default task type (`'coding'` when `--type` omitted) still routes a plain Q&A prompt to
  the heavier `wazir-coding` agent rather than `wazir-step`/`chat`. Changing the default was judged too
  broad a behavior change for this session's time budget.
- P0-5's Tauri/network dependency itself is unaddressed when a task's files land outside every known
  workspace (the correct, safe fallback still hits it) — only mitigated, not eliminated, by scoping.
