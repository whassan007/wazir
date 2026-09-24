import { randomUUID } from 'node:crypto';
import type {
  ExecutionRecord,
  ObservationWindow,
  ImprovementOpportunity,
  OpportunityCategory,
  SelfImprovementDomain,
  MutationMemoryRecord,
} from '@wazir/core';
import type { CausalAttributionService } from './causalAttributionService.js';

export interface OpportunityDetectorOptions {
  minExecutionsThreshold?: number; // Minimum number of executions required to claim repeated pattern (default 3)
  highRepairRateThreshold?: number; // Average repair cycles threshold (default 2.0)
  highContextTokensThreshold?: number; // Tokens threshold (default 60_000)
  highToolFailureRateThreshold?: number; // Tool failure percentage threshold (default 0.15)
  highMalformedActionRateThreshold?: number; // Malformed action percentage threshold (default 0.10)
  causalService?: CausalAttributionService;
}

export class OpportunityDetector {
  private readonly minExecutions: number;
  private readonly highRepairRate: number;
  private readonly highContextTokens: number;
  private readonly highToolFailureRate: number;
  private readonly highMalformedActionRate: number;
  private causalService?: CausalAttributionService;

  constructor(options: OpportunityDetectorOptions = {}) {
    this.minExecutions = options.minExecutionsThreshold ?? 3;
    this.highRepairRate = options.highRepairRateThreshold ?? 2.0;
    this.highContextTokens = options.highContextTokensThreshold ?? 60_000;
    this.highToolFailureRate = options.highToolFailureRateThreshold ?? 0.15;
    this.highMalformedActionRate = options.highMalformedActionRateThreshold ?? 0.10;
    this.causalService = options.causalService;
  }

  public setCausalService(causalService: CausalAttributionService): void {
    this.causalService = causalService;
  }

  public getCausalService(): CausalAttributionService | undefined {
    return this.causalService;
  }

  public getMutationRecords(): MutationMemoryRecord[] {
    return this.causalService ? this.causalService.listMutationRecords() : [];
  }

  public getBeneficialMutations(): MutationMemoryRecord[] {
    return this.getMutationRecords().filter(
      (r) => r.lastObservedVerdict === 'SUPPORTED_CONTRIBUTOR',
    );
  }

  public getHarmfulMutations(): MutationMemoryRecord[] {
    return this.getMutationRecords().filter(
      (r) => r.lastObservedVerdict === 'NEGATIVE_CONTRIBUTOR',
    );
  }

  public getInteractions(): MutationMemoryRecord[] {
    return this.getMutationRecords().filter(
      (r) => r.lastObservedVerdict === 'INTERACTION_DETECTED' || r.interactionPartners.length > 0,
    );
  }

  public isKnownHarmful(target: string): boolean {
    return this.causalService ? this.causalService.isKnownHarmful(target) : false;
  }

  /**
   * Analyzes an ObservationWindow to detect statistically grounded improvement opportunities.
   * Enforces WAZIR INVARIANTS:
   * - Never optimize based on a single anecdotal failure.
   * - Look for repeated, measurable patterns across the window.
   */
  public detect(window: ObservationWindow): ImprovementOpportunity[] {
    const executions = window.executions ?? [];
    if (executions.length === 0) {
      return [];
    }

    const opportunities: ImprovementOpportunity[] = [];

    // 1. Detect HIGH_REPAIR_RATE
    const repairOpportunity = this.checkRepairRate(executions);
    if (repairOpportunity) opportunities.push(repairOpportunity);

    // 2. Detect HIGH_PROTOCOL_FAILURE_RATE (malformed actions)
    const protocolOpportunity = this.checkProtocolFailures(executions);
    if (protocolOpportunity) opportunities.push(protocolOpportunity);

    // 3. Detect HIGH_CONTEXT_GROWTH / PEAK_CONTEXT
    const contextOpportunity = this.checkContextGrowth(executions);
    if (contextOpportunity) opportunities.push(contextOpportunity);

    // 4. Detect HIGH_TOOL_RETRY_RATE / TOOL_FAILURES
    const toolOpportunity = this.checkToolFailures(executions);
    if (toolOpportunity) opportunities.push(toolOpportunity);

    // 5. Detect ROUTING_UNDERPERFORMANCE / MODEL_SPECIALIZATION
    const routingOpportunity = this.checkRoutingPerformance(executions);
    if (routingOpportunity) opportunities.push(routingOpportunity);

    // 6. Detect EXCESSIVE_MODEL_CALLS
    const modelCallsOpportunity = this.checkModelCalls(executions);
    if (modelCallsOpportunity) opportunities.push(modelCallsOpportunity);

    // 7. Detect REPEATED_BUILD_FAILURE
    const buildFailureOpportunity = this.checkRepeatedBuildFailures(executions);
    if (buildFailureOpportunity) opportunities.push(buildFailureOpportunity);

    return opportunities;
  }

