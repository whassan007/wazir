import type {
  AutonomousRepairRecord,
  CandidateExecutionImprovement,
  CostAndUtilizationBreakdown,
  ObservedExecutionMetrics,
} from './autonomousRepair.js';
import type {
  AcceptanceTestRecord,
  ControlledFaultInjectionReport,
  FaultScenarioResult,
  MandatoryUserJourneysReport,
  UserJourneyResult,
} from './qualificationSuite.js';
import type {
  AcceptanceState,
  CapabilityGraph,
  DeclarativeExecutionPlan,
  DurableManagedTask,
  PoolAllocationQuantities,
  ReconciliationSnapshot,
  ServerAcceptanceRow,
} from './types.js';

/**
 * Part 8: 4-Pillar Progressive Disclosure UX Views.
 *
 * Pillar 1 (`renderInfrastructureView`): "What hardware do I have?"
 * Pillar 2 (`renderExecutionView`):      "What is running, where, and why?"
 * Pillar 3 (`renderQualificationView`):  "Does Wazir really work?"
 * Pillar 4 (`renderOptimizationView`):   "How can Wazir accomplish the same work more reliably or cheaply?"
 * Unified  (`renderUnifiedMetaHarnessOverview`): Task-oriented synthesis with progressive disclosure hints.
 */

export interface ProgressiveViewOptions {
  /** Emit expanded diagnostics, per-entity IDs, lease tokens, and full event tables. */
  detail?: boolean;
  /** Output style; defaults to GitHub-flavored markdown tables/lists cleanly readable in CLI & TUI. */
  format?: 'markdown' | 'plain';
  /** Maximum per-section item rows in concise mode (default: 10). */
  maxConciseRows?: number;
}

export type ReleaseReadinessVerdict =
  | 'RELEASE_READY'
  | 'QUALIFIED_WITH_EXTERNAL_INFRA_DEGRADATION'
  | 'PENDING_LIVE_QUALIFICATION'
  | 'NOT_READY';

const ACCEPTING_STATES = new Set<AcceptanceState>([
  'API_READY',
  'MODEL_READY',
  'EXECUTION_VERIFIED',
  'CAPACITY_VERIFIED',
]);

function isAcceptingRequests(state: AcceptanceState): boolean {
  return ACCEPTING_STATES.has(state);
}

function formatAcceptanceBadge(state: AcceptanceState): string {
  if (state === 'DISABLED_BY_POLICY') return 'DISABLED_BY_POLICY (0%)';
  if (isAcceptingRequests(state)) return `ACCEPTING REQUESTS [${state}]`;
  if (state === 'SATURATED') return 'SATURATED (QUEUEING)';
  return `NOT ACCEPTING REQUESTS! [${state}]`;
}

// ============================================================================
// Pillar 1: Infrastructure View ("What hardware do I have?")
// ============================================================================

