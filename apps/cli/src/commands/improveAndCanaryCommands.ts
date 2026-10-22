import path from 'node:path';
import type { ExecutionRecord } from '@wazir/core';
import type { RookEngine } from '../engine.js';
import { color } from '../colors.js';
import { executeTask } from '../run.js';
import { table } from './formatters.js';

// ======================================================================
// SELF-IMPROVEMENT CLI COMMANDS (wa improve ...)
// ======================================================================

export async function improveStatusCommand(
  engine: RookEngine,
  options?: { json?: boolean },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  await optimizer.getRecoveryState();
  const activeConfig = optimizer.getActiveConfig();
  const budget = optimizer.getBudget();
  const consumption = optimizer.getConsumption();
  const history = optimizer.getHistory();
  const opportunities = optimizer.listOpportunities();

  const { resolveEffectiveCommitPolicy } = await import('@wazir/evaluation');
  const { supervisorDirectory } = await import('../improvementSupervisor.js');
  const { JsonFileStore } = await import('@wazir/shared');
  const supStore = new JsonFileStore(path.join(supervisorDirectory(engine.projectRoot), 'state.json'));
  const supState = await supStore.get<any>('supervisor/state').catch(() => undefined);
  const candidateEntries = await supStore.list('supervisor/git-candidates/').catch(() => []);
  const pendingApprovals = candidateEntries
    .map((e) => e.value as any)
    .filter((c) => c?.state === 'AWAITING_COMMIT_APPROVAL');
  const effectivePolicy = resolveEffectiveCommitPolicy(
    supState?.effectiveCommitMode
      ? {
          mode: supState.effectiveCommitMode,
          source: 'trusted_config',
          authorizingIdentity: 'operator',
          scope: 'session',
          repositoryRoot: engine.projectRoot,
        }
      : undefined,
    { repositoryRoot: engine.projectRoot },
  );

  const domains = ['routing', 'tool_surfaces', 'context_policy', 'prompts', 'orchestration', 'wazir_source_code'] as const;
  const levelNames = ['0 (OBSERVE)', '1 (RECOMMEND)', '2 (EXPERIMENT)', '3 (QUALIFY)', '4 (GUARDED PROMOTION)'];

  if (options?.json) {
    return JSON.stringify(
      {
        activeConfig,
        effectiveCommitMode: effectivePolicy.mode,
        permissions: effectivePolicy.permissions,
        pendingCommitApprovals: pendingApprovals.map((p) => ({
          attemptId: p.attemptId,
          branch: p.baseline?.branch,
          candidateRevisionHash: p.candidateRevisionHash,
          files: p.intendedFiles,
        })),
        domains: Object.fromEntries(domains.map((d) => [d, optimizer.getLevel(d)])),
        budget,
        consumption,
        historyCount: history.length,
        opportunitiesCount: opportunities.length,
      },
      null,
      2,
    );
  }

  const lines = [
    color.cyan('WAZIR SELF-IMPROVEMENT STATUS'),
    '-------------------------------------------------------',
    `Active Config:      ${activeConfig.id} (v${activeConfig.version})`,
    `Default Level:      Level ${levelNames[optimizer.getLevel()]}`,
    `Commit Policy:      ${effectivePolicy.mode} (exec=${effectivePolicy.permissions.codeExecutionAuthorized} commit=${effectivePolicy.permissions.commitAuthorized} push=${effectivePolicy.permissions.pushAuthorized} merge=${effectivePolicy.permissions.mergeAuthorized} deploy=${effectivePolicy.permissions.deploymentAuthorized})`,
    `Pending Approvals:  ${pendingApprovals.length}`,
    '',
    color.bold('Domain Maturity Levels:'),
    ...domains.map((d) => `  - ${d.padEnd(20)}: Level ${levelNames[optimizer.getLevel(d)]}`),
    '',
    color.bold('Resource Budgets:'),
    `  - Accounting:      ${consumption.accountingStatus}${consumption.accountingStatus === 'complete' ? '' : ' (recorded usage is incomplete; dispatch blocked)'}`,
    `  - Experiments:     ${consumption.experimentsCount} / ${budget.maxExperiments}`,
    `  - Candidates:      ${consumption.candidatesCount} / ${budget.maxCandidatesPerExperiment * budget.maxExperiments}`,
    `  - Model Calls:     ${consumption.modelCallsCount} / ${budget.maxModelCalls}`,
    `  - Tokens:          ${consumption.tokensCount.toLocaleString()} / ${budget.maxTokens.toLocaleString()}`,
    `  - Wall Time:       ${(consumption.wallTimeMs / 1000).toFixed(0)}s / ${(budget.maxWallTimeMs / 1000).toFixed(0)}s`,
    '',
    color.bold('Telemetry & History:'),
    `  - Opportunities:   ${opportunities.length} detected`,
    `  - Experiments Run: ${history.length} completed`,
    '-------------------------------------------------------',
  ];

  return lines.join('\n');
}