  private checkRepairRate(executions: ExecutionRecord[]): ImprovementOpportunity | null {
    let totalRepairs = 0;
    let highRepairCount = 0;

    for (const exec of executions) {
      const repairCount = this.extractRepairCycles(exec);
      totalRepairs += repairCount;
      if (repairCount >= this.highRepairRate) {
        highRepairCount++;
      }
    }

    const avgRepairs = totalRepairs / executions.length;
    if (highRepairCount >= Math.min(this.minExecutions, executions.length) && avgRepairs >= 1.5) {
      return {
        id: `opp-repair-${randomUUID().slice(0, 8)}`,
        category: 'HIGH_REPAIR_RATE',
        component: 'CodingAgent',
        domain: 'prompts',
        observation: `Repetitive compile/test repair cycles observed across ${highRepairCount} executions (average ${avgRepairs.toFixed(1)} cycles)`,
        evidence: highRepairCount,
        evidenceDetails: {
          totalExecutions: executions.length,
          highRepairExecutions: highRepairCount,
          averageRepairCycles: avgRepairs,
        },
        suspectedCause: 'Ambiguous diagnostic reporting and lack of explicit self-verification constraints in repair prompt',
        metric: 'repair_cycles',
        baseline: avgRepairs,
        detectedAt: new Date(),
      };
    }

    return null;
  }

  private checkProtocolFailures(executions: ExecutionRecord[]): ImprovementOpportunity | null {
    let malformedCount = 0;
    let totalActions = 0;

    for (const exec of executions) {
      const calls = exec.toolCalls ?? [];
      totalActions += calls.length;
      for (const call of calls) {
        if (call.error?.includes('validation') || call.error?.includes('malformed') || call.error?.includes('SCHEMA')) {
          malformedCount++;
        }
      }
      for (const err of exec.errors ?? []) {
        if (err.includes('protocol') || err.includes('malformed') || err.includes('SCHEMA')) {
          malformedCount++;
        }
      }
    }

    if (totalActions > 0) {
      const rate = malformedCount / totalActions;
      if (rate >= this.highMalformedActionRate && malformedCount >= 2) {
        return {
          id: `opp-proto-${randomUUID().slice(0, 8)}`,
          category: 'HIGH_PROTOCOL_FAILURE_RATE',
          component: 'ToolSurfaceCompiler',
          domain: 'tool_surfaces',
          observation: `${(rate * 100).toFixed(1)}% of tool actions violate schema or protocol format (${malformedCount}/${totalActions} actions)`,
          evidence: malformedCount,
          evidenceDetails: {
            totalActions,
            malformedActions: malformedCount,
            rate,
          },
          suspectedCause: 'Tool schema complexity and exposing phase-irrelevant tools increases model action synthesis errors',
          metric: 'malformed_actions',
          baseline: malformedCount,
          detectedAt: new Date(),
        };
      }
    }

    return null;
  }

  private checkContextGrowth(executions: ExecutionRecord[]): ImprovementOpportunity | null {
    let peakTokensFound = 0;
    let highContextCount = 0;

    for (const exec of executions) {
      const usage = exec.usage as { input?: number; inputTokens?: number } | undefined;
      const inputTokens = usage?.input ?? usage?.inputTokens ?? 0;
      if (inputTokens > peakTokensFound) {
        peakTokensFound = inputTokens;
      }
      if (inputTokens >= this.highContextTokens) {
        highContextCount++;
      }
    }

    if (highContextCount >= Math.min(this.minExecutions, executions.length)) {
      return {
        id: `opp-ctx-${randomUUID().slice(0, 8)}`,
        category: 'HIGH_CONTEXT_GROWTH',
        component: 'ContextCompiler',
        domain: 'context_policy',
        observation: `Active context exceeds ${(this.highContextTokens / 1000).toFixed(0)}K tokens in ${highContextCount} executions (peak ${peakTokensFound} tokens)`,
        evidence: highContextCount,
        evidenceDetails: {
          totalExecutions: executions.length,
          highContextExecutions: highContextCount,
          peakTokens: peakTokensFound,
        },
        suspectedCause: 'Superseded file snapshots and repetitive observations retained across multiple turn revisions',
        metric: 'peak_context_tokens',
        baseline: peakTokensFound,
        detectedAt: new Date(),
      };
    }

    return null;
  }

  private checkToolFailures(executions: ExecutionRecord[]): ImprovementOpportunity | null {
    let failedTools = 0;
    let totalTools = 0;

    for (const exec of executions) {
      const calls = exec.toolCalls ?? [];
      totalTools += calls.length;
      for (const call of calls) {
        if (call.exitCode !== undefined && call.exitCode !== 0) {
          failedTools++;
        } else if (call.error) {
          failedTools++;
        }
      }
    }

    if (totalTools > 0) {
      const failureRate = failedTools / totalTools;
      if (failureRate >= this.highToolFailureRate && failedTools >= 3) {
        return {
          id: `opp-tool-${randomUUID().slice(0, 8)}`,
          category: 'HIGH_TOOL_RETRY_RATE',
          component: 'ToolRegistry',
          domain: 'tool_surfaces',
          observation: `Tool invocation failure rate is ${(failureRate * 100).toFixed(1)}% (${failedTools}/${totalTools} tool calls failed)`,
          evidence: failedTools,
          evidenceDetails: {
            totalToolCalls: totalTools,
            failedToolCalls: failedTools,
            failureRate,
          },
          suspectedCause: 'Tools invoked with incorrect file paths or uncontainment parameters, triggering repeated retry loops',
          metric: 'tool_failures',
          baseline: failedTools,
          detectedAt: new Date(),
        };
      }
    }

    return null;
  }

