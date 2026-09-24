import vm from 'node:vm';
import crypto from 'node:crypto';
import type {
  CodeModeLimits,
  CodeModeResult,
  CodeModeSubCallRecord,
  WazirCodeModeSdk,
  CodeModeStreamListener,
  CodeModeStreamingEvent,
} from '../types/codeMode.js';
import type { ToolExecutionContext, ToolResult } from '../types/tool.js';

export type CodeModeToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<ToolResult>;

export interface CodeModeServiceOptions {
  toolExecutor: CodeModeToolExecutor;
  limits?: CodeModeLimits;
  onStream?: CodeModeStreamListener;
}

export class CodeModeService {
  private readonly toolExecutor: CodeModeToolExecutor;
  private readonly defaultLimits: Required<CodeModeLimits>;
  private readonly onStream?: CodeModeStreamListener;

  constructor(options: CodeModeServiceOptions) {
    this.toolExecutor = options.toolExecutor;
    this.onStream = options.onStream;
    this.defaultLimits = {
      maxCalls: options.limits?.maxCalls ?? 50,
      timeoutMs: options.limits?.timeoutMs ?? 30_000,
      maxOutputChars: options.limits?.maxOutputChars ?? 500_000,
      maxConcurrency: options.limits?.maxConcurrency ?? 10,
    };
  }

  /**
   * Executes a model-requested bounded program against the typed Wazir SDK.
   * Execution strictly routes every SDK operation through ToolRegistry -> PolicyEngine -> ExecutionEngine.
   */
  async executeScript(
    script: string,
    context: Partial<ToolExecutionContext> = {},
    overrideLimits?: CodeModeLimits,
  ): Promise<CodeModeResult> {
    const limits: Required<CodeModeLimits> = {
      maxCalls: overrideLimits?.maxCalls ?? this.defaultLimits.maxCalls,
      timeoutMs: overrideLimits?.timeoutMs ?? this.defaultLimits.timeoutMs,
      maxOutputChars: overrideLimits?.maxOutputChars ?? this.defaultLimits.maxOutputChars,
      maxConcurrency: overrideLimits?.maxConcurrency ?? this.defaultLimits.maxConcurrency,
    };

    const startedAt = Date.now();
    const scriptId = `cms-${crypto.randomBytes(4).toString('hex')}`;
    const emitStream = (event: Omit<CodeModeStreamingEvent, 'timestamp' | 'scriptId'>) => {
      const fullEvent: CodeModeStreamingEvent = {
        ...event,
        scriptId,
        executionId: context.executionId,
        timestamp: new Date(),
      };
      (context as { onStream?: CodeModeStreamListener }).onStream?.(fullEvent);
      this.onStream?.(fullEvent);
    };

    emitStream({ type: 'codemode.started' });

    const subCalls: CodeModeSubCallRecord[] = [];
    let callCounter = 0;
    let activeInFlight = 0;
    const queue: Array<() => void> = [];

    const acquireSlot = async (): Promise<void> => {
      if (activeInFlight < limits.maxConcurrency) {
        activeInFlight++;
        return;
      }
      return new Promise<void>((resolve) => {
        queue.push(() => {
          activeInFlight++;
          resolve();
        });
      });
    };

    const releaseSlot = () => {
      activeInFlight--;
      if (queue.length > 0) {
        const next = queue.shift();
        next?.();
      }
    };

    // Controller timeout & cancellation signals
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => {
      controller.abort(new Error('CODE_MODE_TIMEOUT'));
    }, limits.timeoutMs);

    const mergedSignal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;

