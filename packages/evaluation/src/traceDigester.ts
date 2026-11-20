import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface RawTraceStep {
  stepIndex: number;
  toolName?: string;
  error?: string;
  outputPreview?: string;
  tokensUsed?: number;
}

export interface RawExecutionTrace {
  candidateId: string;
  taskId: string;
  passed: boolean;
  totalTokens: number;
  traceFilePath: string;
  steps: RawTraceStep[];
}

export interface TraceRootCauseCluster {
  clusterId: string;
  pattern: string;
  count: number;
  linkedTraces: Array<{ taskId: string; traceFilePath: string; stepIndex: number }>;
}

/**
 * Progressive-disclosure trace digester (AHE Agent Debugger / HarnessX AEGIS):
 * compiles raw multi-task execution traces into a compact `analysis/overview.md`
 * where every diagnostic claim links back to the exact step-level raw trace file.
 */
export class TraceDigester {
  clusterFailures(traces: RawExecutionTrace[]): TraceRootCauseCluster[] {
    const groups = new Map<string, TraceRootCauseCluster>();

    for (const trace of traces) {
      if (trace.passed) continue;
      const errStep = [...trace.steps].reverse().find((s) => Boolean(s.error)) ?? trace.steps[trace.steps.length - 1];
      const pattern = (errStep?.error ?? 'unknown_failure').split('\n')[0].slice(0, 120);
      let cluster = groups.get(pattern);
      if (!cluster) {
        cluster = {
          clusterId: `rc-${groups.size + 1}`,
          pattern,
          count: 0,
          linkedTraces: [],
        };
        groups.set(pattern, cluster);
      }
      cluster.count += 1;
      cluster.linkedTraces.push({
        taskId: trace.taskId,
        traceFilePath: trace.traceFilePath,
        stepIndex: errStep?.stepIndex ?? 0,
      });
    }

    return [...groups.values()].sort((a, b) => b.count - a.count);
  }

  compileOverviewMarkdown(candidateId: string, traces: RawExecutionTrace[]): string {
    const passed = traces.filter((t) => t.passed).length;
    const clusters = this.clusterFailures(traces);
    const lines: string[] = [
      `# Trace Digest — Candidate ${candidateId}`,
      ``,
      `- Total tasks: ${traces.length}`,
      `- Passed: ${passed}/${traces.length}`,
      `- Failure clusters: ${clusters.length}`,
      ``,
      `## Root-Cause Clusters`,
    ];

    for (const c of clusters) {
      lines.push(`### ${c.clusterId}: \`${c.pattern}\` (${c.count} task(s))`);
      for (const link of c.linkedTraces) {
        lines.push(`- Task \`${link.taskId}\` -> [${path.basename(link.traceFilePath)}#step-${link.stepIndex}](${link.traceFilePath})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  writeDigestWorkspace(outputDir: string, candidateId: string, traces: RawExecutionTrace[]): string {
    const analysisDir = path.join(outputDir, 'analysis');
    if (!existsSync(analysisDir)) mkdirSync(analysisDir, { recursive: true });
    const overviewPath = path.join(analysisDir, 'overview.md');
    writeFileSync(overviewPath, this.compileOverviewMarkdown(candidateId, traces), 'utf8');
    return overviewPath;
  }
}
