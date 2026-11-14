# Qwen Code Upstream Maintenance & Sync Playbook

Wazir adopts a **Selective Core Transplant + Optional ACP Bridge** architecture rather than a monolithic fork of `QwenLM/qwen-code` (Apache-2.0). This preserves Wazir's multi-provider runtime fabric, formal assurance (`@wazir/assurance`), governed `PolicyEngine`, and low-flicker terminal UI while keeping everyday ReAct tool reliability synchronized with upstream Qwen Code improvements.

## 1. Architecture Boundary (`docs/qwen-transplant/UPSTREAM_LOCK.json`)

| Layer | Wazir Location | Sync Mode | Invariant Gate |
| :--- | :--- | :--- | :--- |
| **Core ReAct Turn & Scheduler** | `packages/agents/src/qwenCore/*` | Selective TypeScript port | Must run identically across all 6 `@wazir/runtimes-*` adapters (`qwenCore.test.ts` + `q1-parallel-policy.als`). |
| **Smart Edit & Batch Read Tools** | `packages/tools/src/{editMatcher,multiEdit,readManyFiles,todoTool}.ts` | Selective TypeScript port | Must enforce realpath workspace containment (`FH-A2-01`) and `SPEC_WRITE_FENCE` (`q2-edit-sandbox.als`). |
| **External `qwen --acp` Harness** | `packages/agents/src/acp/*` | Zero-fork stdio protocol (`--acp`) | Must pass `checkAcpPrivacyEligibility` (`FH-A8-02`, `q6-privacy-routing.als`) before process spawn. |
| **Governed Harness² Synthesis** | `packages/evaluation/src/editors/*`, `packages/core/src/services/harnessAssembler.ts` | Native Wazir subsystem | Must pass `GovernanceFence` (`q4-compose-governance.als`): *evidence changes how the agent works, never what it may access*. |

## 2. Quarterly / Release Upstream Sync Procedure

1. **Inspect Upstream Diffs Only in Mapped Modules:**
   - Compare upstream `packages/core/src/core/{turn,coreToolScheduler,client}.ts`, `packages/core/src/services/{chatCompressionService,loopDetectionService}.ts`, and `packages/core/src/tools/{edit,read-many-files}.ts` against the entries in [UPSTREAM_LOCK.json](file:///Users/wael/Code/Wazir/docs/qwen-transplant/UPSTREAM_LOCK.json).
   - Never import DashScope-coupled auth, telemetry, or Ink UI packages.

2. **Port & Validate Against Formal + Red-Team Gates:**
   - Apply targeted improvements to `packages/agents/src/qwenCore/*` or `packages/tools/src/*`.
   - Re-run Alloy 6 bounded checks (`q1`–`q6`):
     ```bash
     for m in q1-parallel-policy q2-edit-sandbox q3-proportional-verify q4-compose-governance q5-batch-recovery q6-privacy-routing; do
       ./tools/java/bin/java -jar ./tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -o docs/formal-hardening/results/$m docs/formal-hardening/models/$m.als
     done
     ```
   - Run the security & 50-task reliability suites:
     ```bash
     npx vitest run packages/agents/ packages/tools/ packages/evaluation/ tests/security/ tests/benchmarks/simple-tasks/ --exclude '.fa/**'
     ```

3. **Verify `qwen --acp` Wire Compatibility:**
   - Probe installed `qwen` CLI compatibility via `wa doctor` and `npx vitest run packages/agents/tests/qwenAcpDefaultBridge.test.ts --exclude '.fa/**'`.
   - Update `UPSTREAM_LOCK.json` `lockedAt` and `upstreamReferenceRelease` once all checks pass.