  private checkRoutingPerformance(executions: ExecutionRecord[]): ImprovementOpportunity | null {
    const modelStats = new Map<string, { total: number; success: number }>();

    for (const exec of executions) {
      const modelId = exec.execution?.modelId;
      if (!modelId) continue;

      const current = modelStats.get(modelId) ?? { total: 0, success: 0 };
      current.total++;
      if (exec.execution.status === 'completed' && (!exec.errors || exec.errors.length === 0)) {
        current.success++;
      }
      modelStats.set(modelId, current);
    }

    for (const [modelId, stats] of modelStats.entries()) {
      if (stats.total >= this.minExecutions) {
        const passRate = stats.success / stats.total;
        if (passRate < 0.6) {
          return {
            id: `opp-route-${randomUUID().slice(0, 8)}`,
            category: 'ROUTING_UNDERPERFORMANCE',
            component: 'Scheduler',
            domain: 'routing',
            observation: `Model '${modelId}' exhibits low task success rate of ${(passRate * 100).toFixed(1)}% across ${stats.total} executions`,
            evidence: stats.total,
            evidenceDetails: {
              modelId,
              totalExecutions: stats.total,
              successfulExecutions: stats.success,
              passRate,
            },
            suspectedCause: 'Suboptimal capability matching for coding repair or complex tasks; routing rules need phase specialization',
            metric: 'task_success',
            baseline: passRate,
            detectedAt: new Date(),
          };
        }
      }
    }

    return null;
  }

  private checkModelCalls(executions: ExecutionRecord[]): ImprovementOpportunity | null {
    let totalModelCalls = 0;
    let highCallCount = 0;

    for (const exec of executions) {
      const calls = (exec.events ?? []).filter((e) => (e.eventType ?? e.type) === 'model.response.completed').length || 1;
      totalModelCalls += calls;
      if (calls > 20) {
        highCallCount++;
      }
    }

    const avgCalls = totalModelCalls / executions.length;
    if (avgCalls > 15 && highCallCount >= Math.min(this.minExecutions, executions.length)) {
      return {
        id: `opp-calls-${randomUUID().slice(0, 8)}`,
        category: 'EXCESSIVE_MODEL_CALLS',
        component: 'CodingAgent',
        domain: 'prompts',
        observation: `Tasks average ${avgCalls.toFixed(1)} model calls, exceeding recommended efficiency limits in ${highCallCount} runs`,
        evidence: highCallCount,
        evidenceDetails: {
          totalExecutions: executions.length,
          highCallExecutions: highCallCount,
          averageModelCalls: avgCalls,
        },
        suspectedCause: 'Incremental single-line edits and lack of batch planning causing unnecessary model turns',
        metric: 'model_calls',
        baseline: avgCalls,
        detectedAt: new Date(),
      };
    }

    return null;
  }

  private checkRepeatedBuildFailures(executions: ExecutionRecord[]): ImprovementOpportunity | null {
    let executionsWithRepeatedBuildFails = 0;

    for (const exec of executions) {
      const buildChecks = (exec.checks ?? []).filter((c) => c.name === 'build');
      const failedBuilds = buildChecks.filter((c) => !c.ok);
      if (failedBuilds.length >= 2) {
        executionsWithRepeatedBuildFails++;
      }
    }

    if (executionsWithRepeatedBuildFails >= Math.min(this.minExecutions, executions.length)) {
      return {
        id: `opp-build-${randomUUID().slice(0, 8)}`,
        category: 'REPEATED_BUILD_FAILURE',
        component: 'VerificationEngine',
        domain: 'wazir_source_code',
        observation: `Multiple consecutive build failures observed in ${executionsWithRepeatedBuildFails} executions before successful compilation or terminal failure`,
        evidence: executionsWithRepeatedBuildFails,
        evidenceDetails: {
          totalExecutions: executions.length,
          executionsWithRepeatedBuildFails,
        },
        suspectedCause: 'Repair guidance fails to isolate syntax errors before compiler execution',
        metric: 'repair_cycles',
        baseline: executionsWithRepeatedBuildFails,
        detectedAt: new Date(),
      };
    }

    return null;
  }

  private extractRepairCycles(record: ExecutionRecord): number {
    const errorSignals = (record.events ?? []).filter(
      (e) => (e.eventType ?? e.type) === 'test.completed' || (e.eventType ?? e.type) === 'check.completed',
    );
    const failedChecks = errorSignals.filter((e) => {
      const d = e.data as { ok?: boolean; exitCode?: number } | undefined;
      return d?.ok === false || (d?.exitCode !== undefined && d.exitCode !== 0);
    });

    return failedChecks.length;
  }
}
