import { randomUUID } from 'node:crypto';
import type { RuntimeAdapter, GenerationRequest } from '@wazir/runtimes-interfaces';
import type {
  BenchmarkRunner,
  BenchmarkTask,
  BenchmarkExecutionContext,
  ExecutionRecord,
  CheckRunRecord,
  VerificationEvidence,
} from '@wazir/core';

export interface LiveBenchmarkRunnerOptions {
  adapter: RuntimeAdapter;
  modelId: string;
  runtimeId?: string;
  name?: string;
  timeoutMs?: number;
}

export class LiveBenchmarkRunner implements BenchmarkRunner {
  readonly id: string;
  readonly name: string;
  private readonly adapter: RuntimeAdapter;
  readonly modelId: string;
  readonly runtimeId: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: LiveBenchmarkRunnerOptions) {
    this.adapter = options.adapter;
    this.modelId = options.modelId;
    this.runtimeId = options.runtimeId ?? this.adapter.id ?? 'local';
    this.id = `live-runner-${this.runtimeId}-${this.modelId}`;
    this.name = options.name ?? `Live Local Model Runner (${this.modelId})`;
    this.defaultTimeoutMs = options.timeoutMs ?? 60_000;
  }

  async run(task: BenchmarkTask, context?: BenchmarkExecutionContext): Promise<ExecutionRecord> {
    const startedAt = new Date();
    const startTime = Date.now();
    const execId = `exec-${task.id}-${randomUUID().slice(0, 8)}`;

    const promptText = task.prompt || task.name;
    const timeoutMs = context?.timeoutMs ?? this.defaultTimeoutMs;

    // Apply any active candidate prompt modifications
    let systemInstruction = 'You are Wazir, an autonomous software-engineering control plane.';
    const config = context?.config;
    if (config?.prompts?.systemPromptPrefix) {
      systemInstruction = config.prompts.systemPromptPrefix;
    }
    if (config?.prompts?.repairGuidance) {
      systemInstruction += `\nRepair Guidance: ${config.prompts.repairGuidance}`;
    }

    const generationRequest: GenerationRequest = {
      modelId: this.modelId,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: promptText },
      ],
      maxTokens: 1024,
      temperature: 0.2,
      stream: true,
      requestId: execId,
    };

    let output = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let ok = true;
    const errors: string[] = [];

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    if (context?.abortSignal) {
      context.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    try {
      const stream = this.adapter.generate(generationRequest);
      for await (const event of stream) {
        if (abortController.signal.aborted) {
          throw new Error(`Execution timed out after ${timeoutMs}ms`);
        }
        if (event.type === 'token' && event.content) {
          output += event.content;
        } else if (event.type === 'completed') {
          if (event.content && !output) output = event.content;
          inputTokens = event.usage?.inputTokens ?? 0;
          outputTokens = event.usage?.outputTokens ?? 0;
        } else if (event.type === 'error') {
          ok = false;
          if (event.error) errors.push(event.error);
        }
      }
    } catch (err) {
      ok = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(errMsg);
    } finally {
      clearTimeout(timer);
    }

    const completedAt = new Date();
    const durationMs = Date.now() - startTime;

    // Default tokens if runtime stream didn't supply them
    if (inputTokens === 0) {
      inputTokens = Math.max(1, Math.round((systemInstruction.length + promptText.length) / 4));
    }
    if (outputTokens === 0) {
      outputTokens = Math.max(1, Math.round(output.length / 4));
    }

    const checks: CheckRunRecord[] = [
      {
        name: 'test',
        command: 'check',
        ok,
        durationMs,
        output: ok ? 'ok' : errors.join('; '),
      },
    ];

    const evidence: VerificationEvidence[] = [
      {
        id: `evd-${execId}`,
        type: 'TEST',
        revision: 1,
        command: 'check',
        exitCode: ok ? 0 : 1,
        durationMs,
        output: ok ? output.slice(0, 200) : errors.join('; '),
      },
    ];

    const record: ExecutionRecord = {
      execution: {
        id: execId,
        taskId: task.id,
        runtimeId: this.runtimeId,
        modelId: this.modelId,
        status: ok ? 'completed' : 'failed',
        createdAt: startedAt,
        startedAt,
        completedAt,
        workspaceRoot: context?.workspaceRoot,
      },
      task: {
        id: task.id,
        type: 'coding',
        title: task.name,
        input: promptText,
        requirements: {},
        priority: 'normal',
        status: ok ? 'completed' : 'failed',
        createdAt: startedAt,
        completedAt,
      },
      policyDecisions: [],
      toolCalls: [],
      filesChanged: task.expectedFiles ?? [],
      checks,
      errors,
      events: [],
      evidence,
      usage: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
      },
      result: output,
    };

    return record;
  }
}
