import type { Tool, ToolDescriptor, ToolResult } from '@wazir/core';
import { compileToolSchema, detectOracleWeakening } from '@wazir/core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { snapshotWorkspace, workspaceFingerprint, workspaceMutations } from './workspaceSnapshot.js';
import { editTool, readTool, writeTool } from './filesystem.js';
import { globTool, searchTool } from './search.js';
import { buildTool, gitTool, lintTool, shellTool, testTool, typecheckTool } from './process-tools.js';
import { terminalCloseTool, terminalOpenTool, terminalSendTool } from './terminalTools.js';
import { lspTools } from './lspToolsStub';
import { compactMemoryTool } from './compactionTools.js';
import { codeIntelligenceTools } from './codeIntelligenceTools.js';
import { codeModeTool, setCodeModeToolRegistry } from './codeModeTool.js';

export const dispatchSubagentTool: Tool = {
  descriptor: {
    name: 'dispatch_subagent',
    description:
      'Delegate a self-contained subtask to a fresh agent with no memory of this conversation. ' +
      'Use for isolated exploration or a well-scoped subproblem whose full transcript you do not ' +
      'need. Returns only a condensed summary, not the raw transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'The subtask, written so it is understandable with no other context',
        },
        expectedArtifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional expected artifacts or files created by the subtask',
        },
      },
      required: ['description'],
    },
    permissions: ['subagent'],
    riskLevel: 'medium',
    environment: 'local',
    provenance: { source: 'subagent' },
  },
  async execute(input: Record<string, unknown>, ctx?: import('@wazir/core').ToolExecutionContext): Promise<ToolResult> {
    if (ctx?.subagentExecutor) {
      return ctx.subagentExecutor(input, ctx);
    }
    throw new Error('dispatch_subagent must be executed via the runtime harness or an attached subagentExecutor');
  },
};

export const defaultTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  searchTool,
  globTool,
  shellTool,
  gitTool,
  testTool,
  lintTool,
  typecheckTool,
  buildTool,
  dispatchSubagentTool,
  terminalOpenTool,
  terminalSendTool,
  terminalCloseTool,
  compactMemoryTool,
  ...lspTools,
  ...codeIntelligenceTools,
  codeModeTool,
];

export class ToolRegistry {
  private readonly controllerOnly = new Set<string>();
  restrictToController(name: string): void { this.controllerOnly.add(name); }
  isControllerOnly(name: string): boolean { return this.controllerOnly.has(name); }
  private readonly tools = new Map<string, Tool>();
  private readonly contracts = new Map<string, { input: ReturnType<typeof compileToolSchema>; output?: ReturnType<typeof compileToolSchema> }>();

  constructor(tools: Tool[] = defaultTools) {
    setCodeModeToolRegistry(this);
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    const input = compileToolSchema(tool.descriptor.inputSchema);
    const output = tool.descriptor.outputSchema ? compileToolSchema(tool.descriptor.outputSchema) : undefined;
    tool.descriptor.sideEffectClass ??= tool.descriptor.permissions.length > 0 && tool.descriptor.permissions.every(p => p === 'filesystem_read')
      ? 'READ_ONLY' : 'NON_IDEMPOTENT_WRITE';
    tool.descriptor.concurrencySafety ??= tool.descriptor.sideEffectClass === 'READ_ONLY' ? 'parallel' : 'exclusive';
    tool.descriptor.timeoutMs ??= 120_000;
    if (!Number.isFinite(tool.descriptor.timeoutMs) || tool.descriptor.timeoutMs <= 0 || tool.descriptor.timeoutMs > 2_147_483_647) throw new Error(`Invalid timeout for tool '${tool.descriptor.name}'`);
    this.contracts.set(tool.descriptor.name, { input, output });
    this.tools.set(tool.descriptor.name, tool);
  }

  unregister(name: string): void { this.tools.delete(name); this.contracts.delete(name); }

