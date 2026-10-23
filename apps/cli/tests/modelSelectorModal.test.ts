import { describe, it, expect } from 'vitest';
import {
  ModelSelectorController,
  renderModelSelectorModal,
  renderModelSelectionConfirmation,
  formatSelectionDetails,
  type ModelSelectorItem,
} from '../src/tui/modelSelectorModal.js';
import { stripAnsiStr } from '../src/tui/fleetTuiTypes.js';

describe('ModelSelectorModal', () => {
  const sampleModels: ModelSelectorItem[] = [
    {
      modelId: 'qwen2.5-coder:7b',
      name: 'Qwen 2.5 Coder 7B',
      provider: 'ollama',
      costTier: 'T1',
      available: true,
      loaded: true,
      local: true,
      eligible: true,
      memoryGB: 6.5,
      contextMax: 32768,
      deviceLabel: 'Apple M2 Max',
    },
    {
      modelId: 'llama3:8b',
      name: 'Llama 3 8B',
      provider: 'ollama',
      costTier: 'T1',
      available: false,
      loaded: false,
      local: true,
      eligible: false,
      ineligibleReason: 'insufficient RAM (requires 16GB)',
      memoryGB: 16.0,
      contextMax: 8192,
      deviceLabel: 'Apple M2 Max',
    },
    {
      modelId: 'claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
      costTier: 'T3',
      available: true,
      loaded: false,
      local: false,
      eligible: true,
      contextMax: 200000,
      deviceLabel: 'Hosted Cloud API',
    },
  ];

  it('renders exact WAZIR — Select Model layout with modes and footer hints', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    const renderedLines = renderModelSelectorModal(controller, 90);
    const flat = renderedLines.map((l) => stripAnsiStr(l)).join('\n');

    expect(flat).toContain('WAZIR — Select Model');
    expect(flat).toContain('Auto (recommended)');
    expect(flat).toContain('Fast');
    expect(flat).toContain('Balanced');
    expect(flat).toContain('Powerful');
    expect(flat).toContain('Local');
    expect(flat).toContain('Custom');
    expect(flat).toContain('Current: Auto');
    expect(flat).toContain('Reasoning effort: Medium');
    expect(flat).toContain('Navigate');
    expect(flat).toContain('Effort');
    expect(flat).toContain('Set default');
    expect(flat).toContain('Session only');
    expect(flat).toContain('Cancel');
  });

  it('supports arrow key navigation and reasoning effort cycling', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    expect(controller.selectedIndex).toBe(0);

    controller.handleKey('down');
    expect(controller.selectedIndex).toBe(1);

    controller.handleKey('up');
    expect(controller.selectedIndex).toBe(0);

    expect(controller.reasoningEffort).toBe('medium');
    controller.handleKey('right'); // medium -> high
    expect(controller.reasoningEffort).toBe('high');

    controller.handleKey('left'); // high -> medium -> low
    controller.handleKey('left');
    expect(controller.reasoningEffort).toBe('low');
  });

  it('handles Enter for persistent default and S for session-only', () => {
    const controller1 = new ModelSelectorController({ models: sampleModels });
    controller1.selectedIndex = 1; // Fast
    const action1 = controller1.handleKey('enter');
    expect(action1).toEqual({
      type: 'select',
      scope: 'default',
      mode: 'fast',
      reasoningEffort: 'medium',
    });
    expect(controller1.isOpen).toBe(false);

    const controller2 = new ModelSelectorController({ models: sampleModels });
    controller2.selectedIndex = 2; // Balanced
    const action2 = controller2.handleKey('S');
    expect(action2).toEqual({
      type: 'select',
      scope: 'session',
      mode: 'balanced',
      reasoningEffort: 'medium',
    });
    expect(controller2.isOpen).toBe(false);
  });

  it('supports custom mode searchable model list, filters, availability indicators, and ineligible rejection', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    controller.view = 'custom';

    const rendered = renderModelSelectorModal(controller, 90);
    const flat = rendered.map((l) => stripAnsiStr(l)).join('\n');
    expect(flat).toContain('qwen2.5-coder:7b');
    expect(flat).toContain('● LOADED');
    expect(flat).toContain('✗ INELIGIBLE (insufficient RAM');

    // Test typing search query
    controller.handleKey('c');
    expect(controller.searchQuery).toBe('c');
    const filtered = controller.getFilteredModels();
    expect(filtered.some((m) => m.modelId.includes('coder'))).toBe(true);

    // Test selecting ineligible model returns rejected action and warning message
    controller.searchQuery = '';
    controller.selectedIndex = 1; // llama3:8b (ineligible)
    const action = controller.handleKey('enter');
    expect(action.type).toBe('rejected');
    expect(controller.warningMessage).toContain('Ineligible');
    expect(controller.isOpen).toBe(true); // Does not close modal
  });

  it('formats confirmation and selection details correctly', () => {
    const conf = renderModelSelectionConfirmation({
      scope: 'default',
      mode: 'fast',
      reasoningEffort: 'high',
    });
    expect(conf).toContain('Persistent Default');
    expect(conf).toContain('fast');
    expect(conf).toContain('high');

    const details = formatSelectionDetails({
      modelId: 'qwen2.5-coder:7b',
      device: 'Apple M2 Max',
      contextTokens: 32768,
      reason: 'Optimal for local coding',
    });
    expect(details).toContain('Selected: qwen2.5-coder:7b');
    expect(details).toContain('Device: Apple M2 Max');
    expect(details).toContain('32,768 tokens');
    expect(details).toContain('Optimal for local coding');
  });

  it('opens WAZIR — Local Models on selecting Local in modes view, displaying Device, Runtime, Auto Local Routing, and models with status & readiness', () => {
    const localModels: ModelSelectorItem[] = [
      {
        modelId: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: true,
        local: true,
        eligible: true,
        memoryGB: 6.5,
        contextMax: 32768,
        deviceLabel: 'Apple M2 Max',
      },
      {
        modelId: 'phi-3:mini',
        name: 'Phi 3 Mini',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: false,
        local: true,
        eligible: true,
        installed: true,
        memoryGB: 4.0,
        contextMax: 4096,
        deviceLabel: 'Apple M2 Max',
        runtimeHealth: 'healthy',
      },
      {
        modelId: 'llama3:8b',
        name: 'Llama 3 8B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: false,
        local: true,
        eligible: false,
        ineligibleReason: 'insufficient RAM (requires 16GB)',
        memoryGB: 16.0,
        contextMax: 8192,
        deviceLabel: 'Apple M2 Max',
      },
      {
        modelId: 'offline-model',
        name: 'Offline Model',
        provider: 'ollama',
        costTier: 'T1',
        available: false,
        loaded: false,
        local: true,
        eligible: false,
        ineligibleReason: 'runtime offline',
        runtimeHealth: 'unavailable',
      },
    ];

    const controller = new ModelSelectorController({
      models: localModels,
      deviceSummary: 'Apple M2 Max (32GB)',
      runtimeSummary: 'Ollama 0.5.4 (Running)',
    });
    expect(controller.view).toBe('modes');
    controller.selectedIndex = 4; // Local

    const action = controller.handleKey('enter');
    expect(action).toEqual({ type: 'navigate', view: 'local' });
    expect(controller.view).toBe('local');
    expect(controller.selectedIndex).toBe(0);
    expect(controller.isOpen).toBe(true);

    const rendered = renderModelSelectorModal(controller, 90);
    const flat = rendered.map((l) => stripAnsiStr(l)).join('\n');

    expect(flat).toContain('WAZIR — Local Models');
    expect(flat).toContain('Device:');
    expect(flat).toContain('Apple M2 Max (32GB)');
    expect(flat).toContain('Runtime:');
    expect(flat).toContain('Ollama 0.5.4 (Running)');
    expect(flat).toContain('Auto Local Routing');
    expect(flat).toContain('Automatically route among eligible local models');

    // Check all 4 status & readiness badges
    expect(flat).toContain('qwen2.5-coder:7b');
    expect(flat).toContain('Loaded');
    expect(flat).toContain('Ready');

    expect(flat).toContain('phi-3:mini');
    expect(flat).toContain('Installed');
    expect(flat).toContain('Can load');

    expect(flat).toContain('llama3:8b');
    expect(flat).toContain('Insufficient memory');

    expect(flat).toContain('offline-model');
    expect(flat).toContain('Unavailable');
    expect(flat).toContain('Runtime offline');

    // Check footer hints
    expect(flat).toContain('Navigate');
    expect(flat).toContain('Select');
    expect(flat).toContain('Auto local routing');
    expect(flat).toContain('Session only');
    expect(flat).toContain('Back');
  });

  it('renders a clean empty-state message in WAZIR — Local Models when no local models are discovered', () => {
    const cloudOnlyModels: ModelSelectorItem[] = [
      {
        modelId: 'claude-3-5-sonnet',
        name: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
        costTier: 'T3',
        available: true,
        loaded: false,
        local: false,
        eligible: true,
      },
    ];

    const controller = new ModelSelectorController({ models: cloudOnlyModels });
    controller.view = 'local';

    const rendered = renderModelSelectorModal(controller, 90);
    const flat = rendered.map((l) => stripAnsiStr(l)).join('\n');

    expect(flat).toContain('WAZIR — Local Models');
    expect(flat).toContain('Device:');
    expect(flat).toContain('Runtime:');
    expect(flat).toContain('No local models discovered.');
    expect(flat).toContain('Start Ollama or LM Studio (or run /launch lmstudio) to browse local models.');
  });

  it('returns to WAZIR — Select Model at index 4 (Local) when pressing Esc in WAZIR — Local Models', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    controller.view = 'local';
    controller.selectedIndex = 1;

    const action = controller.handleKey('escape');
    expect(action).toEqual({ type: 'navigate', view: 'modes' });
    expect(controller.view).toBe('modes');
    expect(controller.selectedIndex).toBe(4); // Index 4 is Local
    expect(controller.isOpen).toBe(true);

    const rendered = renderModelSelectorModal(controller, 90);
    const flat = rendered.map((l) => stripAnsiStr(l)).join('\n');

    expect(flat).toContain('WAZIR — Select Model');
    expect(flat).toContain('Local');
    expect(flat).toContain('>   Local'); // Cursor at index 4
  });

  it('displays ineligibility warning inside WAZIR — Local Models without closing it when selecting an ineligible model', () => {
    const localModels: ModelSelectorItem[] = [
      {
        modelId: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: true,
        local: true,
        eligible: true,
      },
      {
        modelId: 'llama3:70b',
        name: 'Llama 3 70B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: false,
        local: true,
        eligible: false,
        ineligibleReason: 'insufficient RAM (requires 40GB)',
        memoryGB: 40.0,
      },
    ];

    const controller = new ModelSelectorController({ models: localModels });
    controller.view = 'local';
    controller.selectedIndex = 2; // Row 0 is Auto, Row 1 is qwen, Row 2 is llama3:70b (ineligible)

    const action = controller.handleKey('enter');
    expect(action.type).toBe('rejected');
    if (action.type === 'rejected') {
      expect(action.modelId).toBe('llama3:70b');
    }
    expect(controller.isOpen).toBe(true);
    expect(controller.warningMessage).toContain('insufficient RAM');

    const rendered = renderModelSelectorModal(controller, 90);
    const flat = rendered.map((l) => stripAnsiStr(l)).join('\n');

    expect(flat).toContain('⚠');
    expect(flat).toContain('Cannot select llama3:70b: insufficient RAM (requires 40GB)');
  });

  it('supports / search filtering in WAZIR — Local Models while keeping row 0 as Auto Local Routing', () => {
    const localModels: ModelSelectorItem[] = [
      {
        modelId: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: true,
        local: true,
        eligible: true,
      },
      {
        modelId: 'mistral:7b',
        name: 'Mistral 7B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: false,
        local: true,
        eligible: true,
      },
    ];

    const controller = new ModelSelectorController({ models: localModels });
    controller.view = 'local';

    // Press '/' to start search
    controller.handleKey('/');
    expect(controller.isSearching).toBe(true);

    controller.handleKey('q');
    controller.handleKey('w');
    controller.handleKey('e');
    controller.handleKey('n');
    expect(controller.searchQuery).toBe('qwen');

    const filtered = controller.getFilteredLocalModels();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].modelId).toBe('qwen2.5-coder:7b');

    const rendered = renderModelSelectorModal(controller, 90);
    const flat = rendered.map((l) => stripAnsiStr(l)).join('\n');

    expect(flat).toContain('Auto Local Routing');
    expect(flat).toContain('qwen2.5-coder:7b');
    expect(flat).not.toContain('mistral:7b');
  });

  it('formats structured confirmation with Mode, Model, Scope and backward-compatible summary', () => {
    const conf1 = renderModelSelectionConfirmation({
      scope: 'default',
      mode: 'local',
      modelId: 'qwen2.5-coder:7b',
      reasoningEffort: 'medium',
    });
    expect(conf1).toContain('Persistent Default');
    expect(conf1).toContain('Mode: Local · Model: qwen2.5-coder:7b · Scope: Default');

    const conf2 = renderModelSelectionConfirmation({
      scope: 'session',
      mode: 'local',
      modelId: undefined,
      reasoningEffort: 'high',
    });
    expect(conf2).toContain('Session Only');
    expect(conf2).toContain('Mode: Local · Model: Auto Local · Scope: Session');
  });
});
