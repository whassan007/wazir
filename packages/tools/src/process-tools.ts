import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { keepEnds, type Tool, type ToolResult } from '@wazir/core';
import { errorMessage } from './paths.js';
import { runFile, runShell } from './process.js';

function generateId(prefix: string = ''): string {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

/** Keeps the start and the end of oversized output: a test or build run's verdict and
 *  failure summary are printed last, so a head-only cut discarded the evidence itself. */
export function boundOutput(text: string): string {
  return keepEnds(text, 100_000, 20_000);
}

function toToolResult(
  command: string,
  result: Awaited<ReturnType<typeof runShell>>,
  extraMetadata?: Record<string, unknown>,
): ToolResult {
  const output = boundOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
  const details = keepEnds(result.stderr.trim() || result.stdout.trim() || '', 4000);
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
  /** Scope the check to these workspace package names (e.g. "@wazir/agents") instead of
   *  running the root script across the whole monorepo. A workspace missing this script is
   *  skipped (`--if-present`), not treated as a failure. Omit to run the full, unscoped
   *  root script — the safe default when scoping can't be determined. */
  workspaces?: string[];
}

type CheckName = 'test' | 'lint' | 'typecheck' | 'build';

interface PackageScriptsResult {
  exists: boolean;
  scripts: Record<string, string>;
}

async function readProjectScripts(projectRoot: string): Promise<PackageScriptsResult> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: unknown };
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, string>) : {};
    return { exists: true, scripts };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, scripts: {} };
    }
    return { exists: true, scripts: {} };
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface DetectedCheckCommand {
  projectType: string | null;
  command: { file: string; args: string[] } | null;
}

const RUST_CHECK_ARGS: Record<CheckName, string[]> = {
  test: ['test'],
  lint: ['clippy'],
  typecheck: ['check'],
  build: ['build'],
};

const GO_CHECK_ARGS: Record<CheckName, string[]> = {
  test: ['test', './...'],
  lint: ['vet', './...'],
  typecheck: ['vet', './...'],
  build: ['build', './...'],
};

async function detectNonNodeCheck(projectRoot: string, checkName: CheckName): Promise<DetectedCheckCommand> {
  if (await fileExists(path.join(projectRoot, 'Cargo.toml'))) {
    return { projectType: 'rust', command: { file: 'cargo', args: RUST_CHECK_ARGS[checkName] } };
  }
  if (await fileExists(path.join(projectRoot, 'go.mod'))) {
    return { projectType: 'go', command: { file: 'go', args: GO_CHECK_ARGS[checkName] } };
  }
  const hasPythonManifest = (
    await Promise.all([
      fileExists(path.join(projectRoot, 'pyproject.toml')),
      fileExists(path.join(projectRoot, 'pytest.ini')),
      fileExists(path.join(projectRoot, 'setup.py')),
      fileExists(path.join(projectRoot, 'setup.cfg')),
    ])
  ).some(Boolean);
  if (hasPythonManifest) {
    if (checkName === 'test') {
      return { projectType: 'python', command: { file: 'pytest', args: [] } };
    }
    // Fall through to Makefile check in case a Python/mixed repo defines lint/build targets there.
  }

  const makefilePath = path.join(projectRoot, 'Makefile');
  try {
    const makefile = await fs.readFile(makefilePath, 'utf8');
    const targetPattern = new RegExp(`^${checkName}\\s*:`, 'm');
    if (targetPattern.test(makefile)) {
      return {
        projectType: hasPythonManifest ? 'python' : 'make',
        command: { file: 'make', args: [checkName] },
      };
    }
  } catch {
    // No Makefile or unreadable; fall through.
  }

  return { projectType: hasPythonManifest ? 'python' : null, command: null };
}

// Check tools are auto-allowed by policy, so they must never run caller-supplied
// shell text: only a script name that already exists in package.json (or a fixed
// manifest-detected command for non-Node repos) is accepted.
function makeCheckTool(name: string, description: string, defaultScript: CheckName, permission: 'test_run' | 'build_run'): Tool {
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
          workspaces: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace package names to scope this check to, instead of the whole repo.',
          },
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
      const requestedScript = typeof input.script === 'string' && input.script.trim() ? input.script.trim() : undefined;
      const script = requestedScript ?? defaultScript;
      const { exists: hasPackageJson, scripts } = await readProjectScripts(ctx.projectRoot);

      if (!hasPackageJson) {
        if (requestedScript) {
          return {
            ok: false,
            output: '',
            error: `missing script: no package.json in project root; refusing to run arbitrary script '${requestedScript}'`,
            durationMs: Date.now() - started,
          };
        }
        const detected = await detectNonNodeCheck(ctx.projectRoot, defaultScript);
        if (!detected.command) {
          return {
            ok: true,
            output: `not applicable: no package.json in ${ctx.projectRoot}${detected.projectType ? ` (${detected.projectType} project has no default '${defaultScript}' command)` : ' and no recognized project manifest'}`,
            durationMs: Date.now() - started,
            metadata: {
              applicable: false,
              reason: 'no_package_json',
              projectType: detected.projectType ?? 'unknown',
              check: defaultScript,
              cwd: ctx.projectRoot,
              projectRoot: ctx.projectRoot,
            },
          };
        }
        const command = [detected.command.file, ...detected.command.args].join(' ');
        try {
          const result = await runFile(detected.command.file, detected.command.args, {
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
            projectType: detected.projectType,
          });
        } catch (error) {
          return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started };
        }
      }

      if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
        return {
          ok: false,
          output: '',
          error: `missing script: '${script}' is not defined in package.json scripts; refusing to run an arbitrary command`,
          durationMs: Date.now() - started,
        };
      }
      const workspaces = Array.isArray(input.workspaces)
        ? input.workspaces.filter((w): w is string => typeof w === 'string' && w.length > 0)
        : [];
      // --if-present: a workspace that doesn't define this script is skipped, not a failure —
      // scoping to "the packages this task touched" must not fail a check that package never had.
      const args = workspaces.length
        ? ['run', script, ...workspaces.flatMap((w) => ['--workspace', w]), '--if-present']
        : ['run', script];
      const command = `npm ${args.join(' ')}`;
      try {
        const result = await runFile('npm', args, {
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
          workspaces,
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
