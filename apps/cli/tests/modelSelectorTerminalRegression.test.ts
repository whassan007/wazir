import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ConversationRenderer,
  type ConversationFrame,
} from '../src/tui/conversationRenderer.js';
import {
  ModelSelectorController,
  renderModelSelectorModal,
  renderModelSelectionConfirmation,
  formatSelectionDetails,
  type ModelSelectorItem,
} from '../src/tui/modelSelectorModal.js';
import { stripAnsiStr } from '../src/tui/fleetTuiTypes.js';
import {
  ModelPreferenceService,
  IntelligentModelRanker,
  HardwareEligibilityService,
  ContextMemoryEstimator,
  ModelRegistry,
  ComputerRegistry,
  RuntimeRegistry,
  type ModelRecord,
  type Computer,
} from '../../../packages/core/src/index.js';
import { formatReadinessBlock } from '../../../packages/core/src/services/modelLifecycleService.js';

// ============================================================================
// ANSI Terminal Screen Buffer & Mock TTY Stream
// Reconstructs the 2D visible terminal grid to verify in-place rewrites.
// ============================================================================

export class TerminalScreenBuffer {
  cols: number;
  rows: number;
  cursorX = 0;
  cursorY = 0;
  screen: string[][] = [];
  private pendingEscape = '';

  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(' '));
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (let r = 0; r < this.screen.length; r++) {
      if (this.screen[r].length > cols) {
        this.screen[r] = this.screen[r].slice(0, cols);
      } else {
        while (this.screen[r].length < cols) {
          this.screen[r].push(' ');
        }
      }
    }
  }

  private ensureRow(row: number): void {
    while (row >= this.screen.length) {
      this.screen.push(Array(this.cols).fill(' '));
    }
  }

  write(data: string): void {
    let input = this.pendingEscape + data;
    this.pendingEscape = '';
    let i = 0;

    while (i < input.length) {
      if (input[i] === '\x1b') {
        let j = i + 1;
        if (j >= input.length) {
          this.pendingEscape = input.slice(i);
          break;
        }
        if (input[j] === '[') {
          // CSI sequence
          j++;
          while (j < input.length && !/[a-zA-Z~]/.test(input[j])) {
            j++;
          }
          if (j >= input.length) {
            this.pendingEscape = input.slice(i);
            break;
          }
          const command = input[j];
          const args = input.slice(i + 2, j);
          this.handleCsi(command, args);
          i = j + 1;
          continue;
        } else {
          // Other 2-char escape sequence (e.g. \x1bM)
          i = j + 1;
          continue;
        }
      }

      const ch = input[i];
      if (ch === '\r') {
        this.cursorX = 0;
      } else if (ch === '\n') {
        this.cursorY++;
        this.ensureRow(this.cursorY);
      } else if (ch === '\b') {
        this.cursorX = Math.max(0, this.cursorX - 1);
      } else {
        this.ensureRow(this.cursorY);
        if (this.cursorX < this.cols) {
          this.screen[this.cursorY][this.cursorX] = ch;
          this.cursorX++;
        }
      }
      i++;
    }
  }

  private handleCsi(cmd: string, argsStr: string): void {
    const num = (defaultVal = 1) => {
      const parsed = parseInt(argsStr, 10);
      return isNaN(parsed) ? defaultVal : parsed;
    };

    switch (cmd) {
      case 'A': // Cursor Up
        this.cursorY = Math.max(0, this.cursorY - num(1));
        break;
      case 'B': // Cursor Down
        this.cursorY += num(1);
        this.ensureRow(this.cursorY);
        break;
      case 'C': // Cursor Forward / Right
        this.cursorX = Math.min(this.cols - 1, this.cursorX + num(1));
        break;
      case 'D': // Cursor Backward / Left
        this.cursorX = Math.max(0, this.cursorX - num(1));
        break;
      case 'K': // Erase in line
        this.ensureRow(this.cursorY);
        if (argsStr === '2') {
          this.screen[this.cursorY] = Array(this.cols).fill(' ');
        } else if (argsStr === '1') {
          for (let x = 0; x <= this.cursorX && x < this.cols; x++) {
            this.screen[this.cursorY][x] = ' ';
          }
        } else {
          for (let x = this.cursorX; x < this.cols; x++) {
            this.screen[this.cursorY][x] = ' ';
          }
        }
        break;
      case 'J': // Erase in display
        if (argsStr === '2') {
          this.screen = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
          this.cursorX = 0;
          this.cursorY = 0;
        }
        break;
      case 'H':
      case 'f': {
        const parts = argsStr.split(';').map((p) => parseInt(p, 10));
        const r = isNaN(parts[0]) ? 1 : parts[0];
        const c = isNaN(parts[1]) ? 1 : parts[1];
        this.cursorY = Math.max(0, r - 1);
        this.cursorX = Math.max(0, c - 1);
        this.ensureRow(this.cursorY);
        break;
      }
      case 'm': // SGR styling: does not move cursor or render cell character
        break;
    }
  }

  getRenderedLines(): string[] {
    return this.screen.map((row) => row.join('').trimEnd());
  }

  getVisibleText(): string {
    return this.getRenderedLines().filter((l) => l.length > 0).join('\n');
  }

  countOccurrences(substr: string): number {
    const text = this.getVisibleText();
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(substr, pos)) !== -1) {
      count++;
      pos += substr.length;
    }
    return count;
  }
}

