# A27 — Multi-Agent Workspace Conflict & Concurrency Regression Report

- **Agent ID**: A27 (Tier 2 — Multi-Agent Conflict & Concurrency Regression Engineer)
- **Program**: Wazir 30-Agent Cost-Optimized Formal Hardening Program
- **Group**: GROUP I (P1) — Multi-Agent Workspace Isolation & Conflict Detection
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh30/A27`
- **Git Branch**: `fh30/A27`
- **Commit SHA**: `4c1c340`
- **Formal Toolchain**: Alloy 6.2.0 CLI (`org.alloytools.alloy.dist.jar`), Java OpenJDK 21.0.12.1 (SAT4J solver)
- **Model Files**:
  - Reference Specification: [`tests/formal-hardening/models/a27-workspace-conflict.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a27-workspace-conflict.als)
  - Negative Control Mutant: [`tests/formal-hardening/models/a27-workspace-conflict-mutant.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a27-workspace-conflict-mutant.als)
- **Log Directories**:
  - Baseline Logs: [`tests/formal-hardening/logs/alloy-a27-workspace`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a27-workspace)
  - Mutant Logs: [`tests/formal-hardening/logs/alloy-a27-workspace-mutant`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a27-workspace-mutant)
- **Test Suite**:
  - Group I Test Suite: [`packages/core/tests/formalHardeningGroupI.test.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh30/A27/packages/core/tests/formalHardeningGroupI.test.ts)

---

## 1. Executive Summary & Critical Invariant

In multi-agent collaborative execution systems where parallel agents operate on isolated worktrees and integrate into a shared codebase, concurrency bugs risk silent data destruction. A subtle but catastrophic flaw occurs when an agent operates against an older workspace revision (stale snapshot) and integrates its work after concurrent changes have landed on the target branch. Without rigorous conflict detection against the target branch's evolved state, the stale agent will silently clobber prior verified work.

### The Critical Invariant (P1)
> **"One agent must not silently overwrite another agent's confirmed work."**