export async function improveOpportunitiesCommand(
  engine: RookEngine,
  options?: { json?: boolean },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  // If no opportunities recorded yet, observe current execution history
  let opps = optimizer.listOpportunities();
  if (opps.length === 0) {
    const executions = await engine.executions.list();
    opps = optimizer.observe({ executions });
  }

  if (options?.json) {
    return JSON.stringify(opps, null, 2);
  }

  if (opps.length === 0) {
    return color.green('No statistically significant improvement opportunities detected in recent execution history.');
  }

  const rows = opps.map((o) => [
    o.id,
    o.category,
    o.component,
    o.domain,
    o.metric,
    String(o.baseline),
    String(o.evidence),
  ]);

  return [
    color.cyan('IMPROVEMENT OPPORTUNITIES'),
    table(['ID', 'CATEGORY', 'COMPONENT', 'DOMAIN', 'METRIC', 'BASELINE', 'EVIDENCE'], rows),
  ].join('\n');
}

export async function improveExperimentsCommand(
  engine: RookEngine,
  options?: { json?: boolean },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  const history = optimizer.getHistory();
  if (options?.json) {
    return JSON.stringify(history, null, 2);
  }

  if (history.length === 0) {
    return color.yellow('No self-improvement experiments have been recorded yet.');
  }

  const rows = history.map((r) => [
    r.experimentId ?? r.runId.slice(0, 12),
    r.candidateConfig.id.slice(0, 12),
    `${(r.comparison.baselinePassRate * 100).toFixed(0)}% -> ${(r.comparison.candidatePassRate * 100).toFixed(0)}%`,
    String(r.comparison.tokenUsageDelta),
    r.decision === 'QUALIFIED' || r.decision === 'ACCEPTED'
      ? color.green(r.decision)
      : r.decision === 'INCONCLUSIVE'
        ? color.yellow(r.decision)
        : color.red(r.decision),
    r.reasons[0]?.slice(0, 50) ?? '-',
  ]);

  return [
    color.cyan('SELF-IMPROVEMENT EXPERIMENTS'),
    table(['EXPERIMENT', 'CANDIDATE', 'PASS RATE', 'TOKEN DELTA', 'DECISION', 'SUMMARY'], rows),
  ].join('\n');
}