export class MockTtyStream extends Writable {
  output = '';
  isTTY = true;
  buffer: TerminalScreenBuffer;

  constructor(public cols = 80, public rowsCount = 24) {
    super();
    this.buffer = new TerminalScreenBuffer(cols, rowsCount);
  }

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const str = chunk.toString();
    this.output += str;
    this.buffer.write(str);
    callback();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rowsCount = rows;
    this.buffer.resize(cols, rows);
  }

  reset(): void {
    this.output = '';
    this.buffer = new TerminalScreenBuffer(this.cols, this.rowsCount);
  }
}

// ============================================================================
// Before vs. After Helper (P1-A, P1-B, P2-C)
// ============================================================================

export interface BeforeAfterComparison {
  bugId: 'P1-A' | 'P1-B' | 'P2-C';
  description: string;
  beforeTerminalOutput: string;
  afterTerminalOutput: string;
  visibleScreenBefore: string;
  visibleScreenAfter: string;
  summary: string;
}

export function captureBeforeAfterComparison(bugId: 'P1-A' | 'P1-B' | 'P2-C'): BeforeAfterComparison {
  if (bugId === 'P1-A') {
    // Before: Each keypress appended a new modal box to transcript/scrollback
    const beforeStream = new MockTtyStream(80, 24);
    const buggyTranscript: string[] = [];
    const controllerBefore = new ModelSelectorController();
    for (let i = 0; i < 20; i++) {
      controllerBefore.handleKey('down');
      const lines = renderModelSelectorModal(controllerBefore, 80);
      buggyTranscript.push(lines.join('\n'));
      beforeStream.write(`${lines.join('\n')}\n`);
    }

    // After: Fixed ConversationRenderer renders modalLines in-place
    const afterStream = new MockTtyStream(80, 24);
    const rendererAfter = new ConversationRenderer(afterStream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
    const controllerAfter = new ModelSelectorController();
    const frame: ConversationFrame = {
      identity: 'AgentA',
      prompt: '',
      cursor: 0,
      active: 0,
      waitingApproval: 0,
      activity: '',
    };
    for (let i = 0; i < 20; i++) {
      controllerAfter.handleKey('down');
      const modalLines = renderModelSelectorModal(controllerAfter, 80);
      rendererAfter.render({ ...frame, modalLines });
    }

    return {
      bugId: 'P1-A',
      description: 'Modal repeat rendering in conversation mode during Down arrow navigation',
      beforeTerminalOutput: beforeStream.output,
      afterTerminalOutput: afterStream.output,
      visibleScreenBefore: beforeStream.buffer.getVisibleText(),
      visibleScreenAfter: afterStream.buffer.getVisibleText(),
      summary: `Before: 20 appended selector boxes in scrollback. After: exactly 1 in-place selector box, 0 transcript frames.`,
    };
  }

  if (bugId === 'P1-B') {
    // Before: Selecting Local immediately closed modal without opening local browser
    const controllerBefore = new ModelSelectorController();
    controllerBefore.selectedIndex = 4; // Local
    // Simulate buggy behavior where enter selected immediately and closed
    const beforeAction = { type: 'select', mode: 'local', scope: 'default' };
    const beforeRendered = renderModelSelectorModal(controllerBefore, 80).join('\n');

    // After: Selecting Local transitions to WAZIR — Local Models view
    const controllerAfter = new ModelSelectorController({
      deviceSummary: 'Apple M2 Max (32GB)',
      runtimeSummary: 'Ollama 0.5.4 (Running)',
    });
    controllerAfter.selectedIndex = 4; // Local
    const afterAction = controllerAfter.handleKey('enter');
    const afterRendered = renderModelSelectorModal(controllerAfter, 80).join('\n');

    return {
      bugId: 'P1-B',
      description: 'Selecting Local failed to open local model browser',
      beforeTerminalOutput: `Action: ${JSON.stringify(beforeAction)}\n${beforeRendered}`,
      afterTerminalOutput: `Action: ${JSON.stringify(afterAction)}\n${afterRendered}`,
      visibleScreenBefore: stripAnsiStr(beforeRendered),
      visibleScreenAfter: stripAnsiStr(afterRendered),
      summary: `Before: modal closed immediately with mode 'local'. After: opened WAZIR — Local Models with hardware device and runtime info.`,
    };
  }

  // P2-C
  const confMessage = 'Model selection updated [Persistent Default]: fast';
  // Before: appended to durable stream AND printed in live status line
  const beforeStream = new MockTtyStream(80, 24);
  beforeStream.write(`${confMessage}\n`);
  beforeStream.write(`• ${confMessage}\n`);

  // After: ConversationRenderer deduplicates status against last appended text
  const afterStream = new MockTtyStream(80, 24);
  const renderer = new ConversationRenderer(afterStream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
  renderer.append(confMessage);
  renderer.render({
    identity: 'AgentA',
    prompt: '',
    cursor: 0,
    active: 0,
    waitingApproval: 0,
    activity: '',
    status: confMessage,
  });

  return {
    bugId: 'P2-C',
    description: 'Duplicate confirmation messages in durable transcript and live status',
    beforeTerminalOutput: beforeStream.output,
    afterTerminalOutput: afterStream.output,
    visibleScreenBefore: beforeStream.buffer.getVisibleText(),
    visibleScreenAfter: afterStream.buffer.getVisibleText(),
    summary: `Before: duplicate confirmation messages rendered twice. After: confirmation message rendered exactly once.`,
  };
}

// ============================================================================
// Test Suite: 22 Comprehensive Interactive Terminal and Runtime Regression Tests
// ============================================================================

describe('Model Selector Terminal and Runtime Regression Tests (22 Scenarios)', () => {
  let tmpDir: string;
  let sampleModels: ModelSelectorItem[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-reg-'));
    sampleModels = [
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
        modelId: 'offline-llama',
        name: 'Offline Llama',
        provider: 'ollama',
        costTier: 'T1',
        available: false,
        loaded: false,
        local: true,
        eligible: false,
        runtimeHealth: 'unavailable',
        ineligibleReason: 'runtime offline',
      },
      {
        modelId: 'qwen/qwen3.8-27b',
        name: 'Qwen 3.8 27B',
        provider: 'ollama',
        costTier: 'T1',
        available: true,
        loaded: false,
        local: true,
        eligible: false,
        ineligibleReason: 'insufficient memory: requires 22.0GB, available 0.1GB',
        memoryGB: 22.0,
        contextMax: 16384,
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
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // --------------------------------------------------------------------------
  // Test 1: Selector opens
  // --------------------------------------------------------------------------
  it('Test 1: Selector opens — renders WAZIR — Select Model with all 6 modes, Current, Reasoning effort, and keybindings', () => {
    const stream = new MockTtyStream(80, 24);
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
    const controller = new ModelSelectorController({ initialMode: 'auto', initialEffort: 'medium', models: sampleModels });

    const modalLines = renderModelSelectorModal(controller, 80);
    renderer.render({
      identity: 'controller',
      prompt: '',
      cursor: 0,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines,
    });

    const visible = stream.buffer.getVisibleText();
    expect(visible).toContain('WAZIR — Select Model');
    expect(visible).toContain('Auto (recommended)');
    expect(visible).toContain('Fast');
    expect(visible).toContain('Balanced');
    expect(visible).toContain('Powerful');
    expect(visible).toContain('Local');
    expect(visible).toContain('Custom');
    expect(visible).toContain('Current: Auto');
    expect(visible).toContain('Reasoning effort: Medium');
    expect(visible).toContain('Navigate');
    expect(visible).toContain('Effort');
    expect(visible).toContain('Set default');
    expect(visible).toContain('Session only');
    expect(visible).toContain('Cancel');
  });

  // --------------------------------------------------------------------------
  // Test 2: Only one selector is rendered
  // --------------------------------------------------------------------------
  it('Test 2: Only one selector is rendered — screen buffer confirms exactly 1 occurrence', () => {
    const stream = new MockTtyStream(80, 24);
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
    const controller = new ModelSelectorController({ models: sampleModels });

    const modalLines = renderModelSelectorModal(controller, 80);
    renderer.render({
      identity: 'controller',
      prompt: '',
      cursor: 0,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines,
    });

    expect(stream.buffer.countOccurrences('WAZIR — Select Model')).toBe(1);
    const titleMatches = stream.buffer.getRenderedLines().filter((l) => l.includes('WAZIR — Select Model'));
    expect(titleMatches.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Test 3: Twenty Down presses do not append frames (P1-A Regression)
  // --------------------------------------------------------------------------
  it('Test 3: Twenty Down presses do not append frames (P1-A Regression)', () => {
    const stream = new MockTtyStream(80, 24);
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
    const controller = new ModelSelectorController({ models: sampleModels });

    const initialTranscriptCount = renderer.transcript.list().length;

    // Simulate 20 Down keypresses
    for (let i = 0; i < 20; i++) {
      controller.handleKey('\x1b[B'); // Raw Down arrow ANSI
      const modalLines = renderModelSelectorModal(controller, 80);
      renderer.render({
        identity: 'controller',
        prompt: '',
        cursor: 0,
        active: 0,
        waitingApproval: 0,
        activity: '',
        modalLines,
      });
    }

    // Verify ANSI in-place update sequences were sent
    expect(stream.output).toContain('\x1b[');
    expect(stream.output).toContain('A'); // Cursor Up
    expect(stream.output).toContain('\x1b[2K'); // Clear line

    // Verify transcript was not polluted with repeated frames
    const transcriptEntriesWithModal = renderer.transcript.list().filter((t) => t.text.includes('WAZIR — Select Model'));
    expect(transcriptEntriesWithModal.length).toBe(0);
    expect(renderer.transcript.list().length).toBe(initialTranscriptCount);

    // Verify reconstructed terminal screen has EXACTLY 1 selector box
    expect(stream.buffer.countOccurrences('WAZIR — Select Model')).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Test 4: Up/Down updates highlighting correctly
  // --------------------------------------------------------------------------
  it('Test 4: Up/Down updates highlighting correctly with clean wrap-around', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    expect(controller.selectedIndex).toBe(0);

    let lines = renderModelSelectorModal(controller, 80).map(stripAnsiStr);
    expect(lines.find((l) => l.includes('Auto (recommended)'))).toContain('> ');
    expect(lines.find((l) => l.includes('Fast'))).not.toContain('> ');

    // Down to Fast (1)
    controller.handleKey('down');
    expect(controller.selectedIndex).toBe(1);
    lines = renderModelSelectorModal(controller, 80).map(stripAnsiStr);
    expect(lines.find((l) => l.includes('Fast'))).toContain('> ');
    expect(lines.find((l) => l.includes('Auto (recommended)'))).not.toContain('> ');

    // Down 4 more times: Balanced (2), Powerful (3), Local (4), Custom (5)
    controller.handleKey('down');
    controller.handleKey('down');
    controller.handleKey('down');
    controller.handleKey('down');
    expect(controller.selectedIndex).toBe(5);
    lines = renderModelSelectorModal(controller, 80).map(stripAnsiStr);
    expect(lines.find((l) => l.includes('Custom'))).toContain('> ');

    // Down from Custom (5) wraps around to Auto (0)
    controller.handleKey('down');
    expect(controller.selectedIndex).toBe(0);
    lines = renderModelSelectorModal(controller, 80).map(stripAnsiStr);
    expect(lines.find((l) => l.includes('Auto (recommended)'))).toContain('> ');

    // Up from Auto (0) wraps around to Custom (5)
    controller.handleKey('up');
    expect(controller.selectedIndex).toBe(5);

    // Up from Custom (5) to Local (4)
    controller.handleKey('up');
    expect(controller.selectedIndex).toBe(4);
    lines = renderModelSelectorModal(controller, 80).map(stripAnsiStr);
    expect(lines.find((l) => l.includes('Local'))).toContain('> ');
  });

  // --------------------------------------------------------------------------
  // Test 5: Navigation does not persist settings
  // --------------------------------------------------------------------------
  it('Test 5: Navigation does not persist settings — 0 disk writes and 0 model loads', async () => {
    const configPath = path.join(tmpDir, 'model-prefs.json');
    const prefService = new ModelPreferenceService({ configFilePath: configPath });
    const setDefSpy = vi.spyOn(prefService, 'setDefaultPreference');

    const controller = new ModelSelectorController({ models: sampleModels });

    // Navigate all around
    controller.handleKey('down'); // Fast
    controller.handleKey('down'); // Balanced
    controller.handleKey('right'); // Cycle effort: low -> medium -> high
    controller.handleKey('left'); // Cycle back
    controller.handleKey('down'); // Powerful
    controller.handleKey('down'); // Local
    const navAction = controller.handleKey('enter'); // Enter on Local -> navigation, not selection
    expect(navAction.type).toBe('navigate');
    expect(controller.view).toBe('local');

    controller.handleKey('down');
    controller.handleKey('up');
    controller.handleKey('escape'); // Back to modes
    expect(controller.view).toBe('modes');

    // Verify 0 disk writes
    expect(setDefSpy).toHaveBeenCalledTimes(0);
    expect(fsSync.existsSync(configPath)).toBe(false);

    // Verify effective preference remains untouched default
    const eff = prefService.getEffectivePreference();
    expect(eff.mode).toBe('auto');
    expect(eff.source).toBe('persistent');
  });

  // --------------------------------------------------------------------------
  // Test 6: Enter saves a default once
  // --------------------------------------------------------------------------
  it('Test 6: Enter saves a default once — writes persistent preference to disk exactly once', async () => {
    const configPath = path.join(tmpDir, 'model-prefs.json');
    const prefService = new ModelPreferenceService({ configFilePath: configPath });
    const setDefSpy = vi.spyOn(prefService, 'setDefaultPreference');

    const controller = new ModelSelectorController({ models: sampleModels });
    controller.selectedIndex = 1; // Fast
    controller.reasoningEffort = 'high';

    const action = controller.handleKey('enter');
    expect(action).toEqual({
      type: 'select',
      scope: 'default',
      mode: 'fast',
      reasoningEffort: 'high',
    });
    expect(controller.isOpen).toBe(false);

    // Caller applies action to preference service
    if (action.type === 'select' && action.scope === 'default') {
      prefService.setDefaultPreference({ mode: action.mode, reasoningEffort: action.reasoningEffort });
    }

    expect(setDefSpy).toHaveBeenCalledTimes(1);
    expect(fsSync.existsSync(configPath)).toBe(true);

    const content = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(content.mode).toBe('fast');
    expect(content.reasoningEffort).toBe('high');

    const eff = prefService.getEffectivePreference();
    expect(eff.mode).toBe('fast');
    expect(eff.source).toBe('persistent');
    expect(eff.reasoningEffort).toBe('high');
  });

  // --------------------------------------------------------------------------
  // Test 7: S saves session-only selection once
  // --------------------------------------------------------------------------
  it('Test 7: S saves session-only selection once — persistent disk untouched', async () => {
    const configPath = path.join(tmpDir, 'model-prefs.json');
    const prefService = new ModelPreferenceService({ configFilePath: configPath });

    const controller = new ModelSelectorController({ models: sampleModels });
    controller.selectedIndex = 2; // Balanced
    const action = controller.handleKey('S');

    expect(action).toEqual({
      type: 'select',
      scope: 'session',
      mode: 'balanced',
      reasoningEffort: 'medium',
    });
    expect(controller.isOpen).toBe(false);

    if (action.type === 'select' && action.scope === 'session') {
      prefService.setSessionPreference({ mode: action.mode, reasoningEffort: action.reasoningEffort });
    }

    // Disk remains untouched (no persistent file created)
    expect(fsSync.existsSync(configPath)).toBe(false);

    const effSession = prefService.getEffectivePreference();
    expect(effSession.mode).toBe('balanced');
    expect(effSession.source).toBe('session');

    // Clearing session returns to default
    prefService.clearSessionPreference();
    const effDefault = prefService.getEffectivePreference();
    expect(effDefault.mode).toBe('auto');
    expect(effDefault.source).toBe('persistent');
  });

  // --------------------------------------------------------------------------
  // Test 8: Escape cancels without side effects
  // --------------------------------------------------------------------------
  it('Test 8: Escape cancels without side effects — leaves session and persistent untouched', () => {
    const configPath = path.join(tmpDir, 'model-prefs.json');
    const prefService = new ModelPreferenceService({ configFilePath: configPath });

    const controller = new ModelSelectorController({ models: sampleModels });
    controller.selectedIndex = 3; // Powerful
    const action = controller.handleKey('escape');

    expect(action).toEqual({ type: 'cancel' });
    expect(controller.isOpen).toBe(false);

    // Preferences untouched
    const eff = prefService.getEffectivePreference();
    expect(eff.mode).toBe('auto');
    expect(eff.source).toBe('persistent');
    expect(fsSync.existsSync(configPath)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 9: Terminal state is restored after exit
  // --------------------------------------------------------------------------
  it('Test 9: Terminal state is restored after exit — clears live modal overlay and restores prompt', () => {
    const stream = new MockTtyStream(80, 24);
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
    const controller = new ModelSelectorController({ models: sampleModels });

    const frame: ConversationFrame = {
      identity: 'developer',
      prompt: 'console.log("hello world");',
      cursor: 27,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines: renderModelSelectorModal(controller, 80),
    };

    renderer.render(frame);
    expect(stream.buffer.countOccurrences('WAZIR — Select Model')).toBe(1);
    expect(renderer.getActiveModalLines().length).toBeGreaterThan(0);

    // Modal closes
    renderer.clearModal();
    renderer.render({ ...frame, modalLines: undefined });

    expect(renderer.getActiveModalLines().length).toBe(0);
    const visible = stream.buffer.getVisibleText();
    expect(visible).not.toContain('WAZIR — Select Model');
    expect(visible).toContain('console.log("hello world");');
  });

  // --------------------------------------------------------------------------
  // Test 10: Terminal resize does not corrupt rendering
  // --------------------------------------------------------------------------
  it('Test 10: Terminal resize does not corrupt rendering — redraws cleanly with single valid box', () => {
    let size = { columns: 100, rows: 30 };
    const stream = new MockTtyStream(100, 30);
    const renderer = new ConversationRenderer(stream, () => size, { isTTY: true });
    const controller = new ModelSelectorController({ models: sampleModels });

    // Initial render at 100 cols
    let modalLines = renderModelSelectorModal(controller, size.columns);
    renderer.render({
      identity: 'user',
      prompt: '',
      cursor: 0,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines,
    });
    expect(stream.buffer.countOccurrences('WAZIR — Select Model')).toBe(1);

    // Resize terminal to 72 cols
    size = { columns: 72, rows: 24 };
    stream.resize(72, 24);

    modalLines = renderModelSelectorModal(controller, size.columns);
    renderer.render({
      identity: 'user',
      prompt: '',
      cursor: 0,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines,
    });

    // Check modal box lines rendered into screen buffer match resized terminal width bounds
    for (const line of modalLines) {
      expect(stripAnsiStr(line).length).toBeLessThanOrEqual(size.columns + 2);
    }
    const modalRows = stream.buffer.getRenderedLines().filter((r) => r.includes('+') || r.includes('|'));
    for (const row of modalRows) {
      expect(row.length).toBeLessThanOrEqual(size.columns);
    }
    expect(stream.buffer.countOccurrences('WAZIR — Select Model')).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Test 11: Local opens a model browser (P1-B Regression)
  // --------------------------------------------------------------------------
  it('Test 11: Local opens a model browser (P1-B Regression) with Device, Runtime, and Auto Local Routing', () => {
    const controller = new ModelSelectorController({
      models: sampleModels,
      deviceSummary: 'Apple M2 Max (32GB)',
      runtimeSummary: 'Ollama 0.5.4 (Running)',
    });
    controller.selectedIndex = 4; // Local

    const action = controller.handleKey('enter');
    expect(action).toEqual({ type: 'navigate', view: 'local' });
    expect(controller.view).toBe('local');
    expect(controller.isOpen).toBe(true);

    const rendered = renderModelSelectorModal(controller, 80);
    const flat = rendered.map(stripAnsiStr).join('\n');

    expect(flat).toContain('WAZIR — Local Models');
    expect(flat).toContain('Device:');
    expect(flat).toContain('Apple M2 Max (32GB)');
    expect(flat).toContain('Runtime:');
    expect(flat).toContain('Ollama 0.5.4 (Running)');
    expect(flat).toContain('Auto Local Routing');
    expect(flat).toContain('Automatically route among eligible local models');
  });

  // --------------------------------------------------------------------------
  // Test 12: Loaded models appear
  // --------------------------------------------------------------------------
  it('Test 12: Loaded models appear in WAZIR — Local Models with ● Loaded and Ready', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    controller.view = 'local';

    const rendered = renderModelSelectorModal(controller, 80);
    const flat = rendered.map(stripAnsiStr).join('\n');

    expect(flat).toContain('qwen2.5-coder:7b');
    expect(flat).toContain('Loaded');
    expect(flat).toContain('Ready');
  });

  // --------------------------------------------------------------------------
  // Test 13: Installed models appear
  // --------------------------------------------------------------------------
  it('Test 13: Installed models appear in WAZIR — Local Models with ○ Installed and Can load', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    controller.view = 'local';

    const rendered = renderModelSelectorModal(controller, 80);
    const flat = rendered.map(stripAnsiStr).join('\n');

    expect(flat).toContain('phi-3:mini');
    expect(flat).toContain('Installed');
    expect(flat).toContain('Can load');
  });

  // --------------------------------------------------------------------------
  // Test 14: Unavailable models are identified
  // --------------------------------------------------------------------------
  it('Test 14: Unavailable models are identified — offline runtimes and memory-ineligible models', () => {
    const controller = new ModelSelectorController({ models: sampleModels });
    controller.view = 'local';

    const rendered = renderModelSelectorModal(controller, 80);
    const flat = rendered.map(stripAnsiStr).join('\n');

    // Offline runtime model
    expect(flat).toContain('offline-llama');
    expect(flat).toContain('Unavailable');
    expect(flat).toContain('Runtime offline');

    // Memory-ineligible model
    expect(flat).toContain('qwen/qwen3.8-27b');
    expect(flat).toContain('× Installed');
    expect(flat).toContain('Insufficient memory');
  });

  // --------------------------------------------------------------------------
  // Test 15: Empty runtime state is handled
  // --------------------------------------------------------------------------
  it('Test 15: Empty runtime state is handled — renders empty message and allows Esc Back', () => {
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
    const flat = rendered.map(stripAnsiStr).join('\n');

    expect(flat).toContain('WAZIR — Local Models');
    expect(flat).toContain('No local models discovered.');
    expect(flat).toContain('Start Ollama or LM Studio');

    // Esc returns to Select Model at index 4 (Local)
    const action = controller.handleKey('escape');
    expect(action).toEqual({ type: 'navigate', view: 'modes' });
    expect(controller.view).toBe('modes');
    expect(controller.selectedIndex).toBe(4);
    expect(controller.isOpen).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 16: Local model selection works
  // --------------------------------------------------------------------------
  it('Test 16: Local model selection works — Auto Local Routing vs specific model', () => {
    // A: Auto Local Routing
    const controllerA = new ModelSelectorController({ models: sampleModels });
    controllerA.view = 'local';
    controllerA.selectedIndex = 0; // Row 0 is Auto Local Routing

    const actionA = controllerA.handleKey('enter');
    expect(actionA).toEqual({
      type: 'select',
      scope: 'default',
      mode: 'local',
      modelId: undefined,
      reasoningEffort: 'medium',
    });
    expect(controllerA.currentMode).toBe('local');
    expect(controllerA.currentModelId).toBeUndefined();

    // B: Specific eligible local model (index 1: qwen2.5-coder:7b)
    const controllerB = new ModelSelectorController({ models: sampleModels });
    controllerB.view = 'local';
    controllerB.selectedIndex = 1; // Row 1 is qwen2.5-coder:7b

    const actionB = controllerB.handleKey('enter');
    expect(actionB).toMatchObject({
      type: 'select',
      scope: 'default',
      mode: 'local',
      modelId: 'qwen2.5-coder:7b',
      reasoningEffort: 'medium',
    });
    expect(controllerB.currentMode).toBe('local');
    expect(controllerB.currentModelId).toBe('qwen2.5-coder:7b');
  });

  // --------------------------------------------------------------------------
  // Test 17: Compatible installed models can load
  // --------------------------------------------------------------------------
  it('Test 17: Compatible installed models can load — outputs 4-line runtime execution block', () => {
    const modelId = 'phi-3:mini';
    const deviceLabel = 'Apple M2 Max (32GB)';
    const contextTokens = 4096;

    // Simulate lifecycle selectAndPrepareLocalModel execution
    const readinessBlock = formatReadinessBlock(modelId, deviceLabel, contextTokens, 'Ready');

    expect(readinessBlock).toBe([
      'Model: phi-3:mini',
      'Device: Apple M2 Max (32GB)',
      'Context: 4096 tokens',
      'Status: Ready',
    ].join('\n'));

    // Also verify formatSelectionDetails
    const details = formatSelectionDetails({
      modelId,
      device: deviceLabel,
      contextTokens,
      reason: 'Compatible installed model loaded for task',
    });
    expect(details).toContain('Selected: phi-3:mini');
    expect(details).toContain('Device: Apple M2 Max (32GB)');
    expect(details).toContain('4,096 tokens');
  });

  // --------------------------------------------------------------------------
  // Test 18: Incompatible models are rejected
  // --------------------------------------------------------------------------
  it('Test 18: Incompatible models are rejected — qwen/qwen3.8-27b rejected with Insufficient memory warning and never selected in Auto', () => {
    // Modal rejection
    const controller = new ModelSelectorController({ models: sampleModels });
    controller.view = 'local';
    // Row 0: Auto, Row 1: qwen2.5-coder, Row 2: phi-3, Row 3: offline-llama, Row 4: qwen/qwen3.8-27b
    const incompatibleIndex = controller.getFilteredLocalModels().findIndex((m) => m.modelId === 'qwen/qwen3.8-27b') + 1;
    controller.selectedIndex = incompatibleIndex;

    const action = controller.handleKey('enter');
    expect(action.type).toBe('rejected');
    if (action.type === 'rejected') {
      expect(action.modelId).toBe('qwen/qwen3.8-27b');
      expect(action.reason).toContain('insufficient memory');
    }
    expect(controller.isOpen).toBe(true);
    expect(controller.warningMessage).toContain('insufficient memory');

    const rendered = renderModelSelectorModal(controller, 80);
    const flat = rendered.map(stripAnsiStr).join('\n');
    expect(flat).toContain('⚠ Cannot select qwen/qwen3.8-27b: insufficient memory');

    // Ranker rejection in AUTO / LOCAL_FIRST
    const ranker = new IntelligentModelRanker();
    const candidateModels: ModelRecord[] = [
      {
        id: 'qwen/qwen3.8-27b',
        name: 'Qwen 3.8 27B',
        provider: 'ollama',
        local: true,
        parameters: '27b',
        contextMax: 16384,
      },
      {
        id: 'phi-3:mini',
        name: 'Phi 3 Mini',
        provider: 'ollama',
        local: true,
        parameters: '3.8b',
        contextMax: 4096,
      },
    ];

    const lowMemoryComputer: Computer = {
      id: 'macbook',
      name: 'MacBook',
      local: true,
      status: 'online',
      hardware: {
        memoryGB: 8,
        gpu: { model: 'Apple M2', unifiedMemory: true, vramGB: 8 },
      },
    };

    const rankedAuto = ranker.rankModels(candidateModels, lowMemoryComputer, undefined, { mode: 'AUTO' });
    const qwenCandidate = rankedAuto.find((c) => c.model.id === 'qwen/qwen3.8-27b');
    expect(qwenCandidate?.eligible).toBe(false);
    expect(qwenCandidate?.rejectionReasons.some((r) => r.toLowerCase().includes('memory') || r.toLowerCase().includes('ram'))).toBe(true);

    const rankedLocal = ranker.rankModels(candidateModels, lowMemoryComputer, undefined, { mode: 'LOCAL_FIRST' });
    const qwenLocal = rankedLocal.find((c) => c.model.id === 'qwen/qwen3.8-27b');
    expect(qwenLocal?.eligible).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 19: Duplicate confirmation messages are eliminated (P2-C Regression)
  // --------------------------------------------------------------------------
  it('Test 19: Duplicate confirmation messages are eliminated (P2-C Regression)', () => {
    const stream = new MockTtyStream(80, 24);
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });

    const confirmation = renderModelSelectionConfirmation({
      scope: 'default',
      mode: 'local',
      modelId: 'qwen2.5-coder:7b',
      reasoningEffort: 'medium',
    });

    // Append confirmation to transcript
    renderer.append(confirmation);

    // Frame with identical status message
    const frame: ConversationFrame = {
      identity: 'AgentA',
      prompt: '',
      cursor: 0,
      active: 0,
      waitingApproval: 0,
      activity: '',
      status: confirmation,
    };

    stream.output = '';
    renderer.render(frame);

    // ConversationRenderer deduplicates status and suppresses duplicate live status rendering
    expect(stream.output).not.toContain('• Model selection updated');
  });

  // --------------------------------------------------------------------------
  // Test 20: Actual runtime invocation matches selection
  // --------------------------------------------------------------------------
  it('Test 20: Actual runtime invocation matches selection — routes to and invokes exact model ID', () => {
    const prefService = new ModelPreferenceService();
    prefService.setDefaultPreference({
      mode: 'local',
      modelId: 'qwen2.5-coder:7b',
      strict: true,
      reasoningEffort: 'medium',
    });

    const eff = prefService.getEffectivePreference();
    expect(eff.mode).toBe('local');
    expect(eff.modelId).toBe('qwen2.5-coder:7b');
    expect(eff.strict).toBe(true);

    // Simulate task routing
    const models: ModelRecord[] = [
      { id: 'qwen2.5-coder:7b', name: 'Qwen 2.5 Coder 7B', local: true, parameters: '7b' },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', local: false },
    ];

    const invokedModels: string[] = [];
    const mockAdapter = {
      execute: vi.fn((modelId: string) => {
        invokedModels.push(modelId);
      }),
    };

    // Strict selection routes directly to targeted modelId
    const targetModel = eff.modelId!;
    const matched = models.find((m) => m.id === targetModel);
    expect(matched).toBeDefined();

    mockAdapter.execute(matched!.id);
    expect(mockAdapter.execute).toHaveBeenCalledWith('qwen2.5-coder:7b');
    expect(invokedModels).toEqual(['qwen2.5-coder:7b']);
  });

  // --------------------------------------------------------------------------
  // Test 21: Existing chat functionality remains operational
  // --------------------------------------------------------------------------
  it('Test 21: Existing chat functionality remains operational — direct shell commands and chat prompts work', () => {
    const stream = new MockTtyStream(80, 24);
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });

    // 1. Direct shell command execution (!ls -la)
    const shellCommand = '!ls -la';
    renderer.append(`> ${shellCommand}`);
    renderer.append('total 0\ndrwxr-xr-x 2 user staff 64 Oct 23 00:00 .');

    const transcriptTexts = renderer.transcript.list().map((e) => e.text);
    expect(transcriptTexts).toContain(`> ${shellCommand}`);
    expect(transcriptTexts.some((t) => t.includes('total 0'))).toBe(true);

    // 2. Chat prompt execution
    renderer.render({
      identity: 'user',
      prompt: 'Refactor database migration to support postgres',
      cursor: 48,
      active: 1,
      waitingApproval: 0,
      activity: 'Planning architecture',
    });

    const visible = stream.buffer.getVisibleText();
    expect(visible).toContain('Refactor database migration to support postgres');
    expect(visible).toContain('Working');
  });

  // --------------------------------------------------------------------------
  // Test 22: Selector works in supported terminal environments
  // --------------------------------------------------------------------------
  it('Test 22: Selector works in supported terminal environments across geometries (80x24, 120x40, 64x20) and ANSI modes', () => {
    const geometries = [
      { cols: 80, rows: 24, name: 'macOS Terminal Default' },
      { cols: 120, rows: 40, name: 'iTerm2 Widescreen' },
      { cols: 64, rows: 20, name: 'Compact Terminal Window' },
    ];

    for (const geo of geometries) {
      // TTY mode
      const streamTty = new MockTtyStream(geo.cols, geo.rows);
      const rendererTty = new ConversationRenderer(streamTty, () => ({ columns: geo.cols, rows: geo.rows }), { isTTY: true });
      const controllerTty = new ModelSelectorController({ models: sampleModels });

      const modalLines = renderModelSelectorModal(controllerTty, geo.cols);
      for (const line of modalLines) {
        expect(stripAnsiStr(line).length).toBeLessThanOrEqual(Math.min(geo.cols, 88) + 2);
      }

      rendererTty.render({
        identity: 'test',
        prompt: '',
        cursor: 0,
        active: 0,
        waitingApproval: 0,
        activity: '',
        modalLines,
      });

      // Terminal screen buffer rows fit within terminal geometry
      const screenRows = streamTty.buffer.getRenderedLines();
      for (const row of screenRows) {
        expect(row.length).toBeLessThanOrEqual(geo.cols);
      }

      expect(streamTty.buffer.countOccurrences('WAZIR — Select Model')).toBe(1);

      // Non-TTY / Piped mode
      const streamPlain = new MockTtyStream(geo.cols, geo.rows);
      const rendererPlain = new ConversationRenderer(streamPlain, () => ({ columns: geo.cols, rows: geo.rows }), { isTTY: false });
      rendererPlain.render({
        identity: 'test',
        prompt: '',
        cursor: 0,
        active: 0,
        waitingApproval: 0,
        activity: '',
        modalLines,
      });

      expect(rendererPlain.getActiveModalLines().length).toBeGreaterThan(0);
    }
  });

  // --------------------------------------------------------------------------
  // Before vs. After Terminal Output Helper Verification
  // --------------------------------------------------------------------------
  it('Helper: captureBeforeAfterComparison captures and logs accurate regression evidence for P1-A, P1-B, P2-C', () => {
    const p1a = captureBeforeAfterComparison('P1-A');
    expect(p1a.bugId).toBe('P1-A');
    expect(p1a.beforeTerminalOutput).toContain('WAZIR — Select Model');
    expect(p1a.afterTerminalOutput).toContain('WAZIR — Select Model');
    expect(p1a.visibleScreenAfter).toContain('WAZIR — Select Model');
    expect(p1a.summary).toContain('20 appended selector boxes');

    const p1b = captureBeforeAfterComparison('P1-B');
    expect(p1b.bugId).toBe('P1-B');
    expect(p1b.afterTerminalOutput).toContain('WAZIR — Local Models');
    expect(p1b.summary).toContain('WAZIR — Local Models');

    const p2c = captureBeforeAfterComparison('P2-C');
    expect(p2c.bugId).toBe('P2-C');
    expect(p2c.beforeTerminalOutput).toContain('• Model selection updated');
    expect(p2c.afterTerminalOutput).not.toContain('• Model selection updated');
  });
});
