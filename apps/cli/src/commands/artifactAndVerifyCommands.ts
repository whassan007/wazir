import type { ArtifactProvenance, ArtifactType } from '@wazir/core';
import type {
  TelemetryMetricSnapshot,
  MetricBaseline,
  VerificationResult,
} from '@wazir/evaluation';
import {
  verifyExecution,
  createBaseline,
  clusterLogLines,
} from '@wazir/evaluation';
import type { RookEngine } from '../engine.js';
import { color } from '../colors.js';
import { table } from './formatters.js';

export interface ArtifactListOptions {
  execution?: string;
  job?: string;
  type?: string;
  json?: boolean;
}

export async function listArtifacts(engine: RookEngine, options: ArtifactListOptions = {}): Promise<string> {
  const artifacts = await engine.provenance.listArtifacts({
    executionId: options.execution,
    jobId: options.job,
    type: options.type as ArtifactType | undefined,
  });
  if (artifacts.length === 0) {
    return options.json ? JSON.stringify([], null, 2) : color.yellow('no artifacts registered');
  }

  if (options.json) {
    return JSON.stringify(artifacts, null, 2);
  }

  const rows = artifacts.map((a) => [
    a.artifactId,
    a.type,
    a.name,
    a.location,
    a.contentHash.slice(0, 12),
    a.executionId,
    a.jobId ?? '-',
  ]);
  return table(['id', 'type', 'name', 'location', 'hash', 'execution', 'job'], rows);
}

export function artifactNotFound(id: string, json?: boolean): string {
  return json ? JSON.stringify({ error: `artifact not found: ${id}` }) : color.red(`artifact not found: ${id}`);
}

export async function inspectArtifact(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  if (json) return JSON.stringify(artifact, null, 2);

  const lines: string[] = [];
  lines.push(color.bold('Artifact'));
  lines.push(`  id:          ${artifact.artifactId}`);
  lines.push(`  type:        ${artifact.type}`);
  lines.push(`  name:        ${artifact.name}`);
  lines.push(`  location:    ${artifact.location}`);
  lines.push(`  hash:        sha256:${artifact.contentHash}`);
  lines.push(`  size:        ${artifact.sizeBytes} bytes`);
  lines.push(`  created:     ${new Date(artifact.createdAt).toISOString()}`);
  lines.push(`  workspace:   ${artifact.workspace}`);
  lines.push(color.bold('  execution'));
  lines.push(`    execution: ${artifact.executionId}`);
  lines.push(`    job:       ${artifact.jobId ?? '-'}`);
  lines.push(`    agent:     ${artifact.agentId || '-'}`);
  lines.push(`    model:     ${artifact.modelId}`);
  lines.push(`    runtime:   ${artifact.runtimeId}`);
  lines.push(`    computer:  ${artifact.computerId ?? '—'}`);
  if (artifact.git) {
    lines.push(color.bold('  git'));
    lines.push(`    branch:    ${artifact.git.branch ?? '-'}`);
    lines.push(`    commit:    ${artifact.git.commit ?? '-'}`);
    lines.push(`    dirty:     ${artifact.git.dirty}`);
  }
  lines.push(`  tools:       ${artifact.toolsUsed.join(', ') || '-'}`);
  lines.push(`  policies:    ${artifact.policyDecisions.join(', ') || '-'}`);
  lines.push(`  evaluations: ${artifact.evaluations.join(', ') || '-'}`);
  lines.push(`  inputs:      ${artifact.inputArtifactIds.join(', ') || '-'}`);
  lines.push(`  parents:     ${artifact.parentArtifactIds.join(', ') || '-'}`);
  return lines.join('\n');
}

export async function showArtifactLineage(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  const lineage = await engine.provenance.getLineage(id);
  if (json) return JSON.stringify(lineage, null, 2);

  const lines: string[] = [color.bold('Artifact Lineage (root → target)')];
  lineage.forEach((node, i) => {
    lines.push(`${'  '.repeat(i)}${i === 0 ? '' : '└─ '}${node.artifactId}  ${color.dim(`${node.type} ${node.name}`)}`);
  });
  return lines.join('\n');
}

