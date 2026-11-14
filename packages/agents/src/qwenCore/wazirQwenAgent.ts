import {
  DEFAULT_STOP_CONDITIONS,
  firstStop,
  type StopCheckpoint,
  type StopCondition,
  type StopDecision,
} from '../stopConditions.js';
import {
  ToolSurfaceCompiler,
  type AgentAdapter,
  type AgentDescriptor,
  type AgentPhase,
  type AgentRunRequest,
  type AgentRunStats,
  type AgentRuntime,
  type AgentTurn,
  type ChatMessage,
  type GroundedResult,
  type ModelProtocolMetrics,
  type ModelRouteChange,
  type TerminationReason,
  type Tool,
  type ToolSurface,
} from '@wazir/core';
import type { CodingAgentOptions } from '../legacyCodingAgent.js';
import {
  isConversationalFastPathRequest,
  isDeterministicCommandRequest,
  resumeBriefing,
} from '../legacyCodingAgent.js';
import { ACTION_START_PATTERN, ModelProtocolAdapter } from '../protocolAdapters.js';
import { buildQwenSystemPrompt } from './systemPrompt.js';
import { runQwenModelTurn, type QwenToolCallRequest } from './turn.js';
import { CoreToolScheduler } from './coreToolScheduler.js';
import { LoopDetectionService } from './loopDetectionService.js';
import { ChatCompressionService } from './chatCompressionService.js';
import { runProportionalVerification } from './proportionalVerify.js';

export class WazirQwenAgent implements AgentAdapter {
  readonly descriptor: AgentDescriptor;

  private readonly maxTurns: number;
  private readonly maxRepairCycles: number;
  private readonly maxTokensPerTurn: number;
  private readonly temperature: number;
  private readonly maxWallClockMs: number;
  private readonly maxToolCalls: number;
  private readonly maxTokens: number;
  private readonly maxNoProgressIterations: number;
  private readonly maxModelEscalations: number;
  private readonly stopConditions: readonly StopCondition[];
  private readonly modelTurnTimeoutMs: number;
  private readonly toolRepeatLimit: number;
  private readonly contextCompactionRatio: number;
  private readonly systemPromptExtra?: string;

  constructor(options: CodingAgentOptions = {}) {
    this.maxTurns = options.maxTurns ?? 30;
    this.maxRepairCycles = options.maxRepairCycles ?? 3;
    this.maxTokensPerTurn = options.maxTokensPerTurn ?? 8192;
    this.temperature = options.temperature ?? 0.1;
    this.maxWallClockMs = options.maxWallClockMs ?? 20 * 60_000;
    this.maxToolCalls = options.maxToolCalls ?? 100;
    this.maxTokens = options.maxTokens ?? 2_000_000;
    this.maxNoProgressIterations = options.maxNoProgressIterations ?? 8;
    this.maxModelEscalations = options.maxModelEscalations ?? 1;
    this.stopConditions = options.stopConditions ?? DEFAULT_STOP_CONDITIONS;
    this.modelTurnTimeoutMs = options.modelTurnTimeoutMs ?? 120_000;
    this.toolRepeatLimit = options.toolRepeatLimit ?? 3;
    this.contextCompactionRatio = options.contextCompactionRatio ?? 0.7;
    this.systemPromptExtra = options.systemPromptExtra;

    this.descriptor = {
      name: 'wazir-coding',
      version: '1.0.0',
      description:
        'Qwen Code 1.0 unified ReAct coding agent with parallel read-only tool scheduling, 3-stage smart edit, context compression, and Wazir policy/verification governance',
      capabilities: ['coding', 'agenticExecution', 'codeAnalysis', ...(options.webCapabilities ?? [])],
      requiredTools: ['read', 'write', 'edit', 'search', 'glob', 'shell', 'git', 'test', 'lint', 'typecheck', 'build'],
      optionalTools: [
        'read_many_files',
        'multi_edit',
        'todo_write',
        'dispatch_subagent',
        ...(options.webCapabilities ?? []).map((c) => c.replace('.', '_')),
      ],
      modelRequirements: { capabilities: ['coding'], minimumContext: 8192 },
      permissions: [
        'filesystem_read',
        'filesystem_write',
        'shell_execute',
        'git_execute',
        'test_run',
        'build_run',
      ],
      taskTypes: [
        'coding',
        'debugging',
        'code_analysis',
        ...(options.webCapabilities?.includes('web.fetch') ? (['research'] as const) : []),
      ],
      strategy: 'qwen-unified-react-verify',
    };
  }

