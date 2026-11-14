# Wazir × Qwen Code 1.0 Brain Transplant & Governed Harness² — Campaign Final Report

> **Branch:** `feat/qwen-code-brain-transplant`  
> **Hardware & Agent Workload Distribution:** ~70% Local Apple M5 Pro (TypeScript builds, Node SEA binary packaging, live Alloy 6 SAT4J verification, Vitest & 50-task deterministic benchmarks) · ~15% Antigravity specialist subagents (strict single-writer disjoint file ownership) · ~5% OpenAI Codex CLI (`gpt-6-astra` cross-vendor adversarial security & formal audit).

---

## 1. Executive Summary

Wazir previously combined enterprise-grade control-plane moats (`PolicyEngine`, OS sandboxing, `@wazir/assurance` formal verification, `SolutionSearchService`, `StrategyLearningService`, multi-provider routing) with a brittle single-action JSON-in-prompt `CodingAgent` loop that failed on everyday coding tasks when models emitted markdown fences, unescaped newlines, or slightly shifted indentation, and imposed heavy repository-wide verification runs even on simple read-only Q&A.

This campaign executed all waves (`A001`–`A100`) of the **Selective Core Brain Transplant + Polished Terminal Coding Agent + Governed Harness² Synthesis**:

1. **Unified Native Multi-Tool ReAct Core (`packages/agents/src/qwenCore/*` + `@wazir/runtimes-*` + `@wazir/tools`):**
   - Replaced the single-action JSON text loop with `WazirQwenAgent` (`Turn`, `CoreToolScheduler`, `ChatCompressionService`, `LoopDetectionService`, `ContextMemoryLoader`, `ProportionalVerifier`) running identically across all **6 Wazir `RuntimeAdapter`s** (`Ollama`, `LM Studio`, `OpenAI`, `Anthropic`, `Google`, and remote worker SSE).
   - Added Qwen-grade 3-stage exact / line-trimmed / indentation-flexible `computeSmartEdit` (`edit`), transactional `multi_edit`, batch `read_many_files`, and `todo_write` inside Wazir's realpath sandbox (`FH-A2-01`) and `SPEC_WRITE_FENCE`.
   - Retained `LegacyJsonCodingAgent` behind `WAZIR_CODING_AGENT_LOOP=legacy` for zero-risk rollback.

2. **Polished `wa` & `wazir` Terminal Coding Agent (`apps/cli/src/tui/*`, `dist/wa`, `dist/wazir`):**
   - Dual-executable (`wa` and `wazir`) interactive coding conversation with `< 2ms` bootstrap first-paint, grapheme-accurate cursor editing, `/model`, `/permissions`, `/status`, `/diff`, `/init`, `/compact`, `/undo`, `/resume`, `/fleet`, `@file` fuzzy mentions, `Ctrl+P` palette, focus-gated diff approvals, `wa doctor` `<16k` local context-window check, and Smooth Weighted Round-Robin `70/15/5` `WorkloadDistributor`.

3. **Privacy-Gated `qwen --acp` External Harness Bridge (`packages/agents/src/acp/*`):**
   - Automatic discovery of `qwen` CLI (`~/.qwen/settings.json` & `.qwen/settings.json`), normalized thought/tool/diff stream projection (`acpEventMapper.ts`), session handoff metadata, and `FH-A8-02` `checkAcpPrivacyEligibility` blocking cloud-backed ACP processes before spawn whenever `LOCAL_ONLY` or sensitive data classification applies.

4. **Governed Harness² `Propose → Probe → Compose` (`packages/evaluation/src/editors/*`, `harnessAssembler.ts`, `wa search run --compose`):**
   - Implemented `TrajectoryContrastService`, `BehavioralHarnessEditor` (Editor 1), `DomainKnowledgeEditor` (Editor 2), `HarnessAssembler` (clean-base cross-task assembly with `minEvidenceThreshold >= 3`), `UNVERIFIED_CONTRASTIVE` verdict separation, and `GovernanceFence` enforcing *"Evidence can change how the agent works, but NEVER what it may access or how it is graded."*

---

## 2. Quantitative Verification & Benchmark Results

