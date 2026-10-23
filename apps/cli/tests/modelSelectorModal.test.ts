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
    const flat = renderedLines.map(l => stripAnsiStr(l)).join('\n');

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
    const flat = rendered.map(l => stripAnsiStr(l)).join('\n');
    expect(flat).toContain('qwen2.5-coder:7b');
    expect(flat).toContain('● LOADED');
    expect(flat).toContain('✗ INELIGIBLE (insufficient RAM');

    // Test typing search query
    controller.handleKey('c');
    expect(controller.searchQuery).toBe('c');
    const filtered = controller.getFilteredModels();
    expect(filtered.some(m => m.modelId.includes('coder'))).toBe(true);

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
});