export async function showArtifactWhy(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  const why = await engine.provenance.getWhy(id);
  if (json) return JSON.stringify(why, null, 2);

  const lines: string[] = [color.bold('Why this artifact exists')];
  lines.push(`  execution: ${why.executionContext.executionId}`);
  lines.push(`  job:       ${why.executionContext.jobId ?? '-'}`);
  lines.push(`  agent:     ${why.executionContext.agentId || '-'}`);
  lines.push(`  model:     ${why.executionContext.modelId}`);
  lines.push(`  computer:  ${why.executionContext.computerId ?? '—'}`);
  lines.push(color.bold('  policy decisions'));
  if (why.policyDecisions.length === 0) lines.push('    (none recorded)');
  for (const d of why.policyDecisions) lines.push(`    ${d.decision.padEnd(5)} ${d.rule}  ${color.dim(d.reason)}`);
  lines.push(color.bold('  checks'));
  if (why.checks.length === 0) lines.push('    (none recorded)');
  for (const c of why.checks) lines.push(`    ${c.status.padEnd(6)} ${c.name}${c.details ? `  ${color.dim(c.details)}` : ''}`);
  if (why.modelRationale) {
    lines.push(color.bold('  model rationale'));
    for (const step of why.modelRationale.reasoningSteps) lines.push(`    - ${step}`);
  }
  return lines.join('\n');
}

export async function showArtifactInputs(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  const inputs = (
    await Promise.all(artifact.inputArtifactIds.map((inputId) => engine.provenance.getProvenance(inputId)))
  ).filter((a): a is ArtifactProvenance => a !== undefined);
  if (json) return JSON.stringify(inputs, null, 2);
  if (inputs.length === 0) return color.yellow('no input artifacts recorded');
  return table(
    ['id', 'type', 'name', 'location'],
    inputs.map((a) => [a.artifactId, a.type, a.name, a.location]),
  );
}

// ---- verify commands (Phase 1: Continuous Verification & Anomaly Rollback Engine) ----

export type VerifySensitivity = 'high' | 'medium' | 'low';

/**
 * Run verification on an execution with anomaly detection and rollback.
 */
