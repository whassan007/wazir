import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INFERENCE_ENDPOINTS,
  ExecutionBackendRegistry,
  loadUbuntuSettings,
  saveUbuntuSettings,
  selectEndpointByStrategy,
} from '../../packages/ubuntu-os/src/index.js';

describe('Replaceable Execution Backends & Inference Providers (Agents 03, 04, 09)', () => {
  it('supports switching execution backends and pins active tasks to their initial backend', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-backend-'));
    const cfgPath = path.join(tmpDir, 'backend.json');
    const reg = new ExecutionBackendRegistry(cfgPath);

    expect(reg.getActiveId()).toBe('wazir-native');
    expect(reg.inspect('wazir-native')?.capabilities.checkpointResume).toBe(true);
    expect(reg.inspect('qwen-code')?.capabilities.checkpointResume).toBe(false);

    // Start task on wazir-native
    const task1Backend = reg.getBackendForExecution('exec-1');
    expect(task1Backend.id).toBe('wazir-native');

    // Switch global default backend to qwen-code mid-flight
    reg.use('qwen-code');
    expect(reg.getActiveId()).toBe('qwen-code');

    // Existing running execution remains pinned to wazir-native
    expect(reg.getBackendForExecution('exec-1').id).toBe('wazir-native');
    // New execution uses qwen-code
    expect(reg.getBackendForExecution('exec-2').id).toBe('qwen-code');

    // Reloading persists selection, reset restores wazir-native
    const reg2 = new ExecutionBackendRegistry(cfgPath);
    expect(reg2.getActiveId()).toBe('qwen-code');
    reg2.reset();
    expect(reg2.getActiveId()).toBe('wazir-native');

    const health = await reg2.test('wazir-native');
    expect(health.healthy).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces local-only routing and persists Ubuntu settings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-settings-'));
    const settingsPath = path.join(tmpDir, 'ubuntu-settings.json');

    const endpoints = [
      ...DEFAULT_INFERENCE_ENDPOINTS,
      {
        id: 'cloud-openai',
        kind: 'openai-compatible' as const,
        baseUrl: 'https://api.openai.com/v1',
        local: false,
        enabled: true,
      },
    ];

    const localOnlyHit = selectEndpointByStrategy(endpoints, 'local-only', true, 'cloud-openai');
    expect(localOnlyHit?.local).toBe(true);
    expect(localOnlyHit?.id).not.toBe('cloud-openai');

    const s = loadUbuntuSettings(settingsPath);
    s.activeBackendId = 'qwen-code';
    s.localOnly = true;
    saveUbuntuSettings(s, settingsPath);

    const reloaded = loadUbuntuSettings(settingsPath);
    expect(reloaded.activeBackendId).toBe('qwen-code');
    expect(reloaded.localOnly).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