export async function improveInspectCommand(
  engine: RookEngine,
  experimentId: string,
  options?: { json?: boolean },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  const run = optimizer.getHistory().find((h) => h.experimentId === experimentId || h.runId === experimentId);
  if (!run) {
    return color.red(`Experiment '${experimentId}' not found.`);
  }

  if (options?.json) {
    return JSON.stringify(run, null, 2);
  }

  return [
    color.cyan(`EXPERIMENT INSPECTION: ${experimentId}`),
    '-------------------------------------------------------',
    `Run ID:            ${run.runId}`,
    `Baseline Config:   ${run.baselineConfig.id} (v${run.baselineConfig.version})`,
    `Candidate Config:  ${run.candidateConfig.id} (v${run.candidateConfig.version})`,
    `Decision:          ${run.decision === 'QUALIFIED' || run.decision === 'ACCEPTED' ? color.green(run.decision) : color.red(run.decision)}`,
    '',
    color.bold('Mutations Attempted:'),
    ...run.mutations.map((m: any) => `  - ${m.type ?? m.strategy} on '${m.path ?? 'config'}': ${JSON.stringify(m.oldValue)} -> ${JSON.stringify(m.newValue)} (${m.rationale ?? ''})`),
    '',
    color.bold('Comparative Performance:'),
    `  - Baseline Pass: ${(run.comparison.baselinePassRate * 100).toFixed(1)}%`,
    `  - Candidate Pass: ${(run.comparison.candidatePassRate * 100).toFixed(1)}% (delta: ${(run.comparison.passRateDelta * 100).toFixed(1)}%)`,
    `  - Token Delta:    ${run.comparison.tokenUsageDelta}`,
    `  - Cost Delta:     ${run.comparison.costDelta}`,
    `  - Duration Delta: ${run.comparison.durationDelta.toFixed(0)}ms`,
    `  - Regressions:    ${run.comparison.regressedTasks.join(', ') || 'None'}`,
    '',
    color.bold('Reasons & Guard Verdict:'),
    ...run.reasons.map((r) => `  • ${r}`),
    ...(run.causalAttribution
      ? [
          '',
          color.bold(`Causal Attribution Matrix (Design: ${run.causalAttribution.design}):`),
          `  Overall Candidate Delta: ${(run.causalAttribution.candidateDelta * 100).toFixed(1)}%`,
          ...Object.values(run.causalAttribution.attributions).map(
            (attr) =>
              `  • ${attr.mutationId} (${attr.target}): ${color.bold(attr.verdict)} [isolated: ${(attr.isolatedDelta * 100).toFixed(1)}%, marginal: ${(attr.marginalDelta * 100).toFixed(1)}%] (confidence: ${(attr.confidence * 100).toFixed(0)}%)`,
          ),
          ...(run.causalAttribution.interactions.length > 0
            ? [
                color.bold('  Interactions:'),
                ...run.causalAttribution.interactions.map((i) => `    ⚠ ${i.description}`),
              ]
            : []),
        ]
      : []),
    ...(run.workerPlacements && run.workerPlacements.length > 0
      ? [
          '',
          color.bold(`Distributed Worker Placement (${run.workerPlacements.length} fleet nodes):`),
          table(
            ['WORKER', 'SHARD', 'TASKS', 'HARDWARE', 'PASS RATE', 'STATUS'],
            run.workerPlacements.map((p: any) => [
              p.workerId,
              p.shardId,
              `${p.taskCount} tasks`,
              `${p.hardware.cpu}, ${p.hardware.ramGB}GB`,
              `${(p.portableMetrics.passRate * 100).toFixed(0)}%`,
              p.status === 'FAILED' ? color.red(p.status) : color.green(p.status),
            ]),
          ),
        ]
      : []),
    ...(run.stratifiedMetrics && Object.keys(run.stratifiedMetrics).length > 0
      ? [
          '',
          color.bold('Stratified Hardware Performance:'),
          table(
            ['WORKER', 'BASELINE MS', 'CANDIDATE MS', 'DELTA MS', 'SPEEDUP'],
            Object.values(run.stratifiedMetrics).map((s: any) => [
              s.workerId,
              `${s.hardwareSensitive.baselineDurationMs}ms`,
              `${s.hardwareSensitive.candidateDurationMs}ms`,
              `${s.hardwareSensitive.durationDeltaMs}ms`,
              `${s.hardwareSensitive.speedupFactor}x`,
            ]),
          ),
        ]
      : []),
    '-------------------------------------------------------',
  ].join('\n');
}

export async function improveCompareCommand(
  engine: RookEngine,
  experimentId: string,
  options?: { json?: boolean },
): Promise<string> {
  return improveInspectCommand(engine, experimentId, options);
}

export async function improveExplainCommand(
  engine: RookEngine,
  experimentId: string,
  options?: { json?: boolean },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  const explanation = optimizer.explainExperiment(experimentId);
  if (options?.json) {
    return JSON.stringify({ experimentId, explanation }, null, 2);
  }
  return explanation;
}

export async function improvePromoteCommand(
  engine: RookEngine,
  candidateId: string,
  options?: { force?: boolean; json?: boolean },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  const candidate = optimizer.getCandidate(candidateId);
  if (!candidate) {
    const missing = {
      success: false,
      reason: `PROMOTION_DENIED: Persisted candidate '${candidateId}' not found.`,
    };
    return options?.json ? JSON.stringify(missing, null, 2) : color.red(`✗ ${missing.reason}`);
  }

  const res = await optimizer.promoteCandidate(candidate, {
    force: options?.force,
    operatorApproved: true,
  });

  if (options?.json) {
    return JSON.stringify(res, null, 2);
  }

  return res.success ? color.green(`✓ ${res.reason}`) : color.red(`✗ ${res.reason}`);
}