### 2.1 Everyday Coding Reliability Benchmark (50-Task Deterministic Corpus)
- **Source:** [corpus.ts](file:///Users/wael/Code/Wazir/tests/benchmarks/simple-tasks/corpus.ts), [simpleTasksBenchmark.test.ts](file:///Users/wael/Code/Wazir/tests/benchmarks/simple-tasks/simpleTasksBenchmark.test.ts), [bench-simple-comparison.json](file:///Users/wael/Code/Wazir/reports/qwen-transplant/bench-simple-comparison.json)
- **Epistemic Label:** `mode: "deterministic-simulated-runtime"` on Apple M5 Pro (isolates agent harness protocol, fuzzy edit matching, parallel read batching, and proportional verification from stochastic LLM sampling variance).

| Metric | `LegacyJsonCodingAgent` (Baseline) | `WazirQwenAgent` (Transplanted) | Delta |
| :--- | :---: | :---: | :---: |
| **Overall Pass Rate (`ST-001`..`ST-050`)** | `30 / 50` (`60.0%`) | **`50 / 50` (`100.0%`)** | **`+40.0%`** |
| **Cat 1: Read-Only Q&A (`8` tasks)** | `0 / 8` (`0.0%`) | **`8 / 8` (`100.0%`)** | **`+100.0%`** |
| **Cat 2: 1-Line Bugfix w/ Indent Drift (`8` tasks)** | `6 / 8` (`75.0%`) | **`8 / 8` (`100.0%`)** | **`+25.0%`** |
| **Cat 3: Symbol Rename (`7` tasks)** | `7 / 7` (`100.0%`) | **`7 / 7` (`100.0%`)** | `0.0%` |
| **Cat 4: New Helper Function (`7` tasks)** | `4 / 7` (`57.1%`) | **`7 / 7` (`100.0%`)** | **`+42.9%`** |
| **Cat 5: Config / JSON Edit (`7` tasks)** | `4 / 7` (`57.1%`) | **`7 / 7` (`100.0%`)** | **`+42.9%`** |
| **Cat 6: Multi-File Read + Edit (`7` tasks)** | `5 / 7` (`71.4%`) | **`7 / 7` (`100.0%`)** | **`+28.6%`** |
| **Cat 7: Targeted Shell Check (`6` tasks)** | `4 / 6` (`66.7%`) | **`6 / 6` (`100.0%`)** | **`+33.3%`** |
| **Malformed Action Failures** | `10` | **`0`** | **`-10`** |
| **Median Turns per Task** | `4` (`mean 4.20`) | **`3` (`mean 2.84`)** | **`-1 turn` (`-32%`)** |
| **Q&A Verification Shell Spawns** | N/A | **`0`** | **Zero Q&A Tax** |

### 2.2 Formal Verification (`Q1`–`Q6` Alloy 6 Bounded Model Checking)
- **Report & Receipts:** [q1-q6-qwen-transplant-report.md](file:///Users/wael/Code/Wazir/docs/formal-hardening/reports/q1-q6-qwen-transplant-report.md), `docs/formal-hardening/results/q1..q6/receipt.json`
- **Solver:** Alloy 6 CLI (`SAT4J` temporal trace solver)
- **Outcome:** **`14/14` positive `run` witnesses `WITNESS_SAT`**, **`16/16` safety `check` assertions `NO_COUNTEREXAMPLE_IN_SCOPE`**, and **`10/10` negative-control mutant `check` assertions `COUNTEREXAMPLE_FOUND`**.

### 2.3 Cross-Vendor Audit & Red-Team Remediations Resolved Before Merge
1. **Codex (`gpt-6-astra`) Audit Findings Fixed (`packages/evaluation/src/editors/governanceFence.ts`, `harnessAssembler.ts`, `q4-compose-governance.als`):**
   - Blocked inline interpreter writes (`node -e`, `python -c`, `fs.writeFileSync`) targeting `specs/` or governance paths.
   - Blocked whole-file `write_file` overwrites of unexempted test files and tautological assertion replacements (`expect(true).toBe(true)`).
   - Canonicalized dot-segment paths (`config/./oracle.json`) via `path.posix.normalize`.
   - Enforced monotonic `Math.max` floor on `HarnessAssembler.assemble` `minEvidenceThreshold` and `minConfidence`.
   - Added stateful `lastOraclePassed` tracking to `q4-compose-governance.als` and verified mutant detection in SAT4J.
2. **Red-Team Specialist Findings Fixed (`paths.ts`, `projectInstructions.ts`, `policyEngine.ts`, `chatCompressionService.ts`):**
   - Fixed root-level dotfile (`.env.example`) atomic temp-file false `PathEscapeError` in `isInside()` (`rel !== '..' && !rel.startsWith('..' + path.sep)`).
   - Hardened `loadProjectInstructions` with `lstatSync` symlink rejection, `realpathSync` containment, `.qwen/QWEN.md` discovery, and `</project_instructions>` XML tag escaping.
   - Added `isRealpathInsideProject` to Layer 1 `PolicyEngine.doClassify` so symlinks escaping `projectRoot` are denied before reaching Layer 2.
   - Escaped XML delimiters inside `<state_snapshot>` fields in `ChatCompressionService`.
