import type { Tool, ToolExecutionContext, ToolResult } from '@rook/core';
import { errorMessage } from './paths.js';
import { runFile, runShell } from './process.js';

function toToolResult(command: string, result: Awaited<ReturnType<typeof runShell>>): ToolResult {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 100_000);
  return {
    ok: result.code === 0,
    output,
    error: result.code === 0 ? undefined : `${command} exited with code ${result.code}${result.timedOut ? ' (timed out)' : ''}`,
    durationMs: result.durationMs,
    metadata: { exitCode: result.code, timedOut: result.timedOut },
  };
}

export const shellTool: Tool = {
  descriptor: {
    name: 'shell',
    description: 'Run a shell command inside the project root. Policy decides what is allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command line' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      },
      required: ['command'],
    },
    permissions: ['shell_execute'],
    riskLevel: 'high',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command ?? '').trim();
    if (!command) {
      return { ok: false, output: '', error: 'empty command', durationMs: 0 };
    }
    const result = await runShell(command, {
      cwd: ctx.projectRoot,
      timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : 120_000,
      env: ctx.env,
    });
    return toToolResult(command, result);
  },
};

export const gitTool: Tool = {
  descriptor: {
    name: 'git',
    description: 'Run a git command (argument array, no shell). Policy classifies the verb.',
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'git arguments, e.g. ["status", "-s"]' },
      },
      required: ['args'],
    },
    permissions: ['git_execute'],
    riskLevel: 'medium',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : [];
    if (args.length === 0) {
      return { ok: false, output: '', error: 'git requires arguments', durationMs: 0 };
    }
    const result = await runFile('git', args, { cwd: ctx.projectRoot, timeoutMs: 60_000, env: ctx.env });
    return toToolResult(`git ${args.join(' ')}`, result);
  },
};

interface CheckToolInput {
  command?: string;
  timeoutMs?: number;
}

function makeCheckTool(name: string, description: string, defaultCommand: string, permission: 'test_run' | 'build_run'): Tool {
  return {
    descriptor: {
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: `Override command (default: ${defaultCommand})` },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 300000)' },
        },
      },
      permissions: [permission],
      riskLevel: 'low',
      environment: 'local',
    },
    async execute(input: CheckToolInput, ctx): Promise<ToolResult> {
      const command = typeof input.command === 'string' && input.command.trim() ? input.command.trim() : defaultCommand;
      const started = Date.now();
      try {
        const result = await runShell(command, {
          cwd: ctx.projectRoot,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : 300_000,
          env: ctx.env,
        });
        return toToolResult(command, result);
      } catch (error) {
        return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started };
      }
    },
  };
}

export const testTool = makeCheckTool(
  'test',
  'Run the project test suite (default: npm test).',
  'npm test',
  'test_run',
);

export const lintTool = makeCheckTool(
  'lint',
  'Run the project linter (default: npm run lint).',
  'npm run lint',
  'build_run',
);

export const typecheckTool = makeCheckTool(
  'typecheck',
  'Run the project type checker (default: npm run typecheck).',
  'npm run typecheck',
  'build_run',
);

export const buildTool = makeCheckTool(
  'build',
  'Build the project (default: npm run build).',
  'npm run build',
  'build_run',
);