export async function improveRollbackCommand(
  engine: RookEngine,
  promotionId?: string,
  options?: { json?: boolean },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  const restored = await optimizer.rollback(promotionId);

  if (options?.json) {
    return JSON.stringify({ ok: true, activeConfig: restored }, null, 2);
  }

  return color.green(`✓ Rolled back active configuration to ${restored.id} (v${restored.version})`);
}

export async function improveRunCommand(
  engine: RookEngine,
  options?: { level?: string; json?: boolean; distributed?: boolean; runner?: any; offlinePolicy?: 'allow' | 'block' },
): Promise<string> {
  const optimizer = engine.optimizer;
  if (!optimizer) return color.yellow('MetaOptimizerService is not configured on this engine.');

  const { runGitPreflight } = await import('@wazir/evaluation');
  const gitPreflight = await runGitPreflight(engine.projectRoot, {
    fetchRemote: false,
    offlinePolicy: options?.offlinePolicy ?? 'allow',
  }).catch(() => undefined);

  if (gitPreflight && !gitPreflight.ok) {
    if (options?.json) {
      return JSON.stringify(
        {
          decision: 'BLOCKED_GIT_CONFLICT',
          reason: gitPreflight.blockedReason,
          gitPreflight,
        },
        null,
        2,
      );
    }
    return color.red(`✗ Git preflight blocked self-improvement cycle: ${gitPreflight.blockedReason}`);
  }

  // Step 1: Observe executions
  const executions = await engine.executions.list();
  const opportunities = optimizer.observe({ executions });

  if (opportunities.length === 0) {
    if (options?.json) {
      return JSON.stringify({ decision: 'NO_OPPORTUNITIES', opportunities: [], gitPreflight }, null, 2);
    }
    return color.green('MetaOptimizer cycle complete: No material improvement opportunities detected.');
  }

  // Step 2: Formulate hypotheses for top opportunity
  const topOpp = opportunities[0];
  const hypotheses = optimizer.formulateHypotheses(topOpp);
  if (hypotheses.length === 0) {
    if (options?.json) {
      return JSON.stringify({ decision: 'INCONCLUSIVE', reason: 'NO_TESTABLE_HYPOTHESES', opportunity: topOpp }, null, 2);
    }
    return color.yellow('Could not formulate testable hypotheses for detected opportunity.');
  }

  // Step 3: Design pre-registered experiment
  const plan = optimizer.designExperiment({
    hypothesis: hypotheses[0],
    sampleSize: 1,
  });

  // Step 4: Generate candidate
  const candidates = await optimizer.generateCandidates(plan, 1);
  const candidate = candidates[0];

  // Step 5: Verify candidate
  const verification = await optimizer.verifyCandidate(candidate);

  // Step 6: Benchmark candidate against baseline using real task execution (no synthetic results)
  const allTasks = engine.benchmark?.listTasks() ?? [];
  const matchedTasks = allTasks.filter((t) => plan.benchmarkCategories.includes(t.category));
  const tasksToRun = matchedTasks.length > 0 ? matchedTasks.slice(0, 2) : allTasks.slice(0, 2);

  if (tasksToRun.length === 0) {
    const payload = {
      decision: 'INCONCLUSIVE',
      reason: 'NO_BENCHMARK_TASKS_REGISTERED',
      opportunity: topOpp,
      plan,
      candidateId: candidate.candidateId,
      verification,
      results: [],
    };
    if (options?.json) {
      return JSON.stringify(payload, null, 2);
    }
    return [
      color.cyan('SELF-IMPROVEMENT EXPERIMENT OBSERVED'),
      '-------------------------------------------------------',
      `Opportunity:   ${topOpp.category} on ${topOpp.component}`,
      `Hypothesis:    ${hypotheses[0].proposedChange}`,
      `Experiment ID: ${plan.experimentId}`,
      `Candidate ID:  ${candidate.candidateId}`,
      `Verification:  ${verification.allPassed ? color.green('PASSED') : color.red('FAILED')}`,
      `Decision:      ${color.yellow('INCONCLUSIVE (NO_BENCHMARK_TASKS_REGISTERED)')}`,
      '-------------------------------------------------------',
    ].join('\n');
  }

  const liveRunner =
    options?.runner ?? {
      id: 'wazir-live-execution-runner',
      name: 'Wazir Real Task Execution Benchmark Runner',
      async run(task: any): Promise<ExecutionRecord> {
        const outcome = await executeTask(engine, task.prompt, {
          type: 'coding',
          expectedFiles: task.expectedFiles,
          maxTurns: 6,
          quiet: true,
          json: true,
        });
        if (!outcome.executionId || outcome.executionId === '—') {
          throw new Error(
            `Benchmark task '${task.id}' failed to execute: ${outcome.reasons.join('; ') || 'no execution created'}`,
          );
        }
        const record = await engine.executions.get(outcome.executionId);
        if (!record) {
          throw new Error(`Execution record '${outcome.executionId}' not found for benchmark task '${task.id}'`);
        }
        return record;
      },
    };

  const evalResults = await optimizer.evaluateCandidates({
    plan,
    candidates,
    runner: liveRunner,
    tasks: tasksToRun,
    distributed: options?.distributed,
  });

  const firstResult = evalResults[0];
  const decisionStr = firstResult
    ? firstResult.decision === 'QUALIFIED' || firstResult.decision === 'ACCEPTED'
      ? color.green(firstResult.decision)
      : firstResult.decision === 'INCONCLUSIVE'
        ? color.yellow(firstResult.decision)
        : color.red(firstResult.decision)
    : color.yellow('NOT_EVALUATED');

  if (options?.json) {
    return JSON.stringify({
      decision: firstResult?.decision ?? 'INCONCLUSIVE',
      opportunity: topOpp,
      plan,
      candidates,
      verification,
      results: evalResults,
    }, null, 2);
  }

  return [
    color.cyan('SELF-IMPROVEMENT EXPERIMENT OBSERVED'),
    '-------------------------------------------------------',
    `Opportunity:   ${topOpp.category} on ${topOpp.component}`,
    `Hypothesis:    ${hypotheses[0].proposedChange}`,
    `Experiment ID: ${plan.experimentId}`,
    `Candidate ID:  ${candidate.candidateId}`,
    `Primary:       ${plan.primaryMetric} (target: ${plan.requiredImprovement.targetValue})`,
    `Verification:  ${verification.allPassed ? color.green('PASSED') : color.red('FAILED')}`,
    `Decision:      ${decisionStr}`,
    `Promotion:     ${color.bold('RETAINED IN EXPERIMENT MODE (Zero unapproved self-modification)')}`,
    '',
    `Inspect:       wa improve inspect ${plan.experimentId}`,
    `Compare:       wa improve compare ${plan.experimentId}`,
    `Explain:       wa improve explain ${plan.experimentId}`,
    '-------------------------------------------------------',
  ].join('\n');
}

