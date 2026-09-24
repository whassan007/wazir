import type { RookEngine } from './engine.js';
import { color } from './colors.js';
import type {
  SolutionSearchRequest,
  SolutionSearchResult,
  SearchStrategyKind,
  CandidateResult,
} from '@wazir/core';
import { executeTask } from './run.js';

export interface SearchRunOptions {
  candidates?: number;
  strategy?: SearchStrategyKind;
  maxParallel?: number;
  timeoutMs?: number;
  autoPromote?: boolean;
  model?: string;
  agent?: string;
  json?: boolean;
}

export async function searchRunCommand(
  engine: RookEngine,
  taskDescription: string,
  options: SearchRunOptions = {},
): Promise<string> {
  const jsonMode = Boolean(options.json);

  try {
    // 1. Ensure baseline execution exists
    await engine.executions.ready;
    const baseRecord = await engine.executions.create({
      task: {
        id: `task-search-base`,
        type: 'coding',
        input: taskDescription,
        requirements: {},
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'local-rt',
      modelId: options.model ?? 'default',
      workspaceRoot: engine.projectRoot,
    });

    const candidateCount = options.candidates ?? 3;
    const strategy = options.strategy ?? 'same_model_diverse';

    const request: SolutionSearchRequest = {
      executionId: baseRecord.execution.id,
      objective: taskDescription,
      candidates: candidateCount,
      strategy,
      maxParallelCandidates: options.maxParallel ?? 2,
      candidateBudget: {
        timeoutMs: options.timeoutMs ?? 180_000,
      },
      autoPromote: options.autoPromote ?? false,
      projectRoot: engine.projectRoot,
    };

    const result = await engine.solutionSearch.search(request, async (ctx) => {
      // Execute each candidate trajectory using standard Wazir execution in its isolated worktree
      const subEngine = {
        ...engine,
        projectRoot: ctx.worktreePath,
      };

      const outcome = await executeTask(subEngine as any, `${taskDescription} [${ctx.descriptor.promptModifier ?? ''}]`, {
        model: ctx.descriptor.modelId ?? options.model,
        agent: ctx.descriptor.agentId ?? options.agent,
        quiet: true,
      });

      const rec = await engine.executions.get(outcome.executionId);
      if (!rec) {
        throw new Error(`Execution record ${outcome.executionId} not found`);
      }
      return rec;
    });

    if (jsonMode) {
      return JSON.stringify(result, null, 2);
    }

    const lines = [
      color.bold(`=== Solution Search: ${result.searchId} ===`),
      `Objective: ${taskDescription}`,
      `Strategy: ${result.strategy} | Status: ${result.status}`,
      `Candidates: ${result.totalCandidates} | Qualifying: ${result.qualifyingCandidates.length}`,
      `Wall Time: ${result.wallTimeMs}ms | Total Tokens: ${result.totalTokens}`,
      '',
      color.bold('Candidates:'),
      ...result.candidates.map((c) => {
        const qTag = c.evaluation?.qualifies ? color.green('QUALIFIED') : color.red('DISQUALIFIED');
        const status = c.status === 'completed' ? color.green(c.status) : color.yellow(c.status);
        return `  [${c.candidateId}] ${c.descriptor.name} - ${status} (${qTag})\n` +
          `    checks: ${c.checks.length} | evidence: ${c.evidence.length} | time: ${c.durationMs ?? 0}ms\n` +
          (c.evaluation?.disqualificationReasons?.length ? `    reasons: ${c.evaluation.disqualificationReasons.join(', ')}\n` : '');
      }),
      '',
      color.bold('Selection Decision:'),
      `  ${result.selectionReason}`,
    ];

    if (result.selectedCandidate) {
      lines.push('');
      lines.push(color.green(`✓ Selected Candidate: ${result.selectedCandidate.candidateId}`));
      if (result.promotionResult) {
        lines.push(`  Promoted to parent workspace: ${result.promotionResult.success ? color.green('YES (R' + result.promotionResult.promotedRevision + ')') : color.red('FAILED')}`);
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    if (jsonMode) {
      return JSON.stringify({ ok: false, error: String(err) }, null, 2);
    }
    return color.red(`Search failed: ${err.message ?? String(err)}`);
  }
}

export function searchStatusCommand(
  engine: RookEngine,
  searchId: string,
  options: { json?: boolean } = {},
): string {
  const result = engine.solutionSearch.getSearch(searchId);
  if (!result) {
    const err = { ok: false, error: `Search '${searchId}' not found` };
    return options.json ? JSON.stringify(err, null, 2) : color.red(`Search '${searchId}' not found`);
  }

  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  return [
    color.bold(`=== Search Status: ${result.searchId} ===`),
    `Status: ${result.status}`,
    `Candidates: ${result.candidates.length}/${result.totalCandidates}`,
    `Qualifying: ${result.qualifyingCandidates.length}`,
    `Selection: ${result.selectedCandidate ? result.selectedCandidate.candidateId : 'pending'}`,
    `Reason: ${result.selectionReason}`,
  ].join('\n');
}

export function searchCandidatesCommand(
  engine: RookEngine,
  searchId: string,
  options: { json?: boolean } = {},
): string {
  const result = engine.solutionSearch.getSearch(searchId);
  if (!result) {
    const err = { ok: false, error: `Search '${searchId}' not found` };
    return options.json ? JSON.stringify(err, null, 2) : color.red(`Search '${searchId}' not found`);
  }

  if (options.json) {
    return JSON.stringify(result.candidates, null, 2);
  }

  const lines = [
    color.bold(`Candidates for Search ${searchId}:`),
    ...result.candidates.map((c) => {
      const q = c.evaluation?.qualifies ? color.green('✓ QUALIFIED') : color.red('✗ DISQUALIFIED');
      return `  - ${c.candidateId} (${c.descriptor.name}) [${c.status}] ${q}`;
    }),
  ];

  return lines.join('\n');
}

export function searchInspectCommand(
  engine: RookEngine,
  searchId: string,
  candidateId: string,
  options: { json?: boolean } = {},
): string {
  const result = engine.solutionSearch.getSearch(searchId);
  if (!result) {
    const err = { ok: false, error: `Search '${searchId}' not found` };
    return options.json ? JSON.stringify(err, null, 2) : color.red(`Search '${searchId}' not found`);
  }

  const candidate = result.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    const err = { ok: false, error: `Candidate '${candidateId}' not found in search '${searchId}'` };
    return options.json ? JSON.stringify(err, null, 2) : color.red(`Candidate '${candidateId}' not found`);
  }

  if (options.json) {
    return JSON.stringify(candidate, null, 2);
  }

  const lines = [
    color.bold(`=== Candidate Inspection: ${candidate.candidateId} ===`),
    `Name: ${candidate.descriptor.name}`,
    `Status: ${candidate.status}`,
    `Worktree: ${candidate.worktreePath}`,
    `Branch: ${candidate.branchName}`,
    `Revision: R${candidate.workspaceRevision}`,
    `Duration: ${candidate.durationMs ?? 0}ms`,
    '',
    color.bold('Verification & Checks:'),
    `  Checks count: ${candidate.checks.length}`,
    `  Evidence count: ${candidate.evidence.length}`,
    ...candidate.checks.map((c) => `  - check [${c.name}] (R${c.workspaceRevision ?? '?'}): ${c.ok ? color.green('PASS') : color.red('FAIL')}`),
    ...candidate.evidence.map((e) => `  - evidence [${e.oracle}] (R${e.workspaceRevision}): ${e.status}`),
    '',
    color.bold('Evaluation:'),
    `  Qualifies: ${candidate.evaluation?.qualifies ? color.green('YES') : color.red('NO')}`,
    `  Correctness: ${candidate.evaluation?.correctness ? color.green('PASS') : color.red('FAIL')}`,
    `  Physical Verification: ${candidate.evaluation?.verificationPassed ? color.green('PASS') : color.red('FAIL')}`,
    `  Disqualification Reasons: ${candidate.evaluation?.disqualificationReasons?.join(', ') || '(none)'}`,
  ];

  return lines.join('\n');
}

export async function searchPromoteCommand(
  engine: RookEngine,
  searchId: string,
  candidateId: string,
  options: { json?: boolean } = {},
): Promise<string> {
  const result = engine.solutionSearch.getSearch(searchId);
  if (!result) {
    const err = { ok: false, error: `Search '${searchId}' not found` };
    return options.json ? JSON.stringify(err, null, 2) : color.red(`Search '${searchId}' not found`);
  }

  const candidate = result.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    const err = { ok: false, error: `Candidate '${candidateId}' not found in search '${searchId}'` };
    return options.json ? JSON.stringify(err, null, 2) : color.red(`Candidate '${candidateId}' not found`);
  }

  const checkpoint = engine.checkpoints.getCheckpoint(result.checkpointId);
  if (!checkpoint) {
    const err = { ok: false, error: `Checkpoint '${result.checkpointId}' not found` };
    return options.json ? JSON.stringify(err, null, 2) : color.red(`Checkpoint '${result.checkpointId}' not found`);
  }

  try {
    const promo = await engine.solutionSearch.promoteCandidate({
      searchId,
      candidate,
      parentExecutionId: result.parentExecutionId,
      checkpoint,
      projectRoot: engine.projectRoot,
    });

    if (options.json) {
      return JSON.stringify(promo, null, 2);
    }

    if (promo.success) {
      return [
        color.green(`✓ Successfully promoted candidate '${candidateId}'`),
        `  Parent workspace advanced: R${promo.prePromotionRevision} -> R${promo.promotedRevision}`,
        `  Re-verification on promoted parent: ${promo.reverificationPassed ? color.green('PASS') : color.red('FAIL')}`,
        `  Branch: ${promo.provenance.branch}`,
      ].join('\n');
    } else {
      return [
        color.red(`✗ Promotion failed for candidate '${candidateId}'`),
        `  Conflict: ${promo.conflict?.reason ?? 'Unknown conflict'}`,
        `  Parent changed since checkpoint: ${promo.conflict?.parentChangedSinceCheckpoint ? 'YES' : 'NO'}`,
      ].join('\n');
    }
  } catch (err: any) {
    if (options.json) {
      return JSON.stringify({ ok: false, error: String(err) }, null, 2);
    }
    return color.red(`Promotion failed: ${err.message ?? String(err)}`);
  }
}

export function searchCancelCommand(
  engine: RookEngine,
  searchId: string,
  options: { json?: boolean } = {},
): string {
  const cancelled = engine.solutionSearch.cancelSearch(searchId);
  if (options.json) {
    return JSON.stringify({ ok: cancelled, searchId }, null, 2);
  }
  return cancelled
    ? color.green(`✓ Search '${searchId}' cancelled`)
    : color.yellow(`Search '${searchId}' not found or already completed`);
}
