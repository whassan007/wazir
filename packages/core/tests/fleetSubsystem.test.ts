import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseFleetCommand,
  FleetParseError,
  planFleetOperation,
  enrichFleetPlan,
  parseTailscaleStatusJson,
  parseHostMetricsOutput,
  extractProgressPercent,
  executeFleetPlanDryRun,
  writeSharedFleetState,
  readSharedFleetState,
  type FleetHostConfig,
} from '../src/fleet/index.js';

const SAMPLE_HOSTS: FleetHostConfig[] = [
  {
    id: 'jetson',
    name: 'Jetson AGX Thor',
    aliases: ['thor'],
    os: 'linux',
    tailscaleIP: '100.83.18.14',
    sshTarget: 'jetson',
    memoryGB: 128,
    runtimes: [{ kind: 'ollama', port: 11434 }],
  },
  {
    id: 'dgx',
    name: 'DGX Spark',
    aliases: ['spark'],
    os: 'linux',
    tailscaleIP: '100.113.62.112',
    sshTarget: 'dgx',
    memoryGB: 128,
    runtimes: [
      { kind: 'ollama', port: 11434 },
      { kind: 'lmstudio', port: 1234 },
    ],
  },
];

describe('Wazir Core Fleet Subsystem', () => {
  it('parses natural-language and structured fleet commands deterministically', () => {
    const parsed = parseFleetCommand('pull llama3.2:3b to dgx via ollama --live', new Set(['dgx', 'jetson']));
    expect(parsed.type).toBe('model');
    if (parsed.type === 'model') {
      expect(parsed.command.verb).toBe('add');
      expect(parsed.command.models).toEqual(['llama3.2:3b']);
      expect(parsed.command.runtime).toBe('ollama');
      expect(parsed.command.mode).toBe('live');
      expect(parsed.command.target).toEqual({ kind: 'hosts', hosts: ['dgx'] });
    }
  });

  it('rejects shell injection in model names', () => {
    for (const bad of ['qwen;rm -rf /', '$(reboot)', '../etc/passwd', '-rf', 'qwen|nc']) {
      expect(() => parseFleetCommand(`add ${bad} on jetson`)).toThrow(FleetParseError);
    }
  });

  it('plans Ollama pull, reload (unload+load), and enriches memory warnings', () => {
    const parsed = parseFleetCommand('add qwen3:235b on jetson');
    expect(parsed.type).toBe('model');
    if (parsed.type === 'model') {
      const plan = planFleetOperation({
        command: parsed.command,
        input: 'add qwen3:235b on jetson',
        hosts: SAMPLE_HOSTS,
      });
      expect(plan.dryRun).toBe(true);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]?.action.type).toBe('ollamaPull');

      const enriched = enrichFleetPlan(
        plan,
        { 'qwen3:235b': { status: 'found', bytes: 120 * 1_073_741_824 } },
        SAMPLE_HOSTS,
      );
      expect(enriched.warnings.some((w) => w.includes('may not fit'))).toBe(true);
      expect(enriched.warnings.some((w) => w.includes('Large download'))).toBe(true);

      const execRecord = executeFleetPlanDryRun(enriched);
      expect(execRecord.status).toBe('completed');
      expect(execRecord.dryRun).toBe(true);
    }
  });

  it('parses Tailscale status JSON, Linux/Windows metrics, and progress percentages', () => {
    const peers = parseTailscaleStatusJson(
      JSON.stringify({
        Self: { HostName: 'macbook', TailscaleIPs: ['100.80.184.43'], Online: true },
        Peer: { p1: { HostName: 'dgx', TailscaleIPs: ['100.113.62.112'], Online: true } },
      }),
    );
    expect(peers).toHaveLength(2);

    const metrics = parseHostMetricsOutput(
      'os=Linux 6.8\ncpus=20\nmemTotalKB=134217728\ngpu=NVIDIA GB10, 12, [N/A], [N/A], 42',
    );
    expect(metrics.cpuCount).toBe(20);
    expect(metrics.gpus[0]?.name).toBe('NVIDIA GB10');
    expect(metrics.gpus[0]?.memoryUsedMB).toBeUndefined();

    expect(extractProgressPercent('downloading 45.5%')).toBeCloseTo(0.455);
  });

  it('persists and reads shared fleet-state.json in WAZIR_HOME', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-fleet-state-'));
    try {
      writeSharedFleetState(
        {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          source: 'test',
          hosts: [{ id: 'local', name: 'Local', online: true, loadedModels: ['qwen3:8b'], installedModels: ['qwen3:8b'] }],
        },
        tmp,
      );
      const read = readSharedFleetState(tmp);
      expect(read?.hosts[0]?.loadedModels).toEqual(['qwen3:8b']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
