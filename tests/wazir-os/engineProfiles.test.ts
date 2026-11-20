import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelRecord } from '@wazir/core';
import {
  WazirOsEngineRegistry,
  createDefaultOsEngineConfig,
  inferJobKind,
  loadOsEngineConfig,
  saveOsEngineConfig,
} from '../../packages/models/src/index.js';

const FLEET_MODELS: ModelRecord[] = [
  {
    id: 'liquid/lfm2-2.6b',
    provider: 'ollama',
    local: true,
    capabilities: ['generalChat'],
    toolCalling: false,
    vision: false,
    reasoning: false,
    contextTokens: 32768,
  },
  {
    id: 'gemma4:26b',
    provider: 'ollama',
    local: true,
    capabilities: ['generalChat'],
    toolCalling: true,
    vision: true,
    reasoning: true,
    contextTokens: 131072,
  },
  {
    id: 'qwen3-coder:30b',
    provider: 'ollama',
    local: true,
    capabilities: ['coding'],
    toolCalling: true,
    vision: false,
    reasoning: true,
    contextTokens: 131072,
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    provider: 'nvidia',
    local: false,
    capabilities: ['coding', 'generalChat'],
    toolCalling: true,
    vision: true,
    reasoning: true,
    contextTokens: 131072,
  },
];

describe('Pluggable Wazir OS Engine (Liquid AI / Gemma 4 / Qwen / Super Nemo)', () => {
  it('auto-selects the right engine family per job kind', () => {
    const registry = new WazirOsEngineRegistry(createDefaultOsEngineConfig());

    const edge = registry.resolveForJob({ prompt: 'quick offline tldr' }, FLEET_MODELS);
    expect(edge.profile.id).toBe('liquid-light');
    expect(edge.modelId).toBe('liquid/lfm2-2.6b');

    const vision = registry.resolveForJob({ prompt: 'inspect this UI screenshot' }, FLEET_MODELS);
    expect(vision.profile.id).toBe('gemma4-generic');
    expect(vision.modelId).toBe('gemma4:26b');

    const coding = registry.resolveForJob({ prompt: 'refactor TypeScript auth middleware and run tests' }, FLEET_MODELS);
    expect(coding.profile.id).toBe('qwen-coder');
    expect(coding.modelId).toBe('qwen3-coder:30b');

    const deep = registry.resolveForJob({ prompt: 'prove formal Alloy invariant for distributed lease' }, FLEET_MODELS);
    expect(deep.profile.id).toBe('super-nemo');
    expect(deep.modelId).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
  });

  it('allows replacing the main Wazir OS engine globally or per job', () => {
    const registry = new WazirOsEngineRegistry(createDefaultOsEngineConfig());

    // Replace main OS engine with Gemma 4 generic
    registry.setActiveEngine('gemma4-generic');
    const codingWithGemma = registry.resolveForJob({ jobKind: 'coding' }, FLEET_MODELS);
    expect(codingWithGemma.profile.id).toBe('gemma4-generic');
    expect(codingWithGemma.modelId).toBe('gemma4:26b');
    expect(codingWithGemma.matchedBy).toBe('active-engine');

    // Override just 'coding' to Qwen while keeping Gemma 4 as main OS engine
    registry.setJobOverride('coding', 'qwen-coder');
    const codingOverridden = registry.resolveForJob({ jobKind: 'coding' }, FLEET_MODELS);
    expect(codingOverridden.profile.id).toBe('qwen-coder');
    expect(codingOverridden.modelId).toBe('qwen3-coder:30b');
    expect(codingOverridden.matchedBy).toBe('job-override');

    // Register and activate a custom engine profile
    registry.registerCustomProfile({
      id: 'custom-liquid-edge',
      family: 'custom',
      displayName: 'Custom Liquid Edge',
      description: 'Custom operator profile',
      preferredModelPatterns: ['lfm2'],
      supportedJobs: ['offline-edge', 'quick-chat'],
      capabilities: ['generalChat'],
      toolCalling: false,
      vision: false,
      reasoning: 'low',
      localOnly: true,
      latencyTier: 'ultra-fast',
    });
    registry.setActiveEngine('custom-liquid-edge');
    const customRes = registry.resolveForJob({ jobKind: 'quick-chat' }, FLEET_MODELS);
    expect(customRes.profile.id).toBe('custom-liquid-edge');
    expect(customRes.modelId).toBe('liquid/lfm2-2.6b');
  });

  it('falls back gracefully when the preferred engine model is unavailable or blocked by localOnly', () => {
    const registry = new WazirOsEngineRegistry(createDefaultOsEngineConfig());
    const localOnlyDeep = registry.resolveForJob(
      { jobKind: 'reasoning', localOnly: true },
      FLEET_MODELS,
    );
    // Super Nemo hosted model is excluded by localOnly, so it falls back to local reasoning-capable model
    expect(localOnlyDeep.modelId).not.toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(localOnlyDeep.modelId).toBeTruthy();
  });

  it('persists and reloads OS engine configuration cleanly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-os-engine-'));
    const cfgPath = path.join(tmpDir, 'os-engine.json');

    const registry = new WazirOsEngineRegistry(createDefaultOsEngineConfig());
    registry.setActiveEngine('liquid-light');
    registry.setJobOverride('reasoning', 'super-nemo');
    saveOsEngineConfig(registry.getConfig(), cfgPath);

    const reloaded = loadOsEngineConfig(cfgPath);
    expect(reloaded.activeEngineId).toBe('liquid-light');
    expect(reloaded.jobOverrides.reasoning).toBe('super-nemo');
    expect(inferJobKind('implement bug fix')).toBe('coding');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
