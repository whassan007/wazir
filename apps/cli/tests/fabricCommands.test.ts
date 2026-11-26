import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fabricDiagnoseCommand,
  fabricStatusCommand,
  tasksCommand,
} from '../src/commands/fabricCommands.js';

const tempDirs: string[] = [];
const prevHome = process.env.WAZIR_HOME;

function makeTempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-cli-fabric-'));
  tempDirs.push(dir);
  process.env.WAZIR_HOME = dir;
  return dir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.WAZIR_HOME;
  else process.env.WAZIR_HOME = prevHome;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI fabricCommands', () => {
  it('runs fabric status, fabric diagnose, and tasks in an isolated WAZIR_HOME', async () => {
    makeTempHome();

    const diag = await fabricDiagnoseCommand({ json: true });
    expect(diag.code).toBe(0);
    const diagJson = JSON.parse(diag.output) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(diagJson.ok).toBe(true);
    expect(diagJson.checks.some((c) => c.name === 'outboxInboxRoundtrip' && c.ok)).toBe(true);

    const status = await fabricStatusCommand({ json: true });
    expect(status.code).toBe(0);
    const statusJson = JSON.parse(status.output) as { ok: boolean; transport: string };
    expect(statusJson.ok).toBe(true);

    const tasks = await tasksCommand({ json: true });
    expect(tasks.code).toBe(0);
    const tasksJson = JSON.parse(tasks.output) as { ok: boolean; counts: { total: number } };
    expect(tasksJson.ok).toBe(true);
    expect(tasksJson.counts.total).toBe(0);
  });
});
