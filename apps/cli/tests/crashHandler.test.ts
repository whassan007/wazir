import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixturesDir = path.join(__dirname, 'fixtures');
const logsDir = path.join(os.homedir(), '.wazir', 'logs');

function runFixture(name: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', ['--experimental-strip-types', path.join(fixturesDir, name)], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function logFilesBefore(): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(logsDir));
  } catch {
    return new Set();
  }
}

async function newestLogFile(before: Set<string>): Promise<string | undefined> {
  try {
    const after = await fs.readdir(logsDir);
    const created = after.filter((f) => !before.has(f));
    return created[0] ? path.join(logsDir, created[0]) : undefined;
  } catch {
    return undefined;
  }
}

describe('global crash handlers (real subprocess)', () => {
  it('exits 1, restores the terminal escape sequence, and writes a crash log on uncaughtException', async () => {
    const before = await logFilesBefore();
    const result = runFixture('crashFixtureUncaught.ts');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fatal uncaughtException');
    expect(result.stderr).toContain('boom-uncaught');

    const logFile = await newestLogFile(before);
    expect(logFile).toBeTruthy();
    const contents = await fs.readFile(logFile!, 'utf8');
    expect(contents).toContain('boom-uncaught');
    expect(contents).toContain('Wazir crash report');

    const stat = await fs.stat(logFile!);
    // 0600: owner read/write only, matching the crash report's stated permissions.
    expect(stat.mode & 0o777).toBe(0o600);

    await fs.unlink(logFile!).catch(() => undefined);
  });

  it('exits 1 and writes a crash log on an unhandled rejection with no scoped handler installed', async () => {
    const before = await logFilesBefore();
    const result = runFixture('crashFixtureRejection.ts');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fatal unhandledRejection');
    expect(result.stderr).toContain('boom-rejection');

    const logFile = await newestLogFile(before);
    expect(logFile).toBeTruthy();
    await fs.unlink(logFile!).catch(() => undefined);
  });

  it('withScopedRejectionHandler intercepts rejections while active, and restore() puts the fatal handler back', async () => {
    const before = await logFilesBefore();
    const result = runFixture('crashFixtureScoped.ts');

    // The scoped handler caught the first rejection (process stayed alive to print this)...
    expect(result.stdout).toContain('RECOVERED:true');
    // ...but the second rejection, after restore(), hit the fatal default and crashed.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('post-restore-boom');

    const logFile = await newestLogFile(before);
    expect(logFile).toBeTruthy();
    await fs.unlink(logFile!).catch(() => undefined);
  });
});