// ======================================================================
// WAZIR MATURITY LEVEL 3 CANARY PROMOTION CLI COMMANDS
// ======================================================================
// LEVEL 3 CONTINUOUS CANARY COMMANDS
// ======================================================================

export async function canaryListCommand(
  engine: RookEngine,
  options?: { json?: boolean },
): Promise<string> {
  const canaryService = (engine.optimizer as any)?.getCanaryDeploymentService?.();
  if (!canaryService) {
    if (options?.json) return JSON.stringify({ error: 'CanaryDeploymentService is not configured on this engine.' });
    return color.yellow('CanaryDeploymentService is not configured on this engine.');
  }

  const deployments = canaryService.listDeployments();
  if (options?.json) {
    return JSON.stringify(deployments, null, 2);
  }

  if (deployments.length === 0) {
    return 'No active or historical canary deployments found.';
  }

  const rows = deployments.map((d: any) => [
    d.canaryId,
    d.candidateId,
    d.domain,
    `${(d.currentAllocation * 100).toFixed(1)}%`,
    d.status === 'HEALTHY'
      ? color.green(d.status)
      : d.status === 'ROLLED_BACK'
        ? color.red(d.status)
        : d.status === 'READY_FOR_PROMOTION'
          ? color.cyan(d.status)
          : color.yellow(d.status),
    String(d.canaryMetrics.totalExecutions),
    `${(d.canaryMetrics.taskSuccessRate * 100).toFixed(1)}%`,
    `${(d.canaryMetrics.verificationSuccessRate * 100).toFixed(1)}%`,
  ]);

  return [
    color.cyan('WAZIR LEVEL 3 CANARY DEPLOYMENTS'),
    '',
    table(
      ['CANARY ID', 'CANDIDATE', 'DOMAIN', 'TRAFFIC', 'STATUS', 'SAMPLES', 'TASK PASS', 'VERIF PASS'],
      rows,
    ),
  ].join('\n');
}