export async function verifyRunCommand(
  engine: RookEngine,
  executionId: string,
  options?: { sensitivity?: VerifySensitivity; baselineName?: string },
): Promise<{ code: number; output: string }> {
  const record = await engine.executions.get(executionId);
  if (!record) {
    return { code: 1, output: color.red(`execution '${executionId}' not found`) };
  }

  // Get telemetry snapshot from execution
  const telemetry: TelemetryMetricSnapshot = {
    timestamp: record.execution.createdAt.toISOString(),
    durationMs: record.execution.completedAt
      ? record.execution.completedAt.getTime() - (record.execution.startedAt ?? record.execution.createdAt).getTime()
      : Date.now() - record.execution.createdAt.getTime(),
    cpuPercent: 0, // TODO: extract from worker hardware report if available
    memoryBytes: 0, // TODO: extract from worker hardware report if available
    errorCount: record.errors.length,
    exitCode: 0, // TODO: extract from execution result
  };

  // Get baselines (from store or create fresh)
  const baselineName = options?.baselineName ?? `default/${record.execution.modelId}`;
  const baselines = new Map<string, MetricBaseline>();

  try {
    const storedBaseline = await engine.store?.get(`verification/baseline/${baselineName}`);
    if (storedBaseline) {
      // Reconstruct baselines from stored data
      for (const [name, b] of Object.entries(storedBaseline as Record<string, any>)) {
        baselines.set(name, {
          metricName: name,
          mean: b.mean,
          stdDev: b.stdDev,
          sampleCount: b.sampleCount,
          p95: b.p95,
        });
      }
    } else if (record.execution.completedAt && telemetry.durationMs > 0) {
      // Create baseline from this execution for future comparisons
      const durationBaseline = createBaseline([telemetry.durationMs]);
      baselines.set('durationMs', durationBaseline);
    }
  } catch {
    // Use empty baselines if store access fails
  }

  // Collect logs (stdout + stderr)
  const allLogs: string[] = [];
  if (record.execution.status === 'failed' || record.errors.length > 0) {
    for (const err of record.errors) {
      allLogs.push(err);
    }
  }

  // Get baseline log signatures from store
  const storedSignatures = await engine.store?.get(`verification/signatures/${baselineName}`);
  const baselineLogSignatures = new Set<string>(
    (storedSignatures as string[]) ?? [],
  );

  // Run verification
  const result: VerificationResult = verifyExecution(
    telemetry,
    baselines,
    allLogs,
    baselineLogSignatures,
    options?.sensitivity ?? 'medium',
  );

  // If rollback is triggered, execute it
  if (result.rollbackTriggered) {
    try {
      // TODO: Implement worktree rollback via WorktreeManager
      // const worktreePath = getWorktreeForExecution(engine, executionId);
      // await engine.worktrees.rollback(worktreePath);
      result.rollbackReason = `rollback triggered for ${executionId}`;
    } catch (err) {
      result.rollbackReason = `rollback failed: ${String(err)}`;
    }
  }

  // Store new baseline if verification passed and we have good data
  if (result.passed && telemetry.durationMs > 0) {
    const durationBaseline = createBaseline([telemetry.durationMs]);
    baselines.set('durationMs', durationBaseline);
    try {
      await engine.store?.put(
        `verification/baseline/${baselineName}`,
        Object.fromEntries(baselines),
      );
      // Store normalized log signatures
      const clusters = clusterLogLines(allLogs);
      const newSignatures = Array.from(clusters.keys());
      await engine.store?.put(
        `verification/signatures/${baselineName}`,
        [...baselineLogSignatures, ...newSignatures],
      );
    } catch {
      // Best effort store
    }
  }

  const lines: string[] = [];
  lines.push(color.bold(`Verification Result for ${executionId}`));
  lines.push('');

  if (result.passed) {
    lines.push(color.green(`  ✓ PASSED (score: ${(result.score * 100).toFixed(1)}%)`));
  } else {
    lines.push(color.red(`  ✗ FAILED (score: ${(result.score * 100).toFixed(1)}%)`));
  }

  if (result.anomalies.length > 0) {
    lines.push('');
    lines.push(color.bold(`  Anomalies (${result.anomalies.length}):`));
    for (const anomaly of result.anomalies) {
      const severityColor =
        anomaly.severity === 'critical' ? color.red :
        anomaly.severity === 'high' ? color.yellow :
        anomaly.severity === 'medium' ? color.gray : color.blue;
      lines.push(`    ${severityColor(anomaly.severity.toUpperCase())}: ${anomaly.metricName}`);
      lines.push(color.gray(`      observed: ${anomaly.observedValue}, baseline: ${anomaly.baselineMean}, sigma: ${anomaly.sigmaDeviation.toFixed(2)}`));
    }
  } else {
    lines.push('');
    lines.push(color.green('  No anomalies detected'));
  }

  if (result.rollbackTriggered) {
    lines.push('');
    lines.push(color.yellow(`  Rollback triggered: ${result.rollbackReason}`));
  }

  return { code: result.passed ? 0 : 1, output: lines.join('\n') };
}

/**
 * Show verification baselines for a service/model.
 */
export async function verifyBaselineShowCommand(
  engine: RookEngine,
  options?: { serviceName?: string },
): Promise<{ code: number; output: string }> {
  const baselineName = options?.serviceName ?? 'default';

  try {
    const storedBaseline = await engine.store?.get(`verification/baseline/${baselineName}`);
    if (!storedBaseline) {
      return { code: 1, output: color.yellow(`no baseline found for '${baselineName}'`) };
    }

    const lines: string[] = [color.bold(`Baseline: ${baselineName}`), ''];

    for (const [name, b] of Object.entries(storedBaseline as Record<string, any>)) {
      lines.push(color.bold(`  ${name}:`));
      lines.push(`    mean:       ${b.mean.toFixed(2)}`);
      lines.push(`    std dev:    ${b.stdDev.toFixed(2)}`);
      lines.push(`    sample cnt: ${b.sampleCount}`);
      lines.push(`    p95:        ${b.p95.toFixed(2)}`);
      lines.push('');
    }

    return { code: 0, output: lines.join('\n') };
  } catch {
    return { code: 1, output: color.red(`failed to load baseline for '${baselineName}'`) };
  }
}

/**
 * Show verification status for a job.
 */
