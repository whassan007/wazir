import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { OracleType, VerificationStatus } from '../types/verification.js';
import type { VerificationOracle } from './verificationEngine.js';

const execAsync = promisify(exec);

export type CommandRunner = (command: string, cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultCommandRunner: CommandRunner = async (command: string, cwd: string) => {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 120_000 });
    return { exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err: any) {
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : err.message,
    };
  }
};

export class BuildOracle implements VerificationOracle {
  readonly type: OracleType = 'BUILD';

  constructor(
    private readonly defaultCommand = 'npm run build',
    private readonly runner: CommandRunner = defaultCommandRunner,
  ) {}

  async verify(params: { command?: string; cwd?: string }): Promise<{
    exitCode: number;
    output: string;
    status: VerificationStatus;
    reasons?: string[];
  }> {
    const cmd = params.command ?? this.defaultCommand;
    const res = await this.runner(cmd, params.cwd ?? process.cwd());
    const combined = (res.stdout + '\n' + res.stderr).trim();
    const status: VerificationStatus = res.exitCode === 0 ? 'PASS' : 'FAIL';
    return {
      exitCode: res.exitCode,
      output: combined,
      status,
      reasons: res.exitCode === 0 ? ['Build succeeded'] : [`Build failed with code ${res.exitCode}`],
    };
  }
}

export class TestOracle implements VerificationOracle {
  readonly type: OracleType = 'TEST';

  constructor(
    private readonly defaultCommand = 'npm test',
    private readonly runner: CommandRunner = defaultCommandRunner,
  ) {}

  async verify(params: { command?: string; cwd?: string }): Promise<{
    exitCode: number;
    output: string;
    status: VerificationStatus;
    reasons?: string[];
  }> {
    const cmd = params.command ?? this.defaultCommand;
    const res = await this.runner(cmd, params.cwd ?? process.cwd());
    const combined = (res.stdout + '\n' + res.stderr).trim();
    const status: VerificationStatus = res.exitCode === 0 ? 'PASS' : 'FAIL';
    return {
      exitCode: res.exitCode,
      output: combined,
      status,
      reasons: res.exitCode === 0 ? ['All tests passed'] : [`Tests failed with code ${res.exitCode}`],
    };
  }
}

export class StaticOracle implements VerificationOracle {
  readonly type: OracleType = 'STATIC_ANALYSIS';

  constructor(
    private readonly defaultCommand = 'npm run typecheck',
    private readonly runner: CommandRunner = defaultCommandRunner,
  ) {}

  async verify(params: { command?: string; cwd?: string }): Promise<{
    exitCode: number;
    output: string;
    status: VerificationStatus;
    reasons?: string[];
  }> {
    const cmd = params.command ?? this.defaultCommand;
    const res = await this.runner(cmd, params.cwd ?? process.cwd());
    const combined = (res.stdout + '\n' + res.stderr).trim();
    const status: VerificationStatus = res.exitCode === 0 ? 'PASS' : 'FAIL';
    return {
      exitCode: res.exitCode,
      output: combined,
      status,
      reasons: res.exitCode === 0 ? ['Static checks clean'] : [`Static checks failed with code ${res.exitCode}`],
    };
  }
}

export class AcceptanceOracle implements VerificationOracle {
  readonly type: OracleType = 'ACCEPTANCE';

  constructor(private readonly projectRoot: string = process.cwd()) {}

  async verify(params: {
    metadata?: Record<string, unknown>;
    cwd?: string;
  }): Promise<{
    exitCode: number;
    output: string;
    status: VerificationStatus;
    reasons: string[];
  }> {
    const root = params.cwd ?? this.projectRoot;
    const criteria = (params.metadata?.criteria ?? []) as string[];
    const reasons: string[] = [];
    let ok = true;

    for (const c of criteria) {
      if (c.startsWith('file_exists:')) {
        const target = c.replace('file_exists:', '').trim();
        const full = path.resolve(root, target);
        if (!fs.existsSync(full)) {
          ok = false;
          reasons.push(`Acceptance failed: File '${target}' does not exist`);
        } else {
          reasons.push(`File '${target}' exists`);
        }
      } else if (c.startsWith('file_contains:')) {
        const parts = c.replace('file_contains:', '').trim().split('::');
        const file = parts[0]?.trim();
        const pattern = parts[1]?.trim();
        if (file && pattern) {
          const full = path.resolve(root, file);
          try {
            const content = fs.readFileSync(full, 'utf8');
            if (!content.includes(pattern)) {
              ok = false;
              reasons.push(`Acceptance failed: File '${file}' does not contain '${pattern}'`);
            } else {
              reasons.push(`File '${file}' contains expected pattern`);
            }
          } catch {
            ok = false;
            reasons.push(`Acceptance failed: Cannot read file '${file}'`);
          }
        }
      }
    }

    return {
      exitCode: ok ? 0 : 1,
      output: reasons.join('\n'),
      status: ok ? 'PASS' : 'FAIL',
      reasons,
    };
  }
}

export class BrowserOracle implements VerificationOracle {
  readonly type: OracleType = 'BROWSER';

  async verify(params: { metadata?: Record<string, unknown> }): Promise<{
    exitCode: number;
    output: string;
    status: VerificationStatus;
    reasons: string[];
  }> {
    const assertions = (params.metadata?.assertions ?? []) as Array<{ ok: boolean; message: string }>;
    const failed = assertions.filter((a) => !a.ok);
    const ok = failed.length === 0;

    return {
      exitCode: ok ? 0 : 1,
      output: assertions.map((a) => `[${a.ok ? 'OK' : 'FAIL'}] ${a.message}`).join('\n'),
      status: ok ? 'PASS' : 'FAIL',
      reasons: ok ? ['Browser assertions verified'] : failed.map((f) => f.message),
    };
  }
}