export async function canaryStatusCommand(
  engine: RookEngine,
  options?: { json?: boolean },
): Promise<string> {
  const canaryService = (engine.optimizer as any)?.getCanaryDeploymentService?.();
  if (!canaryService) {
    if (options?.json) return JSON.stringify({ error: 'CanaryDeploymentService is not configured on this engine.' });
    return color.yellow('CanaryDeploymentService is not configured on this engine.');
  }

  const deployments = canaryService.listDeployments();
  const active = deployments.find(
    (d: any) =>
      d.status === 'ACTIVE' ||
      d.status === 'EVALUATING' ||
      d.status === 'HEALTHY' ||
      d.status === 'STAGED_EXPANSION' ||
      d.status === 'READY_FOR_PROMOTION',
  ) ?? deployments[deployments.length - 1];

  if (!active) {
    if (options?.json) return JSON.stringify({ active: null, total: 0 });
    return 'No active canary deployment.';
  }

  if (options?.json) {
    return JSON.stringify(active, null, 2);
  }

  return canaryInspectCommand(engine, active.canaryId, options);
}

export async function canaryHistoryCommand(
  engine: RookEngine,
  options?: { json?: boolean },
): Promise<string> {
  return canaryListCommand(engine, options);
}

export async function canaryInspectCommand(
  engine: RookEngine,
  canaryId: string,
  options?: { json?: boolean },
): Promise<string> {
  const canaryService = (engine.optimizer as any)?.getCanaryDeploymentService?.();
  if (!canaryService) {
    if (options?.json) return JSON.stringify({ error: 'CanaryDeploymentService is not configured on this engine.' });
    return color.yellow('CanaryDeploymentService is not configured on this engine.');
  }

  const record = canaryService.getDeployment(canaryId);
  if (!record) {
    if (options?.json) return JSON.stringify({ error: `Canary deployment '${canaryId}' not found.` });
    return color.red(`Canary deployment '${canaryId}' not found.`);
  }

  if (options?.json) {
    return JSON.stringify(record, null, 2);
  }

  const c = record.canaryMetrics;
  const b = record.baselineMetrics;

  const lines = [
    color.cyan(`CANARY DEPLOYMENT: ${record.canaryId}`),
    '======================================================================',
    `Status:              ${record.status}`,
    `Domain:              ${record.domain}`,
    `Candidate ID:        ${record.candidateId}`,
    `Current Traffic:     ${(record.currentAllocation * 100).toFixed(1)}% (Stage ${(record.currentTierIndex ?? 0) + 1}/${record.stagedExpansionTiers.length})`,
    `Started At:          ${new Date(record.startTime).toISOString()}`,
    `Updated At:          ${new Date(record.updatedAt).toISOString()}`,
    ...(record.completedAt ? [`Completed At:        ${new Date(record.completedAt).toISOString()}`] : []),
    '',
    'COMPARATIVE ONLINE METRICS (Canary vs Baseline):',
    '----------------------------------------------------------------------',
    `Total Executions:    Canary: ${c.totalExecutions.toString().padEnd(6)} | Baseline: ${b.totalExecutions}`,
    `Task Success Rate:   Canary: ${(c.taskSuccessRate * 100).toFixed(1)}%     | Baseline: ${(b.taskSuccessRate * 100).toFixed(1)}%`,
    `Verif Success Rate:  Canary: ${(c.verificationSuccessRate * 100).toFixed(1)}%     | Baseline: ${(b.verificationSuccessRate * 100).toFixed(1)}%`,
    `Tool Failure Rate:   Canary: ${(c.toolFailureRate * 100).toFixed(1)}%     | Baseline: ${(b.toolFailureRate * 100).toFixed(1)}%`,
    `Repair Cycles:       Canary: ${c.repairCycles.toString().padEnd(6)} | Baseline: ${b.repairCycles}`,
    `Recovery Failures:   Canary: ${c.recoveryFailures.toString().padEnd(6)} | Baseline: ${b.recoveryFailures}`,
    `Total Tokens:        Canary: ${c.totalTokens.toString().padEnd(6)} | Baseline: ${b.totalTokens}`,
    `Wall Time:           Canary: ${c.wallTimeMs}ms  | Baseline: ${b.wallTimeMs}ms`,
  ];

  if (record.rollbackReason) {
    lines.push(
      '',
      color.red('ROLLBACK TRIGGERED:'),
      `Metric:              ${record.rollbackReason.metric}`,
      `Description:         ${record.rollbackReason.description}`,
      `Delta:               ${record.rollbackReason.delta}`,
      `Threshold:           ${record.rollbackReason.threshold}`,
    );
  }

  if (record.inconclusiveReasons && record.inconclusiveReasons.length > 0) {
    lines.push(
      '',
      color.yellow('INCONCLUSIVE DETERMINATIONS:'),
      ...record.inconclusiveReasons.map((r: string) => `  - ${r}`),
    );
  }

  lines.push('======================================================================');
  return lines.join('\n');
}

