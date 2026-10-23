import { describe, it, expect } from 'vitest';
import { ModelSelectorController, ModelSelectorItem } from '../src/tui/modelSelectorState.js';

describe('ModelSelectorController State Machine', () => {
  const sampleModels: ModelSelectorItem[] = [
    {
      modelId: 'llama3:8b',
      name: 'Llama 3 8B',
      provider: 'ollama',
      costTier: 'T1',
      available: true,
      loaded: false,
      local: true,
      eligible: true,
      installed: true,
      runtimeHealth: 'healthy'
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
      runtimeHealth: 'unavailable'
    },
    {
      modelId: 'gpt-4o',
      name: 'GPT-4o',
      provider: 'openai',
      costTier: 'T3',
      available: true,
      loaded: true,
      local: false,
      eligible: true
    }
  ];

  it('1. Up/Down navigation in modes, local, and custom views (1 keypress = 1 index change)', () => {
    const ctrl = new ModelSelectorController({ models: sampleModels });
    expect(ctrl.view).toBe('modes');
    expect(ctrl.selectedIndex).toBe(0);

    ctrl.handleKey('down');
    expect(ctrl.selectedIndex).toBe(1);
    ctrl.handleKey('\x1b[B');
    expect(ctrl.selectedIndex).toBe(2);
    ctrl.handleKey('j');
    expect(ctrl.selectedIndex).toBe(3);

    ctrl.handleKey('up');
    expect(ctrl.selectedIndex).toBe(2);
    ctrl.handleKey('\x1b[A');
    expect(ctrl.selectedIndex).toBe(1);
    ctrl.handleKey('k');
    expect(ctrl.selectedIndex).toBe(0);

    // Transition to local view (index 4 in modes)
    ctrl.selectedIndex = 4;
    const navAction = ctrl.handleKey('enter');
    expect(navAction).toEqual({ type: 'navigate', view: 'local' });
    expect(ctrl.view).toBe('local');
    expect(ctrl.selectedIndex).toBe(0);

    // In local view (row 0 + 2 local models = 3 rows)
    ctrl.handleKey('down');
    expect(ctrl.selectedIndex).toBe(1);
    ctrl.handleKey('down');
    expect(ctrl.selectedIndex).toBe(2);
    ctrl.handleKey('down'); // wraps around to 0
    expect(ctrl.selectedIndex).toBe(0);

    ctrl.handleKey('up'); // wraps to last
    expect(ctrl.selectedIndex).toBe(2);
  });

  it('2. Left/Right reasoning effort cycling (low <-> medium <-> high)', () => {
    const ctrl = new ModelSelectorController();
    expect(ctrl.reasoningEffort).toBe('medium');

    ctrl.handleKey('right');
    expect(ctrl.reasoningEffort).toBe('high');
    ctrl.handleKey('\x1b[C');
    expect(ctrl.reasoningEffort).toBe('low');
    ctrl.handleKey('right');
    expect(ctrl.reasoningEffort).toBe('medium');

    ctrl.handleKey('left');
    expect(ctrl.reasoningEffort).toBe('low');
    ctrl.handleKey('\x1b[D');
    expect(ctrl.reasoningEffort).toBe('high');
  });

  it('3. Pressing Enter on Local in modes view transitions to view === local (does not close or emit select)', () => {
    const ctrl = new ModelSelectorController({ models: sampleModels });
    ctrl.selectedIndex = 4; // Local
    const action = ctrl.handleKey('enter');

    expect(action).toEqual({ type: 'navigate', view: 'local' });
    expect(ctrl.view).toBe('local');
    expect(ctrl.isOpen).toBe(true);
  });

  it('4. In local view, row 0 is Auto Local Routing, and rows 1..N are local models; Enter/S and a/A shortcuts work', () => {
    const ctrl = new ModelSelectorController({ models: sampleModels });
    ctrl.view = 'local';
    ctrl.selectedIndex = 0;

    const action = ctrl.handleKey('enter');
    expect(action).toEqual({
      type: 'select',
      scope: 'default',
      mode: 'local',
      modelId: undefined,
      reasoningEffort: 'medium'
    });
    expect(ctrl.isOpen).toBe(false);
  });

  it('5. In local view, Enter on a loaded or compatible installed local model emits select with requiresLoad', () => {
    const ctrl = new ModelSelectorController({ models: sampleModels });
    ctrl.view = 'local';
    ctrl.selectedIndex = 1; // llama3:8b (loaded: false)

    const action = ctrl.handleKey('enter');
    expect(action).toEqual({
      type: 'select',
      scope: 'default',
      mode: 'local',
      modelId: 'llama3:8b',
      reasoningEffort: 'medium',
      requiresLoad: true
    });
    expect(ctrl.isOpen).toBe(false);
  });

  it('6. In local view, Enter on an ineligible or offline model emits rejected with warningMessage', () => {
    const ctrl = new ModelSelectorController({ models: sampleModels });
    ctrl.view = 'local';
    ctrl.selectedIndex = 2; // offline-model

    const action = ctrl.handleKey('enter');
    expect(action.type).toBe('rejected');
    if (action.type === 'rejected') {
      expect(action.modelId).toBe('offline-model');
    }
    expect(ctrl.warningMessage).toBeDefined();
    expect(ctrl.isOpen).toBe(true);
  });

  it('7. Esc in local view returns to modes view at index 4 (Local); Esc in modes emits cancel and closes', () => {
    const ctrl = new ModelSelectorController({ models: sampleModels });
    ctrl.view = 'local';
    ctrl.selectedIndex = 2;

    const navAction = ctrl.handleKey('escape');
    expect(navAction).toEqual({ type: 'navigate', view: 'modes' });
    expect(ctrl.view).toBe('modes');
    expect(ctrl.selectedIndex).toBe(4);

    const cancelAction = ctrl.handleKey('escape');
    expect(cancelAction).toEqual({ type: 'cancel' });
    expect(ctrl.isOpen).toBe(false);
  });
});