Formally expressed over all system states:
$$\forall a \in \text{Agent}.\; \left( \text{status}(a) = \text{Completed} \land \text{status}'(a) = \text{Integrated} \right) \implies \left( a \notin \text{flaggedConflicts} \land \forall f \in \text{modifiedFiles}(a).\; \text{Target.fileRev}[f] = \text{baseRev}(a) \right)$$

And for concurrent agents $a_1 \neq a_2$ modifying common files:
$$\forall a_1 \neq a_2 \in \text{Agent}, f \in \text{File}.\; \left( \text{status}(a_1) = \text{Integrated} \land \text{status}(a_2) = \text{Integrated} \land f \in \left(\text{modifiedFiles}(a_1) \cap \text{modifiedFiles}(a_2)\right) \right) \implies \text{flaggedConflicts} \neq \emptyset$$

---

## 2. Alloy 6 Formal Verification

### 2.1 Formal Models Developed
Two Alloy 6 temporal logic models were authored in `tests/formal-hardening/models/`:
1. **Sound Reference Model (`a27-workspace-conflict.als`)**:
   - Models concurrent agents (`AgentA`, `AgentB`), files (`File1`, `File2`), revisions (`R0` through `R3`), agent lifecycles (`Idle -> Working -> Completed -> Integrated / Conflicted`), a coordinator, and a target branch.
   - Comprehensive conflict detection checks **both**:
     1. Candidate-to-candidate file overlap among pending candidates.
     2. Candidate-to-target file overlap against files modified on target since the candidate's base revision (`Target.fileRev[f] != a.baseRev`).
2. **Negative-Control Mutant (`a27-workspace-conflict-mutant.als`)**:
   - Intentionally relaxes conflict detection to last-writer-wins by checking only candidate-to-candidate overlap among unintegrated candidates, completely omitting candidate-to-target stale base checks.

### 2.2 Invariants Checked
- **`NoStaleBaseIntegration`**: An agent can never transition to `Integrated` if the target branch modified any of the agent's touched files since its base revision.
- **`NoSilentLostUpdate`**: An agent never integrates without conflict detection if its files moved on target or conflict was flagged.
- **`ConflictedAgentNeverIntegrates`**: An agent flagged as conflicted can never transition to `Integrated`.
- **`SameFileConflictDetected`**: Two concurrent agents modifying overlapping files cannot both integrate without conflict detection.
- **`WorkspaceIsolation`**: While an agent works in its worktree, other agents' transitions do not alter its private modifications or base revision.

### 2.3 Verification Execution & Results

```bash
# Sound Model Verification
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a27-workspace \
  /Users/wael/Code/Wazir/tests/formal-hardening/models/a27-workspace-conflict.als

# Negative Control Mutant Verification
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a27-workspace-mutant \
  /Users/wael/Code/Wazir/tests/formal-hardening/models/a27-workspace-conflict-mutant.als
```

#### Verification Summary Table

| Command / Check | Type | Sound Specification (`a27-workspace-conflict.als`) | Defective Mutant (`a27-workspace-conflict-mutant.als`) | Status |
|---|---|---|---|---|
| `BothIntegratedDisjoint` | Run (Witness) | **SAT** (10 steps) | **SAT** (10 steps) | Sound non-vacuous witness |
| `ConflictDetected` | Run (Witness) | **SAT** (10 steps) | **SAT** (10 steps) | Sound non-vacuous witness |
| `NoStaleBaseIntegration` | Check | **UNSAT** (0 counterexamples) | **SAT (Counterexample Found)** | Proven defective without target check |
| `NoSilentLostUpdate` | Check | **UNSAT** (0 counterexamples) | **SAT (Counterexample Found)** | Proven defective without target check |
| `ConflictedAgentNeverIntegrates` | Check | **UNSAT** (0 counterexamples) | **UNSAT** (Holds) | Monotone conflict property holds |
| `SameFileConflictDetected` | Check | **UNSAT** (0 counterexamples) | **SAT (Counterexample Found)** | Overlapping files clobbered silently |
| `WorkspaceIsolation` | Check | **UNSAT** (0 counterexamples) | **UNSAT** (Holds) | Independent worktree isolation holds |

The Alloy mutant counterexample produced a concrete 10-step temporal trace:
1. `Target` initialized at revision $R_0$.
2. `AgentA` branches from $R_0$, modifies $File_1$, and completes.
3. `AgentB` branches from $R_0$, modifies $File_1$, and completes.
4. `AgentA` integrates into `Target`. `Target.head` advances to $R_1$, updating $File_1 \mapsto R_1$.
5. In the defective mutant, `AgentB` only checked unintegrated candidate-candidate overlap. Since `AgentA` was already `Integrated`, `AgentB` detected no conflict.
6. `AgentB` integrated at step 8, updating $File_1 \mapsto R_2$, silently overwriting `AgentA`'s confirmed work on Target!

---

## 3. Production Code Audit & Defect Rectification

### 3.1 Defect 1: Stale Base Collision Omission in `VerifiedIntegrationCoordinator.plan`
- **File**: [`packages/core/src/services/verifiedIntegrationCoordinator.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh30/A27/packages/core/src/services/verifiedIntegrationCoordinator.ts)
- **Root Cause**: `plan()` only evaluated candidate-to-candidate pairwise intersections (`valid[i]` vs `valid[j]`). When a candidate branched from an older base revision (`candidate.manifest.baseSha !== targetSha`), `targetAdvanced` was identified in code, but the candidate was never checked against target modifications! As a result, `conflicts` was empty `[]`, `readyToBuildCandidate` was `true`, and the stale candidate proceeded toward integration.
- **Fix**: Added target branch diff inspection for all `targetAdvanced` candidates:
  1. Compares candidate changes against `listFileChanges(repository, candidate.manifest.baseSha, targetSha)`.
  2. Executes `git merge-tree --write-tree targetSha candidate.manifest.headSha` to determine syntactic clean/conflict status.
  3. Registers `IntegrationConflict` between `targetBranch` and `candidate.branch` (`same-file`, `dependency`, `test-fixture`, or `git-merge`).
  4. Updated `analyzeConflict` to support `isTarget` participants.

### 3.2 Defect 2: Race Condition in `WorktreeManager.getOrCreateJobWorktree`
- **File**: [`packages/core/src/services/worktreeManager.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh30/A27/packages/core/src/services/worktreeManager.ts)
- **Root Cause**: When multiple tasks in the same job start concurrently (e.g. `Promise.all`), both saw `this.jobWorktrees.get(jobId)` as undefined and concurrently executed `git worktree add`, crashing with `fatal: '...' already exists`.
- **Fix**: Implemented `inFlightJobWorktrees: Map<string, Promise<WorktreeInfo>>` deduplication pattern so concurrent callers await the single in-flight worktree creation. Added cleanup in `removeWorktree`.

### 3.3 Defect 3: Incomplete Unmerged Conflict Detection in `WorktreeManager.mergeBranch`
- **File**: [`packages/core/src/services/worktreeManager.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh30/A27/packages/core/src/services/worktreeManager.ts)
- **Root Cause**: Porcelain status filtering only checked `UU`, `AA`, `UD`, missing other standard Git conflict states such as `DU` (deleted on target, modified on branch), `DD`, `AU`, and `UA`.
- **Fix**: Expanded prefix filter to all 7 standard Git unmerged conflict codes: `['UU', 'AA', 'UD', 'DU', 'DD', 'AU', 'UA']`.

### 3.4 Defect 4: Fan-Out Context Propagation & Shared-Reference Mutation in `JobOrchestrator`
- **File**: [`packages/core/src/services/jobOrchestrator.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh30/A27/packages/core/src/services/jobOrchestrator.ts)
- **Root Cause**: In concurrent task dispatch, `node` and `task` references were passed directly to `executor(task, executionContext)` without defensive cloning. If one branch mutated `task.input`, `task.requirements`, or `context.node`, the mutation contaminated the job graph and sibling tasks. Additionally, context propagation only considered direct `node.dependencies`, ignoring `task.contextFrom`.
- **Fix**:
  1. Wrapped `node` in `structuredClone(node)` for `executionContext.node`.
  2. Wrapped `task` in `structuredClone(task)` for `executor(task, ...)` and cloned `task.policy`.
  3. Propagated upstream outcomes to `previousOutcomes` for tasks matching `node.dependencies` OR `task.contextFrom`.

---

## 4. Vitest Deterministic Regression Suite

A new dedicated Vitest suite was implemented at [`packages/core/tests/formalHardeningGroupI.test.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh30/A27/packages/core/tests/formalHardeningGroupI.test.ts).

### Test Coverage Breakdown

#### 1. Conflicting file edits across 2 agents
- `detects same-file collision when 2 concurrent agents modify overlapping files`: Confirms that two concurrent agents modifying `src/config.ts` are flagged with a `same-file` syntactic conflict and `readyToBuildCandidate: false`.
- `allows disjoint file edits across 2 agents to plan cleanly`: Confirms that concurrent agents touching disjoint files (`src/moduleA.ts` and `src/moduleB.ts`) produce 0 conflicts and `readyToBuildCandidate: true`.

#### 2. Stale snapshot rejection
- `rejects integration candidate based on stale snapshot when target modified the same file`: An agent branched at $C_0$ touching `src/routes.ts` is evaluated against target after target advanced to $C_1$ touching `src/routes.ts`. Verifies `staleBase: true`, same-file conflict detected, and integration blocked.
- `rejects qualification if target branch moved during verification execution`: Verifies fail-closed behavior when target HEAD moves between plan and qualification.

#### 3. Delayed agent completion
- `prevents delayed agent from silently overwriting confirmed work of fast agent`: Fast Agent merges first, advancing `main` with confirmed changes in `schema.sql`. Slow Agent completes after delay from initial base commit. Coordinator flags same-file conflict and preserves `main` without overwrite.

#### 4. Isolated fan-out context propagation
- `isolates task inputs, node state, and execution context across concurrent fan-out tasks`: Fan-out task 1 attempts in-place mutation of `task.input`, `task.requirements.capabilities`, and `ctx.node.dependencies`. Sibling tasks (fan-out 2 and 3) observe uncorrupted original inputs and clean node dependencies.
- `isolates upstream dependency outcomes across fan-out sibling tasks (no object mutation leak)`: Mutator branch modifies received upstream outcome object; reader branch reads pristine original data without reference leak.
- `propagates context specified via contextFrom cleanly to previousOutcomes`: Verifies that `contextFrom` references are resolved and delivered into `ctx.previousOutcomes`.
- `isolates per-task steering instructions without cross-task leakage`: Verifies that `orchestrator.steerTask` delivers instructions strictly to the targeted task.

### Test Execution Results

```text
 ✓ packages/core/tests/formalHardeningGroupI.test.ts (9) 3599ms
   ✓ Formal Hardening Group I — Multi-Agent Conflict, Concurrency & Context Isolation (A27) (9) 3599ms
     ✓ 1. Conflicting file edits across 2 agents (2) 1429ms
       ✓ detects same-file collision when 2 concurrent agents modify overlapping files 719ms
       ✓ allows disjoint file edits across 2 agents to plan cleanly 709ms
     ✓ 2. Stale snapshot rejection (2) 913ms
       ✓ rejects integration candidate based on stale snapshot when target modified the same file 565ms
       ✓ rejects qualification if target branch moved during verification execution 348ms
     ✓ 3. Delayed agent completion (1) 1133ms
       ✓ prevents delayed agent from silently overwriting confirmed work of fast agent 1133ms
     ✓ 4. Isolated fan-out context propagation (4)
       ✓ isolates task inputs, node state, and execution context across concurrent fan-out tasks
       ✓ isolates upstream dependency outcomes across fan-out sibling tasks (no object mutation leak)
       ✓ propagates context specified via contextFrom cleanly to previousOutcomes
       ✓ isolates per-task steering instructions without cross-task leakage

Test Files  1 passed (1)
     Tests  9 passed (9)
  Duration  5.51s
```

All 53 tests in the core multi-agent and orchestration suite pass cleanly:
```text
Test Files  4 passed (4)
     Tests  53 passed (53)
```

TypeScript compilation:
```bash
cd packages/core && npm run build
# tsc --build: exited with code 0
```

---

## 5. Artifacts & Deliverables Summary

1. **Alloy Models**:
   - `tests/formal-hardening/models/a27-workspace-conflict.als`
   - `tests/formal-hardening/models/a27-workspace-conflict-mutant.als`
2. **Alloy Verification Logs & Receipts**:
   - `tests/formal-hardening/logs/alloy-a27-workspace/receipt.json`
   - `tests/formal-hardening/logs/alloy-a27-workspace/BothIntegratedDisjoint-solution-0.txt`
   - `tests/formal-hardening/logs/alloy-a27-workspace/ConflictDetected-solution-0.txt`
   - `tests/formal-hardening/logs/alloy-a27-workspace-mutant/receipt.json`
   - `tests/formal-hardening/logs/alloy-a27-workspace-mutant/NoStaleBaseIntegration-solution-0.txt`
   - `tests/formal-hardening/logs/alloy-a27-workspace-mutant/NoSilentLostUpdate-solution-0.txt`
   - `tests/formal-hardening/logs/alloy-a27-workspace-mutant/SameFileConflictDetected-solution-0.txt`
3. **Vitest Regression Test Suite**:
   - `packages/core/tests/formalHardeningGroupI.test.ts`
4. **Git Commit**:
   - Branch: `fh30/A27`
   - Commit: `4c1c340` (`feat(fh30-a27): resolve multi-agent conflict detection, worktree concurrency, and fan-out context isolation`)
