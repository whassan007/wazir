# Self-improvement recovery — live operational report

Updated 2026-10-15T07:33:32.119430+00:00. **IN PROGRESS; no implementation phase has been accepted.**

## Preserved state

Primary checkout: `release/v0.1.64`; candidate: `feat/native-continuous-self-improvement`. Both began at `d0bd587b8e6b5ee840dbac2bb30fdd1a32051730`. Current candidate HEAD: `d0bd587b8e6b5ee840dbac2bb30fdd1a32051730`.

Private, durable checkpoint (source archive includes tracked and untracked files, binary patches, inventory, original builder configuration/state/prompts/unit, SHA256SUMS):
`/home/wael/.local/state/wazir-self-improvement-builder/recovery-checkpoints/20261015T071318Z`.
Original working copy archive also remains at `/tmp/wazir-recovery-20261015T071318Z`.

The primary checkout has separate uncommitted dashboard/resource work and was not edited by recovery. Candidate initial changes: commands.ts, index.ts, evaluation index.ts, metaOptimizerService.ts; untracked improvementRepair.ts, improvementSupervisor.ts, selfImprovementSupervisor.ts, self-improvement-builder.sh. Preserved all. The failed execution reports workspace revision 0 and no changed files; candidate supervisor files have modification times around 23:13–23:16 PDT, later than the failure at 21:29 PDT. They cannot be attributed to that failed run. Exact authorship and chronology before the checkpoint are not established by Git; no unsupported claim of provenance is made.

## Failure and repairs

Original `exec-mv91b9as-1` failed Phase 1 with `NO_PROGRESS`; 52 model requests, 44 tool calls (18 failed), 644,375 tokens (635,187 input; 9,188 output), no changed files, no checks. Initial Nemotron escalated to Qwen2.5 7B. Unknown tools were correctly denied. Supporting evidence: archived build.log and `wa executions inspect exec-mv91b9as-1`.

Defects in the coding controller: native function schemas were combined with mandatory legacy text JSON instructions; the text prompt exposed the unfiltered phase-independent tool list, schemas were truncated; parsed actions bypassed the compiled surface; normalization/unsupported-tool failures did not share a bounded per-model incompatibility counter. Distinct unavailable tools could alternate until generic no-progress detection. Fixed prompt/schema agreement at every model invocation, full schemas, native/legacy continuation instructions, compiled-surface enforcement before dispatch, three-rejection bound with actionable diagnostics and existing bounded escalation. Legacy compatibility remains; unknown tools are never registered to satisfy hallucinations. Host policy remains authoritative for arguments and permissions.

Fixed an existing TypeScript syntax error in improvementRepair.ts. The newer candidate builder had never been installed. Installed its locking/atomic state/bounded timeout support, repaired resume to start the existing service without regenerating prompts/configuration/logs, selected the candidate-built CLI, required runtime compatibility evidence, preserved BLOCKED vs interrupted vs failed diagnostics, and required an independent phase acceptance receipt plus clean committed code and executed build/tests. No phase is accepted merely from a successful coding subprocess.

## Runtime selection and resource evidence

Host: Linux aarch64, NVIDIA GB10, 122 GiB unified memory; about 16 GiB available during discovery. User systemd lingering already enabled; no security setting changed. LM Studio reachable; Ollama executable installed but endpoint unavailable and no models discovered. Eleven LM Studio model entries; loaded: Nemotron Nano Omni (32768 context), Qwen3 Coder Next (32768), Qwen2.5 7B (8192). Did not unload shared models or allocate additional large models.

Codex CLI 0.162.1 and Claude Code 2.1.300 installed. Existing external preflight cache was stale/inconsistent with current binaries. Wazir ledger reports unknown subscription quota limits, governance `enforce=false`, paid API fallback disabled. No external coding execution authorized by configured finite subscription budgets was established, so none was dispatched. Local generation passes through the existing resource router/ledger; no credential contents were read or copied into this report. OpenAI configuration reference consulted via the OpenAI Docs skill: https://developers.openai.com/codex/config-reference .

Qwen3 Coder Next: **REJECTED** for builder, execution `exec-mv97qchi-1`. Read fixture files, repeatedly requested unavailable `run`, stopped after three incompatible calls, source unchanged, independent test failed, oracle unchanged.

Nemotron Nano Omni: **PASS for the small coding compatibility task only**, execution `exec-mv97vbx5-1`. Read source/test; reproduced failure, edited subtraction to addition, executed build/test, Wazir exit 0; independent test changed from exit 1 to exit 0 and oracle bytes unchanged. Optional lint/typecheck scripts were absent and are not counted as passed. Evidence under `/home/wael/.local/state/wazir-self-improvement-builder/recovery-evidence/wazir-coding-smoke-1792049271`. Harness logs were inside the disposable workspace and appear in its changed-file list; this is harness output, not a model source edit. The actual changed source and immutable oracle were checked separately.

## Verification and phase outcomes

- Candidate `npm run build`: PASS after syntax repair. Node 22.22.3 must be on PATH.
- Initial protocol regression set: 11/11 PASS. Full agent suite initially 205 PASS / 3 FAIL; fixed native fixture setup and retained phase-denial diagnostic, rerun pending.
- Evaluation/improve baseline suite: **109 PASS / 12 FAIL**, 15 test files. Full log retained at `/home/wael/.local/state/wazir-self-improvement-builder/recovery-evidence/wazir-recovery-evaluation-tests.log`. Failures include legacy implicit promotion expectations and qualification without physical workspace/oracles. These remain unresolved; no weakening of assertions or PASS claim.
- Phase 1: UNACCEPTED. Integrity changes partial; real config execution adapter and comprehensive regression fixes still required.
- Phase 2: UNACCEPTED. Supervisor/CLI partial; lifecycle and process/service qualification required.
- Phase 3: UNACCEPTED. Optimization adapter explicitly unavailable; learning/evolution integration incomplete.
- Phase 4: UNACCEPTED. Small model tool compatibility established; complete real supervised repair and service/restart qualification remain.

## Recovery operations

Builder: `bash ~/.local/share/wazir-self-improvement-builder/builder.sh resume`.
Status: `bash ~/.local/share/wazir-self-improvement-builder/builder.sh status`.
Logs: `bash ~/.local/share/wazir-self-improvement-builder/builder.sh logs --follow`.
Stop: `bash ~/.local/share/wazir-self-improvement-builder/builder.sh stop`.

Resume preserves the original prompts under `~/.local/share/wazir-self-improvement-builder/prompts/`. The builder runs under the existing systemd user unit, with an OS flock and KillMode=control-group. It does not enable a new service, merge, push, deploy, discard source, or automatically replay a mutating failure. Runtime failures without workspace changes have at most three attempts; protocol failures stop immediately. Original failed execution remains immutable; a resumed phase creates a new execution ID recorded in its durable attempt log. Checkpoint records name the phase, attempt, starting SHA, log and state. Heartbeats are visibility only.

After an implemented phase passes checks, the recovery supervisor must independently review every original requirement and write `~/.local/state/wazir-self-improvement-builder/review-N.json` with phase, exact head, promptSha256, decision PASS, reviewer recovery-supervisor, and requirement-by-requirement PASS/evidence artifact paths. Resume then reruns verification without replaying the coding task. Never create this receipt for incomplete requirements. The future native supervisor is not yet qualified for unattended operation.

No protected branch merge, push, deployment or destructive Git command occurred. Resource usage is measurable per execution using `wa executions inspect ID`; dollar cost for local inference is recorded as zero, not a measurement of electricity or hardware cost.