export async function verifyStatusCommand(
  engine: RookEngine,
  jobId: string,
): Promise<{ code: number; output: string }> {
  const job = engine.orchestrator.getJob(jobId);
  if (!job) {
    return { code: 1, output: color.red(`job '${jobId}' not found`) };
  }

  // Check verification status for each task execution
  const results: { taskId: string; passed: boolean; score?: number }[] = [];

  for (const task of job.tasks) {
    const records = await engine.executions.listByTask(task.id);
    if (records.length > 0) {
      // Use the latest execution
      const record = records[records.length - 1];
      results.push({
        taskId: task.id,
        passed: record.evaluation?.success ?? false,
        score: record.evaluation ? 1.0 : undefined, // TODO: calculate from anomalies
      });
    }
  }

  const lines: string[] = [color.bold(`Job Verification Status: ${jobId}`), ''];

  if (results.length === 0) {
    lines.push(color.yellow('  No executions found for verification'));
  } else {
    let allPassedFlag = true;
    for (const r of results) {
      const statusColor = r.passed ? color.green : color.red;
      lines.push(`  ${statusColor(r.passed ? '✓' : '✗')} ${r.taskId}`);
      if (!r.passed) allPassedFlag = false;
    }

    lines.push('');
    const summaryColor = allPassedFlag ? color.green : color.red;
    lines.push(summaryColor(`  Overall: ${allPassedFlag ? 'VERIFIED' : 'FAILED'}`));
  }

  return { code: allPassed(results) ? 0 : 1, output: lines.join('\n') };
}

function allPassed(results: { passed: boolean }[]): boolean {
  return results.every((r) => r.passed);
}

export async function checkpointCommand(
  engine: RookEngine,
  executionId: string,
  options?: { desc?: string; json?: boolean },
): Promise<string> {
  try {
    const chk = await engine.checkpoints.checkpoint(executionId, {
      description: options?.desc,
    });
    if (options?.json) {
      return JSON.stringify(chk, null, 2);
    }
    return [
      color.green(`✓ Checkpoint created: ${chk.id}`),
      `  Execution: ${chk.executionId}`,
      `  Workspace Revision: R${chk.workspaceRevision}`,
      `  Files Snapshot: ${Object.keys(chk.worktreeState.filesSnapshot).length} files`,
    ].join('\n');
  } catch (err) {
    if (options?.json) {
      return JSON.stringify({ ok: false, error: String(err) }, null, 2);
    }
    return color.red(`Failed to create checkpoint: ${String(err)}`);
  }
}

export async function forkCommand(
  engine: RookEngine,
  checkpointId: string,
  options?: { forkId?: string; json?: boolean },
): Promise<string> {
  try {
    const res = await engine.checkpoints.fork(checkpointId, options?.forkId);
    if (options?.json) {
      return JSON.stringify(res, null, 2);
    }
    return [
      color.green(`✓ Forked execution: ${res.forkedExecutionId}`),
      `  Parent: ${res.parentExecutionId}`,
      `  Checkpoint: ${res.checkpointId}`,
      `  Branch: ${res.branch}`,
      `  Worktree: ${res.forkedWorktreePath}`,
      `  Revision: R${res.workspaceRevision}`,
    ].join('\n');
  } catch (err) {
    if (options?.json) {
      return JSON.stringify({ ok: false, error: String(err) }, null, 2);
    }
    return color.red(`Failed to fork execution: ${String(err)}`);
  }
}

export async function rollbackCommand(
  engine: RookEngine,
  executionId: string,
  checkpointId: string,
  options?: { json?: boolean },
): Promise<string> {
  try {
    const res = await engine.checkpoints.rollback(executionId, checkpointId);
    if (options?.json) {
      return JSON.stringify(res, null, 2);
    }
    return [
      color.green(`✓ Rollback completed: ${executionId}`),
      `  Restored Checkpoint: ${res.checkpointId}`,
      `  Restored Revision: R${res.restoredRevision}`,
      `  Files Restored: ${res.filesRestored.length}`,
    ].join('\n');
  } catch (err) {
    if (options?.json) {
      return JSON.stringify({ ok: false, error: String(err) }, null, 2);
    }
    return color.red(`Failed to rollback: ${String(err)}`);
  }
}
