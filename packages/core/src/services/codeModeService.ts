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
import { injectFault } from '@wazir/shared';

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

      await injectFault('DURING_CODE_MODE', { operationId: callId, tool: toolName, input, scriptId });

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

    // Sandbox execution context: isolated VM realm with NO access to process, fs, require, or host constructors
    const logs: string[] = [];
    const activeTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextTimerId = 1;
    const clearAllSandboxTimers = () => {
      for (const handle of activeTimers.values()) {
        clearTimeout(handle);
      }
      activeTimers.clear();
    };

    const sandboxContext = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    });

    const bootstrapSandbox = vm.runInContext(
      `(function(hostSdk, hostMcpCall, hostLog, hostSetTimeout, hostClearTimeout) {
        const SafeError = Error;
        const jsonParse = JSON.parse;
        const jsonStringify = JSON.stringify;

        const toSafeValue = (val) => {
          if (val === undefined || val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
            return val;
          }
          try {
            return jsonParse(jsonStringify(val));
          } catch {
            return undefined;
          }
        };

        const wrapAsync = (fn) => {
          const wrapped = async function(...args) {
            try {
              const safeArgs = toSafeValue(args) ?? [];
              const res = await fn(...safeArgs);
              return toSafeValue(res);
            } catch (err) {
              const msg = err && typeof err.message === 'string' ? err.message : String(err);
              throw new SafeError(msg);
            }
          };
          Object.setPrototypeOf(wrapped, null);
          return Object.freeze(wrapped);
        };

        const mcpProxy = new Proxy(Object.create(null), {
          get(_target, serverId) {
            if (typeof serverId !== 'string') return undefined;
            return new Proxy(Object.create(null), {
              get(_subTarget, toolName) {
                if (typeof toolName !== 'string') return undefined;
                return wrapAsync((input = {}) => hostMcpCall(serverId, toolName, input));
              },
            });
          },
        });

        const wazir = Object.assign(Object.create(null), {
          read: wrapAsync((filePath) => hostSdk.read(filePath)),
          write: wrapAsync((filePath, content) => hostSdk.write(filePath, content)),
          edit: wrapAsync((filePath, oldString, newString, replaceAll) => hostSdk.edit(filePath, oldString, newString, replaceAll)),
          search: wrapAsync((opts) => hostSdk.search(opts)),
          glob: wrapAsync((pattern) => hostSdk.glob(pattern)),
          goToDefinition: wrapAsync((file, line, character) => hostSdk.goToDefinition(file, line, character)),
          references: wrapAsync((file, line, character) => hostSdk.references(file, line, character)),
          callers: wrapAsync((symbol) => hostSdk.callers(symbol)),
          callees: wrapAsync((symbol) => hostSdk.callees(symbol)),
          symbols: wrapAsync((file) => hostSdk.symbols(file)),
          workspaceSymbols: wrapAsync((query) => hostSdk.workspaceSymbols(query)),
          relatedTests: wrapAsync((file) => hostSdk.relatedTests(file)),
          git: wrapAsync((command) => hostSdk.git(command)),
          test: wrapAsync((command) => hostSdk.test(command)),
          build: wrapAsync((command) => hostSdk.build(command)),
          call: wrapAsync((toolName, input) => hostSdk.call(toolName, input)),
          mcp: mcpProxy,
        });
        wazir.fs = Object.freeze(Object.assign(Object.create(null), {
          read: wazir.read,
          write: wazir.write,
          edit: wazir.edit,
          glob: wazir.glob,
          search: wazir.search,
        }));
        Object.freeze(wazir);

        const safeLog = (...args) => {
          try {
            hostLog(args.map((a) => String(a)).join(' '));
          } catch {
            // ignore logging failures
          }
        };
        Object.setPrototypeOf(safeLog, null);
        Object.freeze(safeLog);

        const safeConsole = Object.freeze(Object.assign(Object.create(null), {
          log: safeLog,
          info: safeLog,
          warn: safeLog,
          error: safeLog,
        }));

        const safeSetTimeout = function(cb, ms) {
          if (typeof cb !== 'function') {
            throw new SafeError('Callback must be a function');
          }
          const delay = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0;
          return hostSetTimeout(() => {
            try { cb(); } catch {}
          }, delay);
        };
        Object.setPrototypeOf(safeSetTimeout, null);
        Object.freeze(safeSetTimeout);

        const safeClearTimeout = function(id) {
          if (typeof id === 'number') {
            hostClearTimeout(id);
          }
        };
        Object.setPrototypeOf(safeClearTimeout, null);
        Object.freeze(safeClearTimeout);

        globalThis.wazir = wazir;
        globalThis.sdk = wazir;
        globalThis.console = safeConsole;
        globalThis.setTimeout = safeSetTimeout;
        globalThis.clearTimeout = safeClearTimeout;

        const AsyncFunction = (async function(){}).constructor;
        const GeneratorFunction = (function*(){}).constructor;
        const AsyncGeneratorFunction = (async function*(){}).constructor;
        for (const ctor of [Function, AsyncFunction, GeneratorFunction, AsyncGeneratorFunction]) {
          if (ctor && ctor.prototype) {
            Object.defineProperty(ctor.prototype, 'constructor', {
              value: undefined,
              writable: false,
              configurable: false,
            });
          }
        }
        Object.defineProperty(globalThis, 'Function', {
          value: undefined,
          writable: false,
          configurable: false,
        });
        Object.defineProperty(globalThis, 'eval', {
          value: undefined,
          writable: false,
          configurable: false,
        });
        Object.setPrototypeOf(globalThis, null);
      })`,
      sandboxContext,
    ) as (
      hostSdk: WazirCodeModeSdk,
      hostMcpCall: (serverId: string, toolName: string, input: Record<string, unknown>) => Promise<ToolResult>,
      hostLog: (msg: string) => void,
      hostSetTimeout: (cb: () => void, delay: number) => number,
      hostClearTimeout: (id: number) => void,
    ) => void;

    bootstrapSandbox(
      sdk,
      (serverId, toolName, input) => dispatchSdkOperation(`mcp.${serverId}.${toolName}`, input),
      (msg) => logs.push(msg),
      (cb, delay) => {
        const id = nextTimerId++;
        const handle = setTimeout(() => {
          activeTimers.delete(id);
          cb();
        }, delay);
        activeTimers.set(id, handle);
        return id;
      },
      (id) => {
        const handle = activeTimers.get(id);
        if (handle !== undefined) {
          clearTimeout(handle);
          activeTimers.delete(id);
        }
      },
    );

    try {
      // Wrap user code in strict async function execution
      const wrappedScript = `(async () => { "use strict";\n${script}\n})()`;
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

      const rawReturnValue = await Promise.race([promise, abortPromise]);
      clearTimeout(timeoutTimer);
      clearAllSandboxTimers();

      const elapsed = Date.now() - startedAt;
      const rawOutput = rawReturnValue !== undefined ? JSON.stringify(rawReturnValue, null, 2) : logs.join('\n');
      const returnValue = rawReturnValue !== undefined && rawOutput !== undefined
        ? JSON.parse(rawOutput)
        : rawReturnValue;
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
      clearAllSandboxTimers();
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