export async function canaryCompareCommand(
  engine: RookEngine,
  canaryId: string,
  options?: { json?: boolean },
): Promise<string> {
  const canaryService = (engine.optimizer as any)?.getCanaryDeploymentService?.();
  if (!canaryService) {
    if (options?.json) return JSON.stringify({ error: 'CanaryDeploymentService is not configured on this engine.' });
    return color.yellow('CanaryDeploymentService is not configured on this engine.');
  }

  const record = canaryService.getDeployment(canaryId);
  if (!record) {
    if (options?.json) return JSON.stringify({ error: `Canary deployment '${canaryId}' not found.` });
    return color.red(`Canary deployment '${canaryId}' not found.`);
  }

  const c = record.canaryMetrics;
  const b = record.baselineMetrics;

  const comparison = {
    canaryId: record.canaryId,
    candidateId: record.candidateId,
    domain: record.domain,
    status: record.status,
    stage: record.stage,
    allocation: record.currentAllocation,
    metrics: {
      taskSuccessRate: { baseline: b.taskSuccessRate, canary: c.taskSuccessRate, delta: c.taskSuccessRate - b.taskSuccessRate },
      verificationSuccessRate: { baseline: b.verificationSuccessRate, canary: c.verificationSuccessRate, delta: c.verificationSuccessRate - b.verificationSuccessRate },
      toolFailureRate: { baseline: b.toolFailureRate, canary: c.toolFailureRate, delta: c.toolFailureRate - b.toolFailureRate },
      totalTokens: { baseline: b.totalTokens, canary: c.totalTokens, delta: c.totalTokens - b.totalTokens },
      wallTimeMs: { baseline: b.wallTimeMs, canary: c.wallTimeMs, delta: c.wallTimeMs - b.wallTimeMs },
      totalExecutions: { baseline: b.totalExecutions, canary: c.totalExecutions },
    },
  };

  if (options?.json) {
    return JSON.stringify(comparison, null, 2);
  }

  const rows = [
    [
      'Verification Pass',
      `${(b.verificationSuccessRate * 100).toFixed(1)}%`,
      `${(c.verificationSuccessRate * 100).toFixed(1)}%`,
      `${((c.verificationSuccessRate - b.verificationSuccessRate) * 100).toFixed(1)}%`,
    ],
    [
      'Task Success',
      `${(b.taskSuccessRate * 100).toFixed(1)}%`,
      `${(c.taskSuccessRate * 100).toFixed(1)}%`,
      `${((c.taskSuccessRate - b.taskSuccessRate) * 100).toFixed(1)}%`,
    ],
    [
      'Tool Failure Rate',
      `${(b.toolFailureRate * 100).toFixed(1)}%`,
      `${(c.toolFailureRate * 100).toFixed(1)}%`,
      `${((c.toolFailureRate - b.toolFailureRate) * 100).toFixed(1)}%`,
    ],
    [
      'Total Tokens',
      String(b.totalTokens),
      String(c.totalTokens),
      String(c.totalTokens - b.totalTokens),
    ],
    [
      'Wall Time (ms)',
      String(b.wallTimeMs),
      String(c.wallTimeMs),
      String(c.wallTimeMs - b.wallTimeMs),
    ],
  ];

  return [
    color.cyan(`CANARY COMPARISON: ${record.canaryId} (${record.candidateId})`),
    '',
    table(['DIMENSION', 'BASELINE', 'CANARY', 'DELTA'], rows),
  ].join('\n');
}

