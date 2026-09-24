import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolResult } from '@wazir/core';
import { errorMessage } from './paths.js';
import { runFile, runShell } from './process.js';

function generateId(prefix: string = ''): string {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

const OUTPUT_LIMIT = 100_000;
const OUTPUT_HEAD = 20_000;

/** Keeps the start and the end of oversized output: a test or build run's verdict and
 *  failure summary are printed last, so a head-only cut discarded the evidence itself. */
export function boundOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  const omitted = text.length - OUTPUT_LIMIT;
  return `${text.slice(0, OUTPUT_HEAD)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - (OUTPUT_LIMIT - OUTPUT_HEAD))}`;
}

function toToolResult(
  command: string,
  result: Awaited<ReturnType<typeof runShell>>,
  extraMetadata?: Record<string, unknown>,
): ToolResult {
  const output = boundOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
  const details = (result.stderr.trim() || result.stdout.trim() || '').slice(0, 4000);
  const error = result.code === 0
    ? undefined
    : `${command} exited with code ${result.code}${result.timedOut ? ' (timed out)' : ''}${details ? `:\n${details}` : ''}`;
  return {
    ok: result.code === 0,
    output,
    error,
    durationMs: result.durationMs,
    metadata: {
      exitCode: result.code,
      timedOut: result.timedOut,
      sandbox: result.sandbox,
      resourceLimited: result.resourceLimited,
      outputSpilled: result.outputSpilled,
      spillPaths: result.spillPaths,
      stdout: result.stdout,
      stderr: result.stderr,
      command,
      durationMs: result.durationMs,
      ...extraMetadata,
    },
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
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default and maximum 120000)' },
      },
      required: ['command'],
    },
    permissions: ['shell_execute'],
    riskLevel: 'high',
    environment: 'local',
    terminatesOnAbort: true,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command ?? '').trim();
    if (!command) {
      return { ok: false, output: '', error: 'empty command', durationMs: 0 };
    }
    const shellInvocationId = generateId('sh-');
    const result = await runShell(command, {
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
      timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : 120_000,
      env: ctx.env,
      networkAllowed: ctx.networkAllowed,
      signal: ctx.signal,
    });
    return toToolResult(command, result, {
      shellInvocationId,
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
    });
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
    terminatesOnAbort: true,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : [];
    if (args.length === 0) {
      return { ok: false, output: '', error: 'git requires arguments', durationMs: 0 };
    }
    const result = await runFile('git', args, {
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
      timeoutMs: 60_000,
      env: ctx.env,
      networkAllowed: ctx.networkAllowed,
      signal: ctx.signal,
    });
    return toToolResult(`git ${args.join(' ')}`, result, {
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
    });
  },
};

interface CheckToolInput {
  script?: string;
  timeoutMs?: number;
}

async function readProjectScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: unknown };
    return pkg.scripts && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Check tools are auto-allowed by policy, so they must never run caller-supplied
// shell text: only a script name that already exists in package.json is accepted.
function makeCheckTool(name: string, description: string, defaultScript: string, permission: 'test_run' | 'build_run'): Tool {
  return {
    descriptor: {
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: `npm script name from package.json to run instead of '${defaultScript}'. Must already be defined in the project; arbitrary commands are rejected.`,
          },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 300000)' },
        },
      },
      permissions: [permission],
      riskLevel: 'low',
      environment: 'local',
      // The registry's ceiling must match the advertised default, or a check is cut off at 120s.
      timeoutMs: 300_000,
      terminatesOnAbort: true,
    },
    async execute(input: CheckToolInput, ctx): Promise<ToolResult> {
      const started = Date.now();
      const script = typeof input.script === 'string' && input.script.trim() ? input.script.trim() : defaultScript;
      const scripts = await readProjectScripts(ctx.projectRoot);
      if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
        return {
          ok: false,
          output: '',
          error: `missing script: '${script}' is not defined in package.json scripts; refusing to run an arbitrary command`,
          durationMs: Date.now() - started,
        };
      }
      const command = `npm run ${script}`;
      try {
        const result = await runFile('npm', ['run', script], {
          cwd: ctx.projectRoot,
          projectRoot: ctx.projectRoot,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : 300_000,
          env: ctx.env,
          networkAllowed: ctx.networkAllowed,
          signal: ctx.signal,
        });
        return toToolResult(command, result, {
          cwd: ctx.projectRoot,
          projectRoot: ctx.projectRoot,
        });
      } catch (error) {
        return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started };
      }
    },
  };
}

export const testTool = makeCheckTool(
  'test',
  'Run the project test suite (npm script "test").',
  'test',
  'test_run',
);

export const lintTool = makeCheckTool(
  'lint',
  'Run the project linter (npm script "lint").',
  'lint',
  'build_run',
);

export const typecheckTool = makeCheckTool(
  'typecheck',
  'Run the project type checker (npm script "typecheck").',
  'typecheck',
  'build_run',
);

export const buildTool = makeCheckTool(
  'build',
  'Build the project (npm script "build").',
  'build',
  'build_run',
);