  validate(name: string, value: unknown, phase: 'input' | 'output'): string | undefined {
    const validate = this.contracts.get(name)?.[phase];
    if (!validate || validate(value)) return undefined;
    return (validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? 'invalid value'}`).join('; ');
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((t) => t.descriptor);
  }

  /** Schemas as presented to a model. */
  forModel(allowedNames?: readonly string[], capabilities: readonly string[] = []): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.list().filter(t => !this.controllerOnly.has(t.descriptor.name) && (!allowedNames || allowedNames.includes(t.descriptor.name)) &&
      (t.descriptor.provenance?.source !== 'web' || t.descriptor.capabilities?.every(c => capabilities.includes(c)))).map((t) => ({
      name: t.descriptor.name,
      description: t.descriptor.description,
      inputSchema: t.descriptor.inputSchema,
    }));
  }

  requiredTools(names: string[]): string[] {
    return names.filter((name) => !this.tools.has(name));
  }
}

/**
 * Pre-dispatch oracle check for `write`/`edit`: computes the content the call
 * would produce and compares it with what is on disk now. Nothing is written.
 * Paths outside the project root are left to PolicyEngine.
 */
async function proposedOracleWeakening(projectRoot: string, name: string, input: Record<string, unknown>) {
  if ((name !== 'write' && name !== 'edit') || typeof input.path !== 'string') return [];
  const absolute = path.resolve(projectRoot, input.path);
  const relative = path.relative(path.resolve(projectRoot), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  let before: string | null;
  try {
    before = await readFile(absolute, 'utf8');
  } catch {
    before = null;
  }
  if (before === null) return [];
  let after: string;
  if (name === 'write') {
    if (typeof input.content !== 'string') return [];
    after = input.content;
  } else {
    const oldString = typeof input.oldString === 'string' ? input.oldString : '';
    const newString = typeof input.newString === 'string' ? input.newString : '';
    if (!oldString || !before.includes(oldString)) return [];
    after = input.replaceAll === true ? before.split(oldString).join(newString) : before.replace(oldString, () => newString);
  }
  return detectOracleWeakening(relative, before, after);
}

/** How long an interrupted terminatesOnAbort tool may take to confirm its process exited. */
const TERMINATION_GRACE_MS = 10_000;

export async function executeTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
  ctx: Parameters<Tool['execute']>[1],
): Promise<ToolResult> {
  if (registry.isControllerOnly(name)) return { ok: false, output: '', error: 'provider tool is controller-only; use web_search/web_fetch', failureClass: 'POLICY_DENIED', durationMs: 0 };
  if (ctx.allowedTools && !ctx.allowedTools.includes(name)) return {
    ok: false, output: '', error: `tool '${name}' is outside the execution tool surface`, failureClass: 'POLICY_DENIED', durationMs: 0,
  };
  const tool = registry.get(name);
  if (!tool) {
    return {
      ok: false,
      output: '',
      error: `unknown tool '${name}'`,
      failureClass: 'TOOL_VALIDATION_FAILED',
      durationMs: 0,
    };
  }
  const isMCP = tool.descriptor.provenance?.source === 'mcp';
  const invalid = registry.validate(name, input, 'input');
  if (invalid) return { ok: false, output: '', error: isMCP ? 'MCP_TOOL_SCHEMA_INVALID' : `TOOL_VALIDATION_FAILED: ${invalid}`, failureClass: 'TOOL_VALIDATION_FAILED', durationMs: 0 };
  if (ctx.signal?.aborted) return { ok: false, output: '', error: 'cancelled before tool dispatch', failureClass: 'CANCELLED', durationMs: 0 };
  if (!ctx.allowVerificationChanges) {
    const findings = await proposedOracleWeakening(ctx.projectRoot, name, input);
    if (findings.length > 0) return {
      ok: false, output: '', failureClass: 'POLICY_DENIED', durationMs: 0, metadata: { oracleWeakening: findings },
      error: `VERIFICATION_PROTECTED: ${findings.map(f => `${f.path}: ${f.kind} (${f.detail})`).join('; ')}. ` +
        'Fix the implementation, not the tests; verification assets may only be weakened when the task explicitly asks for it.',
    };
  }
  const targets = ['write', 'edit'].includes(name) && typeof input.path === 'string' ? [input.path] : undefined;
  const before = ctx.verifyWorkspace && tool.descriptor.sideEffectClass !== 'READ_ONLY' ? await snapshotWorkspace(ctx.projectRoot, targets) : undefined;
  // MCP performs its own authorization and checkpoints immediately after it.
  if (!isMCP) await ctx.checkpoint?.();
  if (ctx.signal?.aborted) return { ok: false, output: '', error: 'cancelled before tool dispatch', failureClass: 'CANCELLED', durationMs: 0 };
  const started = Date.now();
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const unknownOutcome = tool.descriptor.sideEffectClass !== 'READ_ONLY';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  let wasInterrupted = false;
  const interrupted = new Promise<ToolResult>(resolve => {
    onAbort = () => {
      wasInterrupted = true;
      resolve({ ok: false, output: '', error: controller.signal.aborted ? (isMCP ? 'MCP_TOOL_TIMEOUT' : 'tool timeout; execution outcome requires reconciliation') : (isMCP ? 'MCP_CANCELLED' : 'tool cancelled after dispatch'),
        failureClass: unknownOutcome ? 'TOOL_OUTCOME_UNKNOWN' : controller.signal.aborted ? 'TOOL_TIMEOUT' : 'CANCELLED', durationMs: Date.now() - started });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), tool.descriptor.timeoutMs);
  });
  try {
    const operation = Promise.resolve().then(() => tool.execute(input, { ...ctx, signal })).catch((error): ToolResult => ({
      ok: false, output: '', error: error instanceof Error ? error.message : String(error),
      failureClass: unknownOutcome ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_EXECUTION_FAILED', durationMs: Date.now() - started,
    }));
    let result = await Promise.race([operation, interrupted]);
    if (wasInterrupted && tool.descriptor.terminatesOnAbort && !isMCP) {
      // Interrupted after dispatch. A tool that kills its own process on abort settles
      // once that process has exited; if it does within the grace period, the side
      // effect has stopped and the after-snapshot below is final — the outcome is
      // determined (timeout/cancel with observed mutations), not unknown.
      let grace: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([operation, new Promise<undefined>(r => { grace = setTimeout(() => r(undefined), TERMINATION_GRACE_MS); })]);
      clearTimeout(grace);
      if (settled) {
        const timedOut = controller.signal.aborted;
        result = {
          ok: false, output: settled.output, metadata: { ...settled.metadata, processTerminated: true },
          error: timedOut ? `tool timed out after ${tool.descriptor.timeoutMs}ms; its process was terminated` : 'tool cancelled after dispatch; its process was terminated',
          failureClass: timedOut ? 'TOOL_TIMEOUT' : 'CANCELLED', durationMs: Date.now() - started,
        };
      }
    }
    if (before) {
      const after = await snapshotWorkspace(ctx.projectRoot, targets);
      result = { ...result, fileMutations: workspaceMutations(before, after, result.ok), metadata: {
        ...result.metadata, workspaceBeforeHash: workspaceFingerprint(before), workspaceAfterHash: workspaceFingerprint(after),
      } };
    }
    const invalidOutput = result.ok ? registry.validate(name, result.structuredOutput, 'output') : undefined;
    if (invalidOutput) return { ...result, ok: false, failureClass: 'ARTIFACT_CONTRACT_FAILED', error: `ARTIFACT_CONTRACT_FAILED: ${invalidOutput}` };
    return result;
  } catch (error) {
    return { ok: false, output: '', error: error instanceof Error ? error.message : String(error),
      failureClass: unknownOutcome ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_EXECUTION_FAILED', durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