export function renderInfrastructureView(
  graph: CapabilityGraph,
  acceptanceRows: ServerAcceptanceRow[] = [],
  opts: ProgressiveViewOptions = {},
): string {
  const detail = opts.detail === true;
  const lines: string[] = [];

  lines.push('## Pillar 1: Infrastructure — What hardware do I have?');
  lines.push(
    `Coordinator Host: \`${graph.coordinatorHostId}\` | Snapshot: \`${graph.generatedAt}\``,
  );
  lines.push('');

  const hosts = Object.values(graph.hosts);
  const endpoints = Object.values(graph.endpoints);
  const models = Object.values(graph.models);
  const runtimes = Object.values(graph.runtimeProcesses);
  const transports = Object.values(graph.transports);
  const providers = Object.values(graph.cloudProviders);

  // 1. Physical Sovereign Machines
  lines.push(`### Sovereign Physical Machines (${hosts.length})`);
  if (hosts.length === 0) {
    lines.push('- No physical hosts discovered yet. Run discovery (`Discover my machines.`) first.');
  } else {
    lines.push('| Host | CPU | GPU / Unified Memory | RAM (Avail / Total) | Connectivity | Runtimes & Models |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');

    for (const host of hosts) {
      const cpuDesc = `${host.cpu.brand} (${host.cpu.logicalCores}c, ${Math.round(host.cpu.utilizationPercent)}% util)`;
      const gpuDesc =
        host.gpus.length > 0
          ? host.gpus
              .map(
                (g) =>
                  `${g.model} (${g.availableMemoryGB !== undefined ? `${g.availableMemoryGB.toFixed(1)}/` : ''}${g.totalMemoryGB}GB${g.unifiedMemory ? ' Unified' : ' VRAM'})`,
              )
              .join('; ')
          : host.memory.unifiedMemory
            ? `Unified Memory (${host.memory.totalGB}GB)`
            : 'CPU only';

      const ramDesc = `${host.memory.availableGB.toFixed(1)} / ${host.memory.totalGB.toFixed(1)} GB (${host.memory.pressureLevel})`;

      const hostNets = Object.values(graph.networkIdentities).filter((n) => n.hostId === host.hostId);
      const hostTunnels = transports.filter((t) => t.targetHostId === host.hostId);
      const netParts = [
        ...new Set([
          ...hostNets.map((n) => `${n.scope}:${n.address}`),
          ...hostTunnels.map(
            (t) => `${t.type}(${t.localEndpointUrl}->${t.remoteLoopbackUrl}${t.verifiedActive ? '' : ' INACTIVE'})`,
          ),
        ]),
      ];
      const netDesc = netParts.length > 0 ? netParts.join(', ') : 'local';

      const hostRuntimes = runtimes.filter((r) => r.hostId === host.hostId);
      const hostModels = models.filter((m) => m.hostId === host.hostId);
      const loadedCount = hostModels.filter((m) => m.residency === 'loaded').length;
      const installedCount = hostModels.filter((m) => m.residency === 'installed_not_loaded').length;
      const rtSummary =
        hostRuntimes.length > 0
          ? hostRuntimes
              .map((r) => `${r.runtimeType}${r.role === 'secondary' ? '(secondary)' : ''}:${r.running ? 'up' : 'stopped'}`)
              .join(', ')
          : 'no runtime';

      lines.push(
        `| \`${host.hostId}\` (${host.hostname}) | ${cpuDesc} | ${gpuDesc} | ${ramDesc} | ${netDesc} | ${rtSummary} — ${loadedCount} warm / ${installedCount} cold |`,
      );
    }
  }
  lines.push('');

  // 2. Server Request-Acceptance Summary
  if (acceptanceRows.length > 0) {
    lines.push('### Server Request-Acceptance & Warm Model Status');
    lines.push('| Pool | Host | Endpoint | Runtime / Model | Safe Concurrency | Request-Acceptance Status |');
    lines.push('| :--- | :--- | :--- | :--- | :---: | :--- |');
    for (const row of acceptanceRows) {
      const conc =
        row.verifiedConcurrency !== undefined
          ? `${row.verifiedConcurrency} verified (cfg ${row.configuredMaxConcurrent})`
          : `${row.configuredMaxConcurrent} cfg`;
      const diagSuffix = row.diagnostic ? ` — ${row.diagnostic}` : '';
      lines.push(
        `| \`${row.pool}\` | \`${row.host}\` | \`${row.endpoint}\` | \`${row.runtime}\` / \`${row.model}\` | ${conc} | ${formatAcceptanceBadge(row.status)}${diagSuffix} |`,
      );
    }
    lines.push('');
  }

  // 3. Cloud Coding-Agent Providers (explicitly zero fabricated GPU/RAM)
  if (providers.length > 0) {
    lines.push('### Cloud Coding-Agent Providers');
    for (const p of providers) {
      if (p.disabledByPolicy || p.providerId === 'claude') {
        lines.push(
          `- **${p.displayName}** (\`${p.providerId}\`): \`DISABLED_BY_POLICY\` — strictly \`0%\` / \`0\` subagents.`,
        );
      } else {
        const quotaNote = p.exposedQuotas
          ? ` | quota remaining=${p.exposedQuotas.requestsRemaining ?? 'n/a'} (${p.exposedQuotas.source})`
          : '';
        lines.push(
          `- **${p.displayName}** (\`${p.providerId}\`): \`${p.acceptanceState}\` | auth=\`${p.authStatus}\` | maxConcurrent=${p.configuredMaxConcurrent}${quotaNote}`,
        );
      }
    }
    lines.push('');
  }

  // Active workload conflict warnings (e.g., simulations holding GPU VRAM)
  const conflicts = hosts.flatMap((h) =>
    h.workloadConflicts.map((c) => ({ hostId: h.hostId, conflict: c })),
  );
  if (conflicts.length > 0) {
    lines.push('### Protected Workload Reservations');
    for (const { hostId, conflict } of conflicts) {
      lines.push(
        `- \`${hostId}\`: \`${conflict.processName}\` (${conflict.kind}) reserving ${conflict.reservedVramGB}GB VRAM / ${conflict.reservedRamGB}GB RAM${conflict.doNotInterrupt ? ' [DO NOT INTERRUPT]' : ''}`,
      );
    }
    lines.push('');
  }

  // Progressive disclosure `--detail`
  if (detail) {
    lines.push('### Detailed Endpoint Origin Context & Model Residency (`--detail`)');
    for (const ep of endpoints) {
      lines.push(
        `- Endpoint \`${ep.endpointId}\` on \`${ep.hostId}\`: rawUrl=\`${ep.rawUrl}\` (valid from \`${ep.originContextHostId}\`, scope=\`${ep.visibility}\`, transport=\`${ep.transport}\`, state=\`${ep.acceptanceState}\`)${ep.diagnosticMessage ? ` — ${ep.diagnosticMessage}` : ''}`,
      );
    }
    for (const m of models) {
      const perf =
        m.measuredTokensPerSecond !== undefined
          ? `, ${m.measuredTokensPerSecond.toFixed(1)} tok/s`
          : '';
      lines.push(
        `- Model \`${m.modelId}\` (${m.hostId ?? m.providerId ?? 'unknown'}): residency=\`${m.residency}\`, weights≈${m.estimatedWeightsGB}GB, kv/slot≈${m.kvCachePerSlotGB}GB, toolsVerified=${m.toolCallingVerified}${perf}`,
      );
    }
  } else {
    lines.push(
      '_Hint: Pass `--detail` to inspect per-endpoint `originContextHostId` loopback scopes, SSH tunnel forwards, and model memory footprints._',
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Pillar 2: Execution View ("What is running, where, and why?")
// ============================================================================

export function renderExecutionView(
  plan: DeclarativeExecutionPlan,
  quantities: Record<string, PoolAllocationQuantities> | PoolAllocationQuantities[],
  tasks: DurableManagedTask[] = [],
  reconciliation?: ReconciliationSnapshot,
  opts: ProgressiveViewOptions = {},
): string {
  const detail = opts.detail === true;
  const maxRows = opts.maxConciseRows ?? 10;
  const quantList: PoolAllocationQuantities[] = Array.isArray(quantities)
    ? quantities
    : Object.values(quantities);

  const lines: string[] = [];
  lines.push('## Pillar 2: Execution — What is running, where, and why?');

  const requestedAgents =
    reconciliation?.desired.requestedAgents ?? plan.spec.execution.total_agents;
  const effectiveAgents =
    reconciliation?.desired.effectiveAgents ??
    (quantList.reduce((acc, q) => acc + q.admittedAgents, 0) || requestedAgents);
  const speedOpt =
    reconciliation?.desired.speedOptimized ?? Boolean(plan.spec.execution.speed_optimization);

  lines.push(
    `Plan: \`${plan.metadata.name}\` (v${plan.metadata.version}) | Strategy: \`${plan.spec.routing.strategy}\` | Requested Agents: **${requestedAgents}** | Effective Active Wave: **${effectiveAgents}**${speedOpt ? ' _(speed-optimized)_' : ''}`,
  );
  lines.push('');

  // 4-Quantity Allocation & Observable Queue Table
  lines.push('### Pool Allocation, Concurrency & Observable Queues (4-Quantity Accounting)');
  lines.push(
    '| Pool | Share | 1. Target | 2. Admitted | 3. Running | Queued | 4. Completed | Failed | Concurrency Cap | Routing / Spillover Why |',
  );
  lines.push(
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
  );

  for (const poolSpec of plan.spec.pools) {
    const q = quantList.find((item) => item.poolId === poolSpec.id);
    if (!poolSpec.enabled || poolSpec.id === 'claude') {
      lines.push(
        `| \`${poolSpec.id}\` | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Strictly disabled by policy (\`0%\` ${poolSpec.id}) |`,
      );
      continue;
    }

    if (!q) {
      lines.push(
        `| \`${poolSpec.id}\` | ${poolSpec.share}% | - | 0 | 0 | 0 | 0 | 0 | ${poolSpec.max_concurrent} cfg | Pending admission |`,
      );
      continue;
    }

    const rerouteNotes: string[] = [];
    if (q.reroutedFromPools && q.reroutedFromPools.length > 0) {
      rerouteNotes.push(`spilled from ${q.reroutedFromPools.join(', ')}`);
    }
    if (q.unavailabilityReason) {
      rerouteNotes.push(`UNAVAILABLE: ${q.unavailabilityReason}`);
    }
    if (q.queuedAgents > 0 && q.runningAgents >= q.effectiveConcurrentLimit) {
      rerouteNotes.push(`healthy saturation queue (${q.runningAgents}/${q.effectiveConcurrentLimit} slots full)`);
    }
    if (rerouteNotes.length === 0) {
      rerouteNotes.push(poolSpec.host ? `warm sovereign host ${poolSpec.host}` : `cloud provider ${poolSpec.provider}`);
    }

    lines.push(
      `| \`${q.poolId}\` | ${q.targetSharePct}% | ${q.targetAllocation} | ${q.admittedAgents} | ${q.runningAgents} | ${q.queuedAgents} | ${q.completedAgents} | ${q.failedAgents} | ${q.effectiveConcurrentLimit}${q.verifiedSafeConcurrent !== undefined ? ' (verified)' : ' (cfg)'} | ${rerouteNotes.join('; ')} |`,
    );
  }
  lines.push('');

  // Active Leases & Task Placement Summary
  const runningTasks = tasks.filter((t) => t.state === 'running' || t.state === 'verifying');
  const queuedTasks = tasks.filter((t) => t.state === 'queued' || t.state === 'pending_dependencies');

  lines.push(
    `### Active Execution & Queue Summary (Running: ${runningTasks.length}, Queued: ${queuedTasks.length}, Total Tasks: ${tasks.length})`,
  );

  const visibleTasks = detail ? tasks : [...runningTasks, ...queuedTasks].slice(0, maxRows);
  if (visibleTasks.length === 0 && tasks.length > 0) {
    const completedCount = tasks.filter((t) => t.state === 'completed').length;
    lines.push(`- Wave idle/completed: ${completedCount}/${tasks.length} tasks verified complete.`);
  } else {
    for (const t of visibleTasks) {
      const targetPool = t.executedPoolId ?? t.assignedPoolId;
      const rerouteTag =
        t.executedPoolId && t.executedPoolId !== t.assignedPoolId
          ? ` _(rerouted from \`${t.assignedPoolId}\`)_`
          : '';
      const leaseInfo =
        detail && t.lease
          ? ` | lease=\`${t.lease.leaseToken}\` ep=${t.lease.epoch} exp=${t.lease.expiresAt} model=\`${t.lease.modelId}\``
          : t.lease
            ? ` | model=\`${t.lease.modelId}\``
            : '';
      lines.push(
        `- \`${t.logicalAgentId}\` (\`${t.taskId}\`): **${t.state}** on \`${targetPool}\`${rerouteTag} — ${t.profile.title} [type=${t.profile.taskType}]${leaseInfo}`,
      );
    }
  }

  if (reconciliation && reconciliation.detectedEvents.length > 0) {
    lines.push('');
    lines.push('### Continuous Reconciliation Events');
    const eventsToShow = detail
      ? reconciliation.detectedEvents
      : reconciliation.detectedEvents.slice(-5);
    for (const ev of eventsToShow) {
      lines.push(`- \`${ev.at}\` **${ev.kind}** (\`${ev.targetId}\`): ${ev.detail}`);
    }
  }

  if (!detail) {
    lines.push('');
    lines.push(
      '_Hint: Pass `--detail` to view active lease tokens, fencing epochs, task-by-task placement traces, and full reconciliation history._',
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Pillar 3: Qualification View ("Does Wazir really work?")
// ============================================================================

export function renderQualificationView(
  journeysInput: UserJourneyResult[] | MandatoryUserJourneysReport,
  acceptanceTests: AcceptanceTestRecord[] = [],
  faultsInput: FaultScenarioResult[] | ControlledFaultInjectionReport = [],
  repairs: AutonomousRepairRecord[] = [],
  opts: ProgressiveViewOptions = {},
): string {
  const detail = opts.detail === true;
  const journeys = Array.isArray(journeysInput) ? journeysInput : journeysInput.journeys;
  const faults = Array.isArray(faultsInput) ? faultsInput : faultsInput.results;

  const journeysPassed = journeys.filter((j) => j.passed).length;
  const testsPassed = acceptanceTests.filter((t) => t.passed).length;
  const faultsPassed = faults.filter((f) => f.passed).length;

  const acceptedRepairs = repairs.filter((r) => r.decision === 'ACCEPTED').length;
  const oracleRejectedRepairs = repairs.filter(
    (r) =>
      r.decision === 'REJECTED_ORACLE_WEAKENING' ||
      r.attempts.some((a) => a.decision === 'REJECTED_ORACLE_WEAKENING'),
  ).length;
  const externalInfraSkips = repairs.filter(
    (r) => r.decision === 'SKIPPED_EXTERNAL_INFRASTRUCTURE',
  ).length;

  // Determine Release Readiness Verdict honestly (never claim RELEASE_READY if unverified or failing!)
  let verdict: ReleaseReadinessVerdict = 'PENDING_LIVE_QUALIFICATION';
  const blockingReasons: string[] = [];

  if (journeys.length === 0 && acceptanceTests.length === 0 && faults.length === 0) {
    verdict = 'PENDING_LIVE_QUALIFICATION';
    blockingReasons.push('Qualification suites have not been executed yet.');
  } else {
    const failedJourneys = journeys.filter((j) => !j.passed);
    const failedAcceptance = acceptanceTests.filter((t) => !t.passed);
    const failedFaults = faults.filter((f) => !f.passed);
    const unresolvedProductRepairs = repairs.filter(
      (r) =>
        r.diagnosis.category === 'PRODUCT_DEFECT' && r.decision !== 'ACCEPTED',
    );

    if (failedJourneys.length > 0) {
      blockingReasons.push(
        `Failed user journeys: ${failedJourneys.map((j) => j.journeyId).join(', ')}`,
      );
    }
    if (failedAcceptance.length > 0) {
      blockingReasons.push(
        `Failed acceptance tests: ${failedAcceptance.map((t) => t.id).join(', ')}`,
      );
    }
    if (failedFaults.length > 0) {
      blockingReasons.push(
        `Failed fault scenarios: ${failedFaults.map((f) => f.scenarioId).join(', ')}`,
      );
    }
    if (unresolvedProductRepairs.length > 0) {
      blockingReasons.push(
        `Unresolved product defects: ${unresolvedProductRepairs.map((r) => r.repairId).join(', ')}`,
      );
    }

    if (blockingReasons.length > 0) {
      verdict = 'NOT_READY';
    } else if (externalInfraSkips > 0) {
      verdict = 'QUALIFIED_WITH_EXTERNAL_INFRA_DEGRADATION';
    } else {
      verdict = 'RELEASE_READY';
    }
  }

  const lines: string[] = [];
  lines.push('## Pillar 3: Qualification — Does Wazir really work?');
  lines.push(`**Release Readiness Verdict**: \`${verdict}\``);
  if (blockingReasons.length > 0) {
    lines.push(`Blocking Reasons: ${blockingReasons.join(' | ')}`);
  }
  lines.push('');

  lines.push('### Qualification Scorecard');
  lines.push(
    `- **Real-User Journeys (A–H)**: **${journeysPassed}/${journeys.length}** passed`,
  );
  lines.push(
    `- **Acceptance Tests (1–15)**: **${testsPassed}/${acceptanceTests.length}** passed`,
  );
  lines.push(
    `- **Controlled Fault Injection (12 Scenarios)**: **${faultsPassed}/${faults.length}** passed`,
  );
  lines.push(
    `- **Autonomous Repairs**: ${acceptedRepairs} accepted | ${oracleRejectedRepairs} oracle-weakening attempts blocked | ${externalInfraSkips} external-infra non-defects skipped`,
  );
  lines.push('');

  if (journeys.length > 0) {
    lines.push('### Mandatory User Journeys');
    for (const j of journeys) {
      lines.push(
        `- [${j.passed ? 'PASS' : 'FAIL'}] **${j.journeyId}** (${j.title}) — ${j.summary}${detail && j.evidenceArtifacts.length > 0 ? ` [evidence: ${j.evidenceArtifacts.join(', ')}]` : ''}`,
      );
    }
    lines.push('');
  }

  if (detail && acceptanceTests.length > 0) {
    lines.push('### Acceptance Tests (1–15) (`--detail`)');
    for (const t of acceptanceTests) {
      lines.push(
        `- [${t.passed ? 'PASS' : 'FAIL'}] **${t.id}** (#${t.testNumber}): ${t.title} — ${t.detail}`,
      );
    }
    lines.push('');
  }

  if (detail && faults.length > 0) {
    lines.push('### Controlled Fault Injection Results (`--detail`)');
    for (const f of faults) {
      lines.push(
        `- [${f.passed ? 'PASS' : 'FAIL'}] \`${f.scenarioId}\`: ${f.detectedStateTransition} -> ${f.recoveryActionVerified} (dupCommits=${f.zeroDuplicateCommits ? 0 : '>0'})`,
      );
    }
    lines.push('');
  } else if (!detail) {
    lines.push(
      '_Hint: Pass `--detail` to inspect all 15 acceptance test records, all 12 fault-injection state transitions, and repair attempt traces._',
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Pillar 4: Optimization View ("How can Wazir accomplish the same work more reliably or cheaply?")
// ============================================================================

export function renderOptimizationView(
  metrics: ObservedExecutionMetrics,
  recommendations: CandidateExecutionImprovement[] = [],
  costBreakdown?: CostAndUtilizationBreakdown,
  opts: ProgressiveViewOptions = {},
): string {
  const detail = opts.detail === true;
  const costs = costBreakdown ?? metrics.costBreakdown;
  const promoted = recommendations.filter((r) => r.promoted);
  const rejected = recommendations.filter((r) => !r.promoted);

  const lines: string[] = [];
  lines.push(
    '## Pillar 4: Optimization — How can Wazir accomplish the same work more reliably or cheaply?',
  );
  lines.push(
    `Observations: **${metrics.totalObservations}** | Verified Success: **${(metrics.overallVerifiedSuccessRate * 100).toFixed(1)}%** | Routing Efficiency: **${(metrics.routingEfficiencyScore * 100).toFixed(1)}%** | Avg / P95 Latency: **${metrics.avgLatencyMs}ms / ${metrics.p95LatencyMs}ms** | Avg Queue Wait: **${metrics.avgQueueWaitMs}ms**`,
  );
  lines.push('');

  // Strictly separated cost & hardware utilization accounting
  lines.push('### Strictly Separated Cost & Utilization Accounting');
  lines.push(
    `1. **Hosted Cloud Provider Cost (USD)**: **$${costs.cloudProviderCostUsd.toFixed(4)}** _(actual cloud spend; never invented for local hardware)_`,
  );
  const localHostEntries = Object.entries(costs.localHardwareUtilizationPct);
  const localUtilText =
    localHostEntries.length > 0
      ? localHostEntries.map(([h, pct]) => `\`${h}\`: ${pct.toFixed(1)}%`).join(', ')
      : 'no active GPU telemetry recorded';
  lines.push(
    `2. **Sovereign Local Hardware Utilization ($0.00 API Cost)**: ${localUtilText} | Sovereign Completion Share: **${costs.sovereignLocalCompletionSharePct.toFixed(1)}%**`,
  );
  lines.push(
    `3. **Operational Coordinator Overhead**: **${costs.operationalOverheadMs}ms** _(discovery, probing, queue scheduling, verification)_`,
  );
  lines.push('');

  if (metrics.byPoolAndModel.length > 0) {
    lines.push('### Observed Model & Pool Performance');
    lines.push(
      '| Pool | Model | Residency | Verified Success | Avg / P95 Latency | Speed (tok/s) | Queue Wait | Cloud Spend |',
    );
    lines.push(
      '| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |',
    );
    for (const m of metrics.byPoolAndModel) {
      const tokStr = m.avgTokensPerSecond !== undefined ? `${m.avgTokensPerSecond.toFixed(1)}` : '-';
      const spendStr = m.hostId && !m.providerId ? '$0.00 (local)' : `$${m.totalCloudCostUsd.toFixed(4)}`;
      lines.push(
        `| \`${m.poolId}\` | \`${m.modelId}\` | \`${m.residency ?? 'unknown'}\` | ${(m.successRate * 100).toFixed(1)}% (${m.verifiedSuccessCount}/${m.totalRuns}) | ${Math.round(m.avgLatencyMs)} / ${Math.round(m.p95LatencyMs)}ms | ${tokStr} | ${Math.round(m.avgQueueWaitMs)}ms | ${spendStr} |`,
      );
    }
    lines.push('');
  }

  lines.push(`### Verified Execution Improvements (${promoted.length} Promoted, ${rejected.length} Rejected)`);
  if (promoted.length === 0) {
    lines.push('- No new candidate improvements required promotion (current plan meets verified targets).');
  } else {
    for (const item of promoted) {
      lines.push(
        `- [PROMOTED] **${item.title}** — ${item.rationale} -> _${item.expectedGainSummary}_`,
      );
    }
  }

  if (detail && rejected.length > 0) {
    lines.push('');
    lines.push('### Rejected Unverified / Constraint-Blocked Candidates (`--detail`)');
    for (const item of rejected) {
      lines.push(
        `- [${item.verificationStatus}] **${item.title}** — ${item.verificationDetail}`,
      );
    }
  } else if (!detail && rejected.length > 0) {
    lines.push(
      `_Hint: Pass \`--detail\` to inspect ${rejected.length} rejected candidate optimization(s) and constraint checks._`,
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Unified 4-Pillar Overview
// ============================================================================

export interface UnifiedMetaHarnessOverviewInput {
  graph: CapabilityGraph;
  acceptanceRows?: ServerAcceptanceRow[];
  plan?: DeclarativeExecutionPlan;
  quantities?: Record<string, PoolAllocationQuantities> | PoolAllocationQuantities[];
  tasks?: DurableManagedTask[];
  reconciliation?: ReconciliationSnapshot;
  journeys?: UserJourneyResult[] | MandatoryUserJourneysReport;
  acceptanceTests?: AcceptanceTestRecord[];
  faults?: FaultScenarioResult[] | ControlledFaultInjectionReport;
  repairs?: AutonomousRepairRecord[];
  metrics?: ObservedExecutionMetrics;
  recommendations?: CandidateExecutionImprovement[];
}

export function renderUnifiedMetaHarnessOverview(
  input: UnifiedMetaHarnessOverviewInput,
  opts: ProgressiveViewOptions = {},
): string {
  const detail = opts.detail === true;
  if (detail) {
    const sections: string[] = ['# Wazir Meta-Harness — Full 4-Pillar Detailed Report', ''];
    sections.push(renderInfrastructureView(input.graph, input.acceptanceRows ?? [], opts));
    if (input.plan && input.quantities) {
      sections.push('');
      sections.push(
        renderExecutionView(input.plan, input.quantities, input.tasks ?? [], input.reconciliation, opts),
      );
    }
    if (input.journeys) {
      sections.push('');
      sections.push(
        renderQualificationView(
          input.journeys,
          input.acceptanceTests ?? [],
          input.faults ?? [],
          input.repairs ?? [],
          opts,
        ),
      );
    }
    if (input.metrics) {
      sections.push('');
      sections.push(
        renderOptimizationView(
          input.metrics,
          input.recommendations ?? [],
          input.metrics.costBreakdown,
          opts,
        ),
      );
    }
    return sections.join('\n');
  }

  // Concise task-oriented overview with progressive disclosure hints
  const hostIds = Object.keys(input.graph.hosts);
  const rows = input.acceptanceRows ?? [];
  const acceptingPools = rows.filter((r) => isAcceptingRequests(r.status)).map((r) => r.pool);
  const unavailablePools = rows
    .filter((r) => !isAcceptingRequests(r.status) && r.status !== 'DISABLED_BY_POLICY')
    .map((r) => `${r.pool}(${r.status})`);

  const quantList: PoolAllocationQuantities[] = input.quantities
    ? Array.isArray(input.quantities)
      ? input.quantities
      : Object.values(input.quantities)
    : [];
  const totalRunning = quantList.reduce((a, q) => a + q.runningAgents, 0);
  const totalQueued = quantList.reduce((a, q) => a + q.queuedAgents, 0);
  const totalCompleted = quantList.reduce((a, q) => a + q.completedAgents, 0);

  const journeysList = input.journeys
    ? Array.isArray(input.journeys)
      ? input.journeys
      : input.journeys.journeys
    : [];
  const journeysSummary =
    journeysList.length > 0
      ? `${journeysList.filter((j) => j.passed).length}/${journeysList.length} journeys passed`
      : 'pending live qualification';

  const optSummary = input.metrics
    ? `${(input.metrics.overallVerifiedSuccessRate * 100).toFixed(1)}% verified success | Cloud=$${input.metrics.costBreakdown.cloudProviderCostUsd.toFixed(4)} | Sovereign Local=${input.metrics.costBreakdown.sovereignLocalCompletionSharePct.toFixed(1)}% | ${(input.recommendations ?? []).filter((r) => r.promoted).length} promoted optimizations`
    : 'no telemetry recorded yet';

  return [
    '# Wazir Meta-Harness Overview',
    '',
    `- **1. Infrastructure**: ${hostIds.length} physical host(s) (\`${hostIds.join('`, `') || 'none'}\`) | Accepting pools: \`${acceptingPools.join('`, `') || 'none'}\`${unavailablePools.length > 0 ? ` | Not accepting: \`${unavailablePools.join('`, `')}\`` : ''} | \`claude=0% (DISABLED_BY_POLICY)\``,
    `- **2. Execution**: Plan \`${input.plan?.metadata.name ?? 'unconfigured'}\` | Running=${totalRunning}, Queued=${totalQueued}, Verified Completed=${totalCompleted}`,
    `- **3. Qualification**: ${journeysSummary}`,
    `- **4. Optimization**: ${optSummary}`,
    '',
    '_Progressive Disclosure: Inspect `infrastructure`, `execution`, `qualification`, or `optimization` views individually, or pass `--detail` for full hardware, lease, fault-injection, and cost tables._',
  ].join('\n');
}
