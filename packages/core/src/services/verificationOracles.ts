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
    const root = path.resolve(params.cwd ?? this.projectRoot);
    const criteria = (params.metadata?.criteria ?? []) as string[];
    const reasons: string[] = [];
    let failed = false;
    // A criterion this oracle cannot evaluate is never silently a PASS.
    let unverifiable = false;
    const inside = (target: string): string | undefined => {
      const full = path.resolve(root, target);
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
      // Resolve symlinks for existing paths so a link cannot point outside the workspace.
      try {
        const real = fs.realpathSync(full);
        const realRoot = fs.realpathSync(root);
        const realRel = path.relative(realRoot, real);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) return undefined;
      } catch { /* missing path: existence check reports it */ }
      return full;
    };

    if (criteria.length === 0) {
      unverifiable = true;
      reasons.push('Acceptance unverifiable: no machine-checkable criteria were supplied');
    }

    for (const c of criteria) {
      if (typeof c !== 'string') {
        unverifiable = true;
        reasons.push('Acceptance unverifiable: criterion is not a string');
      } else if (c.startsWith('file_exists:')) {
        const target = c.replace('file_exists:', '').trim();
        const full = target ? inside(target) : undefined;
        if (!full) {
          failed = true;
          reasons.push(`Acceptance failed: '${target}' is empty or outside the workspace`);
        } else if (!fs.existsSync(full)) {
          failed = true;
          reasons.push(`Acceptance failed: File '${target}' does not exist`);
        } else {
          reasons.push(`File '${target}' exists`);
        }
      } else if (c.startsWith('file_contains:')) {
        const parts = c.replace('file_contains:', '').trim().split('::');
        const file = parts[0]?.trim();
        const pattern = parts[1]?.trim();
        if (file && pattern) {
          const full = inside(file);
          try {
            if (!full) throw new Error('outside workspace');
            const content = fs.readFileSync(full, 'utf8');
            if (!content.includes(pattern)) {
              failed = true;
              reasons.push(`Acceptance failed: File '${file}' does not contain '${pattern}'`);
            } else {
              reasons.push(`File '${file}' contains expected pattern`);
            }
          } catch {
            failed = true;
            reasons.push(`Acceptance failed: Cannot read file '${file}'`);
          }
        } else {
          unverifiable = true;
          reasons.push(`Acceptance unverifiable: malformed criterion '${c}' (expected file_contains:<file>::<pattern>)`);
        }
      } else {
        unverifiable = true;
        reasons.push(`Acceptance unverifiable: unsupported criterion '${c}'`);
      }
    }
    const ok = !failed && !unverifiable;

    return {
      exitCode: ok ? 0 : 1,
      output: reasons.join('\n'),
      status: ok ? 'PASS' : failed ? 'FAIL' : 'ERROR',
      reasons,
    };
  }
}

import { BrowserVerificationService } from './browserVerificationService.js';
import type { BrowserVerificationSpec } from '../types/browserVerification.js';

export class BrowserOracle implements VerificationOracle {
  readonly type: OracleType = 'BROWSER';
  private readonly browserService = new BrowserVerificationService();

  async verify(params: { metadata?: Record<string, unknown> }): Promise<{
    exitCode: number;
    output: string;
    status: VerificationStatus;
    reasons: string[];
  }> {
    const spec = params.metadata?.spec as BrowserVerificationSpec | undefined;
    if (spec) {
      const res = await this.browserService.verify(spec);
      return {
        exitCode: res.ok ? 0 : 1,
        output: res.reasons.join('\n'),
        status: res.ok ? 'PASS' : 'FAIL',
        reasons: res.reasons,
      };
    }

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
