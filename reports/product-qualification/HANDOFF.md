# Wazir Engineering Handoff Runbook

**Orchestrator:** Google Antigravity  
**Consolidated Candidate Branch:** `qualification/release-candidate`  
**Candidate Commit SHA:** `4f86340cc82cbb8b19e9cb3045cc4f282e5a01dc`  
**Base Baseline Commit:** `2f052144983f0d1848b8d9be277c01eb44a77bb3`  
**Target Release Version:** `v0.2.15`  
**Date:** 2026-10-28  

---

## 1. Overview & Handoff Purpose

This document provides complete operational instructions for release engineers and maintainers to inspect, verify, merge, tag, and publish the Wazir v0.2.15 release candidate produced by the autonomous 20-agent qualification mission.

The candidate branch `qualification/release-candidate` contains all remediations and verification tests. It has passed all 5 qualification suites with zero regressions, zero test failures, and zero P0/P1 defects remaining.

---

## 2. Release Candidate Verification Checklist

Before publishing, any engineer can reproduce and independently verify the qualification results with the following commands executed from the candidate directory or worktree:

```bash
# 1. Switch to release candidate
git checkout qualification/release-candidate

# 2. Verify all unit and targeted regression tests
npx vitest run packages/core/tests/policyEngineShell.test.ts \
  apps/api/tests/p0Remediation.test.ts \
  packages/evaluation/tests/roadmapV02.test.ts \
  apps/cli/tests/contextAllocationRuntime.test.ts \
  apps/api/tests/control.goalStudioRoutes.test.ts \
  apps/api/tests/prompts.goalStudioRoutes.test.ts \
  apps/cli/tests/tuiGoalStudioPerformance.test.ts \
  tests/live/realWorldAcceptance.test.ts

# 3. Verify the agent test suite (12 files, 268 tests)
npx vitest run packages/agents/tests/codingAgent.turnTimeout.test.ts \
  packages/agents/tests/codingAgent.proseBailout.test.ts \
  packages/agents/tests/codingAgent.circuitBreaker.test.ts \
  packages/agents/tests/codingAgent.contextCompaction.test.ts \
  packages/agents/tests/codingAgent.maxTurns.test.ts \
  packages/agents/tests/parseAction.test.ts \
  packages/core/tests/jobOrchestrator.test.ts \
  packages/core/tests/jobLifecycleAndValidation.test.ts \
  packages/core/tests/policyEngineShell.test.ts \
  packages/core/tests/policyEngineHardening.test.ts \
  packages/tools/tests/sandbox.test.ts \
  apps/cli/tests/fleetTui.test.ts

# 4. Verify the foundational acceptance sequence
node scripts/acceptance-test-harness.mjs --foundational

# 5. Run the release gate
node scripts/release-gate.mjs

# 6. Run complete distribution and packaging verification
node scripts/release-verify.mjs
```

---

## 3. Merge & Release Deployment Procedure

### Step 3.1: Merge Candidate to `main`
The candidate was developed in complete isolation without touching or overwriting `main`. To integrate into `main`:

```bash
# Switch to main branch
git checkout main

# Merge candidate branch with signed/annotated commit
git merge --no-ff qualification/release-candidate -m "chore(release): merge qualification candidate v0.2.15"

# Verify HEAD matches expected tree
git log -n 1
```

### Step 3.2: Create and Push Annotated Tag
```bash
git tag -a v0.2.15 -m "Release v0.2.15: Product Qualified by Antigravity 20-Agent Fleet"
git push origin main --tags
```

### Step 3.3: Publish Distribution Artifacts
Run the production build and publishing script:
```bash
# Build standalone bundle and tarball
npm run build
npm run bundle
npm pack

# Publish to npm registry (with 2FA / provenance)
npm publish wazir-0.2.15.tgz --access public
```

---

## 4. Agent Worktree Cleanup Procedure

All 20 subagent worktrees (`codex-01..10`, `claude-01..10`) and the release candidate worktree are currently preserved under `.wazir-agent-worktrees/`. Their logs and execution receipts have been copied into `reports/product-qualification/`.

Once the release tag is finalized, clean up the worktrees with:

```bash
# Remove all agent worktrees
git worktree remove --force .wazir-agent-worktrees/codex-01
git worktree remove --force .wazir-agent-worktrees/codex-02
git worktree remove --force .wazir-agent-worktrees/codex-03
git worktree remove --force .wazir-agent-worktrees/codex-04
git worktree remove --force .wazir-agent-worktrees/codex-05
git worktree remove --force .wazir-agent-worktrees/codex-06
git worktree remove --force .wazir-agent-worktrees/codex-07
git worktree remove --force .wazir-agent-worktrees/codex-08
git worktree remove --force .wazir-agent-worktrees/codex-09
git worktree remove --force .wazir-agent-worktrees/codex-10
git worktree remove --force .wazir-agent-worktrees/claude-01
git worktree remove --force .wazir-agent-worktrees/claude-02
git worktree remove --force .wazir-agent-worktrees/claude-03
git worktree remove --force .wazir-agent-worktrees/claude-04
git worktree remove --force .wazir-agent-worktrees/claude-05
git worktree remove --force .wazir-agent-worktrees/claude-06
git worktree remove --force .wazir-agent-worktrees/claude-07
git worktree remove --force .wazir-agent-worktrees/claude-08
git worktree remove --force .wazir-agent-worktrees/claude-09
git worktree remove --force .wazir-agent-worktrees/claude-10
git worktree remove --force .wazir-agent-worktrees/release-candidate

# Prune git worktree administrative metadata
git worktree prune
```

---

## 5. Ongoing Monitoring & Operations Recommendations

1. **CLI Startup Latency:** Keep imports inside CLI entry points lazy. Do not reintroduce eager imports of database or heavy core services into fast-path commands (`table.ts`, `doctor.ts`).
2. **PolicyEngine Subshell Defenses:** If new shell interpreters are supported (e.g. `fish`, `powershell`), ensure AST parsers inspect arguments recursively before evaluation.
3. **API Route Registration:** Enforce that any newly created API route definition is immediately accompanied by an entry in `apps/api/tests/p0Remediation.test.ts`.
4. **PostgreSQL Integration Testing:** In environments with live PostgreSQL instances, set `DATABASE_URL` to enable full dialect testing in `claude-07`'s persistence suite.