    // Helper to execute any registered tool via controller pipeline
    const dispatchSdkOperation = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<ToolResult> => {
      if (mergedSignal.aborted) {
        throw new Error(controller.signal.aborted ? 'CODE_MODE_TIMEOUT: Script exceeded execution timeout' : 'CANCELLED: Script execution was aborted');
      }

      callCounter++;
      if (callCounter > limits.maxCalls) {
        throw new Error(`CODE_MODE_BUDGET_EXCEEDED: Script exceeded maximum permitted tool calls (${limits.maxCalls})`);
      }

      await acquireSlot();
      const callStarted = Date.now();
      const callId = `cm-${crypto.randomBytes(4).toString('hex')}`;

      emitStream({
        type: 'codemode.operation.started',
        operationId: callId,
        tool: toolName,
        input,
      });

      try {
        const result = await this.toolExecutor(toolName, input, {
          ...context,
          projectRoot: context.projectRoot ?? process.cwd(),
          callId,
          signal: mergedSignal,
        } as ToolExecutionContext);

        const duration = Date.now() - callStarted;
        const boundedOutput = result.output?.slice(0, 10_000);

        if (boundedOutput) {
          emitStream({
            type: 'codemode.operation.output',
            operationId: callId,
            tool: toolName,
            outputChunk: boundedOutput,
          });
        }

        subCalls.push({
          callId,
          tool: toolName,
          input,
          ok: result.ok,
          output: boundedOutput,
          error: result.error,
          durationMs: duration,
          timestamp: new Date(),
          provenance: { source: 'code_mode', tool: toolName },
        });

        if (!result.ok) {
          emitStream({
            type: 'codemode.operation.failed',
            operationId: callId,
            tool: toolName,
            error: result.error ?? `${toolName} failed`,
            durationMs: duration,
          });
          throw new Error(result.error ?? `${toolName} failed`);
        }

        emitStream({
          type: 'codemode.operation.completed',
          operationId: callId,
          tool: toolName,
          result,
          durationMs: duration,
        });

        return result;
      } catch (err: any) {
        if (!subCalls.some((c) => c.callId === callId)) {
          emitStream({
            type: 'codemode.operation.failed',
            operationId: callId,
            tool: toolName,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - callStarted,
          });
        }
        throw err;
      } finally {
        releaseSlot();
      }
    };

    // Construct the typed SDK exposed inside the sandbox
    const sdk: WazirCodeModeSdk = {
      async read(filePath: string): Promise<string> {
        const res = await dispatchSdkOperation('read', { path: filePath });
        return res.output;
      },
      async write(filePath: string, content: string): Promise<ToolResult> {
        return dispatchSdkOperation('write', { path: filePath, content });
      },
      async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<ToolResult> {
        return dispatchSdkOperation('edit', { path: filePath, oldString, newString, replaceAll });
      },
      async search(opts: { query: string; paths?: string[]; glob?: string }): Promise<string> {
        const res = await dispatchSdkOperation('search', opts as Record<string, unknown>);
        return res.output;
      },
      async glob(pattern: string): Promise<string[]> {
        const res = await dispatchSdkOperation('glob', { pattern });
        try {
          return JSON.parse(res.output);
        } catch {
          return res.output.split('\n').filter(Boolean);
        }
      },
      async goToDefinition(file: string, line: number, character: number): Promise<unknown> {
        const res = await dispatchSdkOperation('goToDefinition', { file, line, character });
        try { return JSON.parse(res.output); } catch { return res.output; }
      },
      async references(file: string, line: number, character: number): Promise<unknown> {
        const res = await dispatchSdkOperation('findReferences', { file, line, character });
        try { return JSON.parse(res.output); } catch { return res.output; }
      },
      async callers(symbol: string): Promise<unknown> {
        const res = await dispatchSdkOperation('findCallers', { symbol });
        try { return JSON.parse(res.output); } catch { return res.output; }
      },
      async callees(symbol: string): Promise<unknown> {
        const res = await dispatchSdkOperation('findCallees', { symbol });
        try { return JSON.parse(res.output); } catch { return res.output; }
      },
      async symbols(file: string): Promise<unknown> {
        const res = await dispatchSdkOperation('documentSymbols', { file });
        try { return JSON.parse(res.output); } catch { return res.output; }
      },
      async workspaceSymbols(query: string): Promise<unknown> {
        const res = await dispatchSdkOperation('workspaceSymbols', { query });
        try { return JSON.parse(res.output); } catch { return res.output; }
      },
      async relatedTests(file: string): Promise<string[]> {
        const res = await dispatchSdkOperation('relatedTests', { file });
        try { return JSON.parse(res.output); } catch { return []; }
      },
      async git(command: string): Promise<string> {
        const res = await dispatchSdkOperation('git', { command });
        return res.output;
      },
      async test(command?: string): Promise<ToolResult> {
        return dispatchSdkOperation('test', command ? { command } : {});
      },
      async build(command?: string): Promise<ToolResult> {
        return dispatchSdkOperation('build', command ? { command } : {});
      },
      async call(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
        return dispatchSdkOperation(toolName, input);
      },
      mcp: new Proxy({}, {
        get: (_target, serverId: string) => {
          return new Proxy({}, {
            get: (_subTarget, toolName: string) => {
              return async (input: Record<string, unknown> = {}) => {
                return dispatchSdkOperation(`mcp.${serverId}.${toolName}`, input);
              };
            },
          });
        },
      }) as Record<string, Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>>,
    };