  async *run(request: AgentRunRequest, runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    const statsHolder: { read: () => AgentRunStats } = {
      read: () => ({
        turns: 0,
        toolCalls: 0,
        tokensUsed: 0,
        longestNoProgressStreak: 0,
        duplicateActionsBlocked: 0,
        modelEscalations: 0,
      }),
    };

    for await (const turn of this.runCore(request, runtime, statsHolder)) {
      if (turn.kind === 'done' || turn.kind === 'error') {
        yield { ...turn, runStats: statsHolder.read() };
      } else {
        yield turn;
      }
    }
  }

  private async *runCore(
    request: AgentRunRequest,
    runtime: AgentRuntime,
    statsHolder: { read: () => AgentRunStats },
  ): AsyncIterable<AgentTurn> {
    const maxTurns = request.maxTurns ?? this.maxTurns;
    const maxRepairCycles = request.maxRepairCycles ?? this.maxRepairCycles;
    const maxWallClockMs = request.maxWallClockMs ?? this.maxWallClockMs;
    const maxToolCalls = request.maxToolCalls ?? this.maxToolCalls;
    const maxTokens = request.maxTokens ?? this.maxTokens;
    const maxNoProgressIterations = request.maxNoProgressIterations ?? this.maxNoProgressIterations;
    const maxModelEscalations = request.maxModelEscalations ?? this.maxModelEscalations;
    const runStartedAt = Date.now();

    let currentModelId = request.modelId;
    const triedModelIds: string[] = [request.modelId];
    let escalationsUsed = 0;

    // Tier 0: Zero-LLM-call deterministic command execution (`ls`, `pwd`, `git status`, `git diff`, `git log`)
    const deterministicCmd = !request.resume &&
      !request.mutationRequired &&
      (!request.expectedArtifacts || request.expectedArtifacts.length === 0)
      ? isDeterministicCommandRequest(request.taskDescription)
      : null;

    if (deterministicCmd && runtime.tools.some((t) => t.name === deterministicCmd.tool)) {
      statsHolder.read = () => ({
        turns: 0,
        toolCalls: 1,
        tokensUsed: 0,
        longestNoProgressStreak: 0,
        duplicateActionsBlocked: 0,
        modelEscalations: 0,
      });
      if (request.isCancelled?.()) return;
      const result = await runtime.executeTool(deterministicCmd.tool, deterministicCmd.input);
      yield {
        kind: 'tool_call',
        tool: deterministicCmd.tool,
        toolInput: deterministicCmd.input,
        toolResult: result,
      };
      if (!result.ok) {
        yield {
          kind: 'error',
          error: result.error ?? `Command '${deterministicCmd.tool}' failed`,
          errorKind: result.failureClass === 'POLICY_DENIED' ? 'policy' : 'other',
          terminationReason: result.failureClass === 'POLICY_DENIED' ? 'POLICY_DENIED' : 'VERIFICATION_FAILED',
        };
        return;
      }
      yield { kind: 'phase', phase: 'complete' as AgentPhase };
      yield {
        kind: 'done',
        content: result.output || '(no output)',
        terminationReason: 'COMPLETED',
        protocolMetrics: {
          actionAttempts: 0,
          validActions: 0,
          validationErrors: 0,
          malformedActions: 0,
          adherenceRate: 1,
        },
      };
      return;
    }

    let inConversationalFastPath =
      !request.resume &&
      isConversationalFastPathRequest(request.taskDescription, {
        type: request.taskType,
        expectedFiles: request.expectedArtifacts,
        mutationRequired: request.mutationRequired,
      });

    // Compile unified tool surface (exposes all authorized tools without 2-phase gating)
    const runtimeCaps = runtime.getCapabilities?.() ?? runtime.runtimeCapabilities ?? { nativeToolCalling: true };
    const surfaceCompiler = new ToolSurfaceCompiler();
    const subagentDepth = request.subagentDepth ?? 0;
    const effectiveRuntimeTools =
      subagentDepth >= 1
        ? runtime.tools.filter((t) => t.name !== 'dispatch_subagent')
        : runtime.tools;
    const wrappedTools: Tool[] = effectiveRuntimeTools.map((t) => ({
      descriptor: {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        permissions: t.permissions ?? [],
        riskLevel: 'medium',
        environment: 'local',
        ...(t.descriptor ?? {}),
      },
      execute: t.execute ?? (async () => ({ ok: false, output: '', durationMs: 0 })),
    }));

    const compileUnifiedSurface = (): ToolSurface =>
      surfaceCompiler.compile(wrappedTools, {
        agentId: this.descriptor.name,
        agentRole: 'coder',
        taskDescription: request.taskDescription,
        phase: 'unified',
        runtimeCapabilities: { ...runtimeCaps, nativeToolCalling: true },
        projectRoot: request.projectRoot,
      });

    const toolSurface = compileUnifiedSurface();
    const availableToolNames = new Set(toolSurface.serializedSchemas.map((s) => s.name));

    const systemPrompt = buildQwenSystemPrompt({
      projectRoot: request.projectRoot,
      toolNames: [...availableToolNames],
      extra: this.systemPromptExtra,
    });

    const initialUserContent = request.resume
      ? `${resumeBriefing(request.resume)}\n\nTask: ${request.taskDescription}`
      : request.taskDescription;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: initialUserContent },
    ];

    const scheduler = new CoreToolScheduler();
    const loopDetector = new LoopDetectionService({
      toolRepeatLimit: this.toolRepeatLimit,
      maxNoProgressIterations,
    });
    const compressor = new ChatCompressionService();

    const filesChangedSet = new Set<string>(request.resume?.filesChanged ?? []);
    const checksPassedSinceLastMutation = new Set<string>(request.resume?.verification.passing ?? []);
    const webEvidence = new Map<string, GroundedResult>();
    let unresolvedDiagnostics: string | null = request.resume?.lastError ?? null;

    let turnsUsed = 0;
    let totalToolCalls = request.resume?.consumed.toolCalls ?? 0;
    let totalTokensUsed = request.resume?.consumed.tokens ?? 0;
    let repairCyclesUsed = 0;
    let emptyTurnStrikes = 0;
    let lastAssistantSummary: string | undefined;

    const currentMetrics = (): ModelProtocolMetrics => ({
      actionAttempts: scheduler.actionAttempts,
      validActions: scheduler.validActions,
      validationErrors: scheduler.validationErrors,
      malformedActions: scheduler.malformedActions,
      adherenceRate: scheduler.actionAttempts > 0 ? scheduler.validActions / scheduler.actionAttempts : 1,
    });

    statsHolder.read = () => ({
      turns: turnsUsed,
      toolCalls: totalToolCalls,
      tokensUsed: totalTokensUsed,
      longestNoProgressStreak: loopDetector.longestNoProgressStreak,
      duplicateActionsBlocked: loopDetector.duplicateActionsBlocked,
      modelEscalations: triedModelIds.length - 1,
    });

    const stopLimits = { maxWallClockMs, maxToolCalls, maxTokens, maxNoProgressIterations };
    const checkStop = (checkpoint: StopCheckpoint): StopDecision | null =>
      firstStop(
        this.stopConditions,
        checkpoint,
        {
          elapsedMs: Date.now() - runStartedAt,
          turns: turnsUsed,
          toolCalls: totalToolCalls,
          tokensUsed: totalTokensUsed,
          noProgressStreak: loopDetector.noProgressStreak,
        },
        stopLimits,
      );

    const tryEscalate = async function* (
      failureClass: TerminationReason,
      reason: string,
    ): AsyncGenerator<AgentTurn, boolean> {
      if (!runtime.escalate || escalationsUsed >= maxModelEscalations) return false;
      escalationsUsed += 1;
      let decision: { modelId?: string; reason: string };
      try {
        decision = await runtime.escalate({
          currentModelId,
          triedModelIds: [...triedModelIds],
          failureClass,
          reason,
        });
      } catch (err) {
        decision = { reason: `escalation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!decision.modelId || triedModelIds.includes(decision.modelId)) {
        yield { kind: 'message', content: `model escalation declined after ${failureClass}: ${decision.reason}` };
        return false;
      }
      const routeChange: ModelRouteChange = {
        previousModel: currentModelId,
        newModel: decision.modelId,
        failureClass,
        reason,
        routeDecision: decision.reason,
      };
      currentModelId = decision.modelId;
      triedModelIds.push(decision.modelId);
      scheduler.resetModelCounters();
      loopDetector.resetAfterEscalation();
      emptyTurnStrikes = 0;

      const note =
        `[controller] Previous model (${routeChange.previousModel}) was escalated to ${routeChange.newModel} ` +
        `after ${failureClass}: ${reason}. Continue from the current workspace state without repeating the failed approach.`;
      messages.push({ role: 'user', content: note });
      yield {
        kind: 'message',
        content: `model escalated: ${routeChange.previousModel} -> ${routeChange.newModel} (${failureClass})`,
        routeChange,
      };
      return true;
    };

    yield { kind: 'phase', phase: 'implement' as AgentPhase, toolSurface };

    while (turnsUsed < maxTurns) {
      if (request.isCancelled?.()) {
        yield {
          kind: 'error',
          error: 'Run cancelled',
          errorKind: 'cancelled',
          terminationReason: 'CANCELLED',
          protocolMetrics: currentMetrics(),
        };
        return;
      }

      // Drain mid-run user steering instruction if queued
      const steered = request.getSteeringInstruction?.()?.trim();
      if (steered) {
        messages.push({ role: 'user', content: `[user steering instruction]\n${steered}` });
        yield { kind: 'message', content: `steered: ${steered}` };
      }

      const beforeTurnStop = checkStop('before_turn');
      if (beforeTurnStop) {
        if (beforeTurnStop.escalatable && (yield* tryEscalate(beforeTurnStop.reason, beforeTurnStop.message))) {
          continue;
        }
        yield {
          kind: 'error',
          error: beforeTurnStop.message,
          errorKind: 'other',
          terminationReason: beforeTurnStop.reason,
          content: lastAssistantSummary,
          protocolMetrics: currentMetrics(),
        };
        return;
      }

      // Proactive context compression before calling model
      const effectiveCtx = runtime.getContextTokens?.() ?? request.contextTokens;
      const compressionNote = compressor.maybeCompress({
        messages,
        request,
        effectiveContextTokens: effectiveCtx,
        maxTokensPerTurn: this.maxTokensPerTurn,
        toolSchemaTokens: toolSurface.totalSchemaTokens,
        compactionRatio: this.contextCompactionRatio,
        filesChanged: filesChangedSet,
        unresolvedDiagnostics,
        webEvidence,
      });
      if (compressionNote) {
        yield { kind: 'message', content: compressionNote };
      }

      turnsUsed += 1;
      const turnTools = inConversationalFastPath ? [] : toolSurface.serializedSchemas;
      let turnRes = await runQwenModelTurn({
        runtime,
        modelId: currentModelId,
        messages,
        tools: turnTools,
        maxTokens: this.maxTokensPerTurn,
        temperature: this.temperature,
        modelTurnTimeoutMs: this.modelTurnTimeoutMs,
        turnIndex: turnsUsed,
        isCancelled: request.isCancelled,
      });

      for (const note of turnRes.retryNotes) {
        yield { kind: 'message', content: note };
      }

      // Reactive context overflow recovery (single forced compression + retry)
      if (turnRes.contextOverflow) {
        const forcedNote =
          compressor.maybeCompress({
            messages,
            request,
            effectiveContextTokens: effectiveCtx,
            maxTokensPerTurn: this.maxTokensPerTurn,
            toolSchemaTokens: toolSurface.totalSchemaTokens,
            compactionRatio: this.contextCompactionRatio,
            filesChanged: filesChangedSet,
            unresolvedDiagnostics,
            webEvidence,
            force: true,
          }) ?? 'forced compaction (no collapsible turns)';
        yield { kind: 'message', content: `context overflow recovery: ${forcedNote}` };

        turnRes = await runQwenModelTurn({
          runtime,
          modelId: currentModelId,
          messages,
          tools: turnTools,
          maxTokens: this.maxTokensPerTurn,
          temperature: this.temperature,
          modelTurnTimeoutMs: this.modelTurnTimeoutMs,
          turnIndex: turnsUsed,
          isCancelled: request.isCancelled,
        });
      }

      totalTokensUsed += turnRes.tokensUsed;

      if (request.isCancelled?.()) {
        yield {
          kind: 'error',
          error: 'Run cancelled',
          errorKind: 'cancelled',
          terminationReason: 'CANCELLED',
          protocolMetrics: currentMetrics(),
        };
        return;
      }

      if (turnRes.error && !turnRes.timedOut) {
        yield {
          kind: 'error',
          error: turnRes.error,
          errorKind: 'infrastructure',
          terminationReason: 'RESOURCE_EXHAUSTED',
          content: lastAssistantSummary,
          protocolMetrics: currentMetrics(),
        };
        return;
      }

      const afterModelStop = checkStop('after_model_turn');
      if (afterModelStop) {
        yield {
          kind: 'error',
          error: afterModelStop.message,
          errorKind: 'other',
          terminationReason: afterModelStop.reason,
          content: turnRes.content || lastAssistantSummary,
          protocolMetrics: currentMetrics(),
        };
        return;
      }

      // Compatibility bridge: if a model or test emitted a single legacy JSON control object
      // (`{"action":"plan",...}`, `{"action":"tool",...}`, `{"action":"done",...}`) as plain text
      // without native tool_calls, handle it cleanly instead of treating raw JSON as final prose.
      let effectiveToolCalls: QwenToolCallRequest[] = [...turnRes.toolCalls];
      let effectiveContent = turnRes.content.trim();

      if (effectiveToolCalls.length === 0 && ACTION_START_PATTERN.test(effectiveContent)) {
        const maybeLegacy = ModelProtocolAdapter.parse(effectiveContent, availableToolNames);
        if (maybeLegacy) {
          if (maybeLegacy.action === 'plan' && typeof maybeLegacy.content === 'string') {
            inConversationalFastPath = false;
            yield { kind: 'message', content: `Plan: ${maybeLegacy.content}`, raw: turnRes.rawContent };
            messages.push({ role: 'assistant', content: effectiveContent });
            messages.push({
              role: 'user',
              content:
                availableToolNames.size > 0
                  ? 'Proceed directly using available tools or provide the final plain-text answer.'
                  : 'Provide the final plain-text answer directly.',
            });
            continue;
          }
          if (maybeLegacy.action === 'done' || maybeLegacy.action === 'answer') {
            const summaryText =
              typeof maybeLegacy.summary === 'string'
                ? maybeLegacy.summary
                : typeof maybeLegacy.content === 'string'
                  ? maybeLegacy.content
                  : 'Task completed.';
            effectiveContent = summaryText;
          } else if (maybeLegacy.action === 'tool' && typeof maybeLegacy.tool === 'string') {
            inConversationalFastPath = false;
            effectiveToolCalls = [
              {
                id: `legacy_json_${turnsUsed}`,
                name: maybeLegacy.tool,
                input:
                  maybeLegacy.input && typeof maybeLegacy.input === 'object' && !Array.isArray(maybeLegacy.input)
                    ? (maybeLegacy.input as Record<string, unknown>)
                    : {},
                raw: turnRes.rawContent,
              },
            ];
            effectiveContent = '';
          }
        }
      }

      // If the model emitted a synthetic `done` tool call (and `done` is not a real workspace tool),
      // treat its summary/content argument as the final completion text.
      if (
        effectiveToolCalls.length === 1 &&
        effectiveToolCalls[0].name === 'done' &&
        !availableToolNames.has('done')
      ) {
        const doneInput = effectiveToolCalls[0].input;
        effectiveContent =
          typeof doneInput.summary === 'string'
            ? doneInput.summary
            : typeof doneInput.content === 'string'
              ? doneInput.content
              : typeof doneInput.answer === 'string'
                ? doneInput.answer
                : effectiveContent || 'Task completed.';
        effectiveToolCalls = [];
      }

      // Case A: Model requested one or more tool calls
      if (effectiveToolCalls.length > 0) {
        inConversationalFastPath = false;
        emptyTurnStrikes = 0;
        if (effectiveContent) {
          yield { kind: 'message', content: effectiveContent };
        }

        const batch = await scheduler.scheduleBatch({
          calls: effectiveToolCalls,
          runtime,
          availableToolNames,
          remainingToolBudget: Math.max(0, maxToolCalls - totalToolCalls),
          webEvidence,
          isCancelled: request.isCancelled,
        });

        totalToolCalls += batch.executedCount;

        // Append assistant toolCalls + matching role:'tool' messages atomically
        messages.push({
          role: 'assistant',
          content: effectiveContent,
          toolCalls: batch.assistantToolCalls,
        });
        for (const tm of batch.toolMessages) {
          messages.push(tm);
        }

        for (const t of batch.turnsToYield) {
          yield t;
        }

        if (batch.filesMutated.length > 0) {
          for (const f of batch.filesMutated) {
            filesChangedSet.add(f);
          }
          // Any physical mutation invalidates earlier check passes
          checksPassedSinceLastMutation.clear();
        }
        for (const passed of batch.checksPassed) {
          checksPassedSinceLastMutation.add(passed);
          if (passed === 'build' || passed === 'test') {
            unresolvedDiagnostics = null;
          }
        }
        for (const failed of batch.checksFailed) {
          checksPassedSinceLastMutation.delete(failed);
          const matchingOutcome = batch.outcomes.find((o) => o.canonicalName === failed && !o.result.ok);
          if (matchingOutcome) {
            unresolvedDiagnostics = [matchingOutcome.result.error, matchingOutcome.result.output]
              .filter(Boolean)
              .join('\n');
          }
        }

        if (batch.fatalStop) {
          if (
            batch.fatalStop.escalatable &&
            (yield* tryEscalate(batch.fatalStop.terminationReason, batch.fatalStop.error))
          ) {
            continue;
          }
          yield {
            kind: 'error',
            error: batch.fatalStop.error,
            errorKind: batch.fatalStop.errorKind,
            terminationReason: batch.fatalStop.terminationReason,
            raw: batch.fatalStop.raw,
            content: lastAssistantSummary,
            protocolMetrics: currentMetrics(),
          };
          return;
        }

        const loopCheck = loopDetector.recordToolOutcomes(batch.outcomes);
        if (loopCheck.action === 'nudge' && loopCheck.nudgeMessage) {
          messages.push({ role: 'user', content: loopCheck.nudgeMessage });
          yield { kind: 'message', content: loopCheck.nudgeMessage };
        } else if (loopCheck.action === 'stop' && loopCheck.stopReason && loopCheck.stopMessage) {
          if (loopCheck.escalatable && (yield* tryEscalate(loopCheck.stopReason, loopCheck.stopMessage))) {
            continue;
          }
          yield {
            kind: 'error',
            error: loopCheck.stopMessage,
            errorKind: 'other',
            terminationReason: loopCheck.stopReason,
            content: lastAssistantSummary,
            protocolMetrics: currentMetrics(),
          };
          return;
        }

        const afterToolStop = checkStop('after_tool');
        if (afterToolStop) {
          if (afterToolStop.escalatable && (yield* tryEscalate(afterToolStop.reason, afterToolStop.message))) {
            continue;
          }
          yield {
            kind: 'error',
            error: afterToolStop.message,
            errorKind: 'other',
            terminationReason: afterToolStop.reason,
            content: lastAssistantSummary,
            protocolMetrics: currentMetrics(),
          };
          return;
        }

        continue;
      }

      // Case B: Zero tool calls — check for empty / timed-out response vs genuine final answer
      if (!effectiveContent || turnRes.timedOut) {
        emptyTurnStrikes += 1;
        scheduler.actionAttempts += 1;
        scheduler.malformedActions += 1;
        const reason = turnRes.timedOut
          ? 'Model turn timed out before completing a tool call or answer.'
          : 'Model returned an empty response with no tool calls.';

        if (emptyTurnStrikes >= 3) {
          if (yield* tryEscalate('MODEL_PROTOCOL_BUDGET_EXHAUSTED', reason)) {
            continue;
          }
          yield {
            kind: 'error',
            error: `Three empty/timed-out responses (${reason}); select a smoke-tested model/runtime.`,
            errorKind: 'protocol',
            terminationReason: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED',
            content: lastAssistantSummary,
            protocolMetrics: currentMetrics(),
          };
          return;
        }

        messages.push({
          role: 'user',
          content: turnRes.timedOut
            ? '[controller] Your previous turn timed out. Call the needed tool directly or provide a concise final answer.'
            : '[controller] Your previous turn was empty. Call an available tool or provide your final answer.',
        });
        continue;
      }

      emptyTurnStrikes = 0;
      lastAssistantSummary = effectiveContent;

      const proseLoop = loopDetector.recordProseTurn(effectiveContent);
      if (proseLoop.action === 'stop' && proseLoop.stopReason && proseLoop.stopMessage) {
        if (proseLoop.escalatable && (yield* tryEscalate(proseLoop.stopReason, proseLoop.stopMessage))) {
          continue;
        }
        yield {
          kind: 'error',
          error: proseLoop.stopMessage,
          errorKind: 'other',
          terminationReason: proseLoop.stopReason,
          content: effectiveContent,
          protocolMetrics: currentMetrics(),
        };
        return;
      }

      // Run proportional host-side verification before accepting completion
      yield { kind: 'phase', phase: 'verify' as AgentPhase };
      const verifyRes = await runProportionalVerification({
        request,
        runtime,
        filesChanged: filesChangedSet,
        checksPassedSinceLastMutation,
        webEvidence,
        hasWebFetchCapability: this.descriptor.capabilities.includes('web.fetch'),
        modelSummary: effectiveContent,
      });

      if (verifyRes.scopeMessage) {
        yield { kind: 'message', content: verifyRes.scopeMessage };
      }

      if (verifyRes.ok) {
        yield { kind: 'phase', phase: 'complete' as AgentPhase };
        yield {
          kind: 'done',
          content: effectiveContent,
          terminationReason: 'VERIFICATION_PASSED',
          protocolMetrics: currentMetrics(),
        };
        return;
      }

      // Verification failed: allow bounded self-repair if tools exist and repair budget remains
      const canSelfRepair =
        availableToolNames.size > 0 &&
        repairCyclesUsed < maxRepairCycles &&
        turnsUsed < maxTurns;

      if (canSelfRepair) {
        repairCyclesUsed += 1;
        unresolvedDiagnostics = verifyRes.failures.join('\n---\n');
        yield { kind: 'phase', phase: 'repair' as AgentPhase };
        messages.push({ role: 'assistant', content: effectiveContent });
        messages.push({
          role: 'user',
          content:
            `[verification failed — repair cycle ${repairCyclesUsed}/${maxRepairCycles}]\n` +
            `${unresolvedDiagnostics}\n\n` +
            'Use your tools to inspect and fix the failure(s) above before finishing.',
        });
        continue;
      }

      yield {
        kind: 'error',
        error: `verification failed:\n${verifyRes.failures.join('\n---\n')}`,
        content: effectiveContent,
        errorKind: 'verification',
        terminationReason:
          repairCyclesUsed >= maxRepairCycles && maxRepairCycles > 0 && filesChangedSet.size > 0
            ? 'MAX_REPAIRS'
            : 'VERIFICATION_FAILED',
        protocolMetrics: currentMetrics(),
      };
      return;
    }

    // Turn budget exhausted
    yield {
      kind: 'error',
      error: `MAX_TURNS: reached ${maxTurns} turns without completing the task`,
      content: lastAssistantSummary,
      errorKind: 'other',
      terminationReason: 'MAX_TURNS',
      protocolMetrics: currentMetrics(),
    };
  }
}