export async function canaryShadowCommand(
  engine: RookEngine,
  canaryId: string,
  options?: { json?: boolean },
): Promise<string> {
  const canaryService = (engine.optimizer as any)?.getCanaryDeploymentService?.();
  if (!canaryService) {
    if (options?.json) return JSON.stringify({ error: 'CanaryDeploymentService is not configured on this engine.' });
    return color.yellow('CanaryDeploymentService is not configured on this engine.');
  }

  let shadowResults: any[] = [];
  if (typeof canaryService.getShadowResults === 'function') {
    shadowResults = canaryService.getShadowResults(canaryId);
  }

  if (options?.json) {
    return JSON.stringify(shadowResults, null, 2);
  }

  if (shadowResults.length === 0) {
    return `No shadow evaluation results recorded for canary '${canaryId}'.`;
  }

  const rows = shadowResults.map((s: any) => [
    s.taskId.slice(0, 16),
    s.productionOutcome.success ? color.green('PASS') : color.red('FAIL'),
    s.shadowOutcome.success ? color.green('PASS') : color.red('FAIL'),
    s.metricsDelta.verificationAgreed ? color.green('YES') : color.red('NO'),
    `${s.metricsDelta.tokensDelta > 0 ? '+' : ''}${s.metricsDelta.tokensDelta}`,
    `${s.metricsDelta.wallTimeDeltaMs > 0 ? '+' : ''}${s.metricsDelta.wallTimeDeltaMs}ms`,
  ]);

  return [
    color.cyan(`SHADOW EVALUATION RESULTS FOR ${canaryId}`),
    `Total Shadow Workloads: ${shadowResults.length} (Production Impact: NONE)`,
    '',
    table(['TASK ID', 'PROD SUCCESS', 'SHADOW SUCCESS', 'VERIF AGREE', 'TOKENS Δ', 'WALL TIME Δ'], rows),
  ].join('\n');
}

export async function canaryRollbackCommand(
  engine: RookEngine,
  canaryId: string,
  options?: { reason?: string; json?: boolean },
): Promise<string> {
  const canaryService = (engine.optimizer as any)?.getCanaryDeploymentService?.();
  if (!canaryService) {
    if (options?.json) return JSON.stringify({ error: 'CanaryDeploymentService is not configured on this engine.' });
    return color.yellow('CanaryDeploymentService is not configured on this engine.');
  }

  const record = canaryService.getDeployment(canaryId);
  if (!record) {
    if (options?.json) return JSON.stringify({ error: `Canary deployment '${canaryId}' not found.` });
    return color.red(`Canary deployment '${canaryId}' not found.`);
  }

  const rolledBack = await canaryService.rollbackCanary(canaryId, options?.reason ?? 'Operator manual emergency rollback initiated.');

  if (options?.json) {
    return JSON.stringify(rolledBack, null, 2);
  }

  return color.green(`✓ Canary ${canaryId} successfully rolled back. 100% traffic restored to verified baseline.`);
}

export async function canaryControlCommand(
  engine: RookEngine,
  action: 'pause' | 'resume' | 'throttle' | 'advance',
  canaryId: string,
  options?: { json?: boolean; percentage?: string },
): Promise<string> {
  const service = engine.optimizer.getCanaryDeploymentService();
  let record;
  if (action === 'pause') record = await service.pauseCanary(canaryId);
  else if (action === 'resume') record = await service.resumeCanary(canaryId);
  else if (action === 'advance') record = await service.advanceCanaryStage(canaryId);
  else {
    const raw = options?.percentage ?? '';
    if (!/^(?:\d+)(?:\.\d+)?$/.test(raw)) throw new Error(`Invalid canary percentage '${raw}'.`);
    record = await service.throttleCanary(canaryId, Number(raw));
  }
  if (options?.json) return JSON.stringify(record, null, 2);
  return color.green(`Canary ${canaryId}: ${action} complete (${record.status}, ${record.stage}, ${(record.currentAllocation * 100).toFixed(1)}%).`);
}