    // Sandbox execution context: isolated, with NO access to process, fs, require, or globals
    const logs: string[] = [];
    const sandboxContext = vm.createContext({
      wazir: sdk,
      console: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        info: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      },
      Promise,
      Math,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      RegExp,
      Map,
      Set,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      setTimeout,
      clearTimeout,
    });

    try {
      // Wrap user code in async function execution
      const wrappedScript = `(async () => {\n${script}\n})()`;
      const compiled = new vm.Script(wrappedScript, {
        filename: 'code-mode-script.js',
      });

      const promise = compiled.runInContext(sandboxContext, {
        timeout: limits.timeoutMs,
      }) as Promise<unknown>;

      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => {
          if (controller.signal.aborted) {
            reject(new Error('CODE_MODE_TIMEOUT: Script execution timed out'));
          } else {
            reject(new Error('CANCELLED: Script execution was aborted'));
          }
        };
        if (mergedSignal.aborted) {
          onAbort();
        } else {
          mergedSignal.addEventListener('abort', onAbort, { once: true });
        }
      });

      const returnValue = await Promise.race([promise, abortPromise]);
      clearTimeout(timeoutTimer);

      const elapsed = Date.now() - startedAt;
      const rawOutput = returnValue !== undefined ? JSON.stringify(returnValue, null, 2) : logs.join('\n');
      const boundedOutput = rawOutput.slice(0, limits.maxOutputChars);

      emitStream({
        type: 'codemode.completed',
        durationMs: elapsed,
      });

      return {
        ok: true,
        returnValue,
        output: boundedOutput,
        durationMs: elapsed,
        toolCallsExecuted: subCalls.length,
        subCalls,
        roundTripReduction: {
          equivalentTurnCount: subCalls.length,
          actualTurnCount: 1,
          roundTripsSaved: Math.max(0, subCalls.length - 1),
        },
      };
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      const elapsed = Date.now() - startedAt;
      const isTimeout = controller.signal.aborted || err?.message?.includes('CODE_MODE_TIMEOUT');
      const isBudget = err?.message?.includes('CODE_MODE_BUDGET_EXCEEDED');
      const isCancel = mergedSignal.aborted && !isTimeout;

      emitStream({
        type: 'codemode.completed',
        durationMs: elapsed,
        error: err instanceof Error ? err.message : String(err),
      });

      const failureClass = isTimeout
        ? 'CODE_MODE_TIMEOUT'
        : isBudget
          ? 'CODE_MODE_BUDGET_EXCEEDED'
          : isCancel
            ? 'CANCELLED'
            : err?.failureClass ?? 'CODE_MODE_FAILED';

      return {
        ok: false,
        output: logs.join('\n'),
        error: err instanceof Error ? err.message : String(err),
        failureClass,
        durationMs: elapsed,
        toolCallsExecuted: subCalls.length,
        subCalls,
        roundTripReduction: {
          equivalentTurnCount: subCalls.length,
          actualTurnCount: 1,
          roundTripsSaved: Math.max(0, subCalls.length - 1),
        },
      };
    }
  }
}
