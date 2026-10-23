import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModelPreferenceService } from '../src/services/modelPreferenceService.js';

describe('ModelPreferenceService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-pref-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('persists default selection across service restarts', () => {
    const configPath = path.join(tmpDir, 'wazir.json');
    const service1 = new ModelPreferenceService({ configFilePath: configPath });
    
    service1.setDefaultPreference({
      mode: 'balanced',
      reasoningEffort: 'high',
      costTierFilter: 'T2',
    });

    const effective1 = service1.getEffectivePreference();
    expect(effective1.mode).toBe('balanced');
    expect(effective1.reasoningEffort).toBe('high');
    expect(effective1.source).toBe('persistent');

    // Restart service
    const service2 = new ModelPreferenceService({ configFilePath: configPath });
    const effective2 = service2.getEffectivePreference();
    expect(effective2.mode).toBe('balanced');
    expect(effective2.reasoningEffort).toBe('high');
    expect(effective2.source).toBe('persistent');
  });

  it('keeps session-only selection active during session and does not persist on restart or overwrite persistent default', () => {
    const configPath = path.join(tmpDir, 'wazir.json');
    const service = new ModelPreferenceService({ configFilePath: configPath });

    service.setDefaultPreference({ mode: 'fast', reasoningEffort: 'low' });

    // Set session preference
    service.setSessionPreference({
      mode: 'powerful',
      modelId: 'gpt-4o',
      strict: true,
      reasoningEffort: 'high',
    });

    const effectiveSession = service.getEffectivePreference();
    expect(effectiveSession.mode).toBe('powerful');
    expect(effectiveSession.modelId).toBe('gpt-4o');
    expect(effectiveSession.source).toBe('session');

    // Verify persistent storage was NOT overwritten by session preference
    const rawDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(rawDisk.mode).toBe('fast');
    expect(rawDisk.reasoningEffort).toBe('low');

    // Restart service (clears session state) and verify persistent default is intact
    const serviceRestarted = new ModelPreferenceService({ configFilePath: configPath });
    const effectiveRestarted = serviceRestarted.getEffectivePreference();
    expect(effectiveRestarted.mode).toBe('fast');
    expect(effectiveRestarted.reasoningEffort).toBe('low');
    expect(effectiveRestarted.source).toBe('persistent');
  });

  it('applies CLI override precedence over session and persistent settings', () => {
    const service = new ModelPreferenceService();
    service.setDefaultPreference({ mode: 'fast' });
    service.setSessionPreference({ mode: 'balanced' });
    service.setCliOverride({ mode: 'custom', modelId: 'claude-3-5-sonnet', strict: true });

    const effective = service.getEffectivePreference();
    expect(effective.mode).toBe('custom');
    expect(effective.modelId).toBe('claude-3-5-sonnet');
    expect(effective.strict).toBe(true);
    expect(effective.source).toBe('cli-override');
  });

  it('preserves strict model selection flag', () => {
    const service = new ModelPreferenceService();
    service.setDefaultPreference({ mode: 'custom', modelId: 'llama-3', strict: true });

    const effective = service.getEffectivePreference();
    expect(effective.strict).toBe(true);
    expect(effective.displayLabel).toBe('llama-3');
  });

  it('cycles reasoning effort (low <-> medium <-> high) and migrates legacy config', () => {
    const service = new ModelPreferenceService();

    // Default is medium
    expect(service.getEffectivePreference().reasoningEffort).toBe('medium');

    // Cycle next -> high
    let effort = service.cycleReasoningEffort('next', 'default');
    expect(effort).toBe('high');
    expect(service.getEffectivePreference().reasoningEffort).toBe('high');

    // Cycle next -> low
    effort = service.cycleReasoningEffort('next', 'default');
    expect(effort).toBe('low');

    // Cycle prev -> high
    effort = service.cycleReasoningEffort('prev', 'default');
    expect(effort).toBe('high');

    // Test legacy config migration
    const legacyRaw = {
      routing: {
        mode: 'powerful',
        defaultModel: 'gpt-4-legacy',
        provider: 'openai',
      },
      effort: 'low',
    };

    const migrated = service.migrateLegacyConfig(legacyRaw);
    expect(migrated.mode).toBe('powerful');
    expect(migrated.modelId).toBe('gpt-4-legacy');
    expect(migrated.strict).toBe(true);
    expect(migrated.reasoningEffort).toBe('low');
    expect(migrated.providerFilter).toBe('openai');
  });

  it('preserves Auto Local and Pinned Local preferences across session and persistent scopes', () => {
    const configPath = path.join(tmpDir, 'wazir-local.json');
    const service = new ModelPreferenceService({ configFilePath: configPath });

    // 1. Persistent Default: Auto Local
    service.setDefaultPreference({ mode: 'local', modelId: undefined });
    const effPersistentAuto = service.getEffectivePreference();
    expect(effPersistentAuto.mode).toBe('local');
    expect(effPersistentAuto.modelId).toBeUndefined();
    expect(effPersistentAuto.strict).toBe(false);
    expect(effPersistentAuto.displayLabel).toBe('Local (Auto Local)');
    expect(effPersistentAuto.source).toBe('persistent');

    // 2. Session-only: Pinned Local model
    service.setSessionPreference({ mode: 'local', modelId: 'qwen2.5-coder:7b' });
    const effSessionPinned = service.getEffectivePreference();
    expect(effSessionPinned.mode).toBe('local');
    expect(effSessionPinned.modelId).toBe('qwen2.5-coder:7b');
    expect(effSessionPinned.strict).toBe(true);
    expect(effSessionPinned.displayLabel).toBe('Local (qwen2.5-coder:7b)');
    expect(effSessionPinned.source).toBe('session');

    // Clear session and check persistent default again
    service.clearSessionPreference();
    const effBackToPersistent = service.getEffectivePreference();
    expect(effBackToPersistent.displayLabel).toBe('Local (Auto Local)');
    expect(effBackToPersistent.source).toBe('persistent');
  });
});
