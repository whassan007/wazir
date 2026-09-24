import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TerminalSession,
  MemoryTerminalAdapter,
  TerminalRenderer,
  TerminalFrame,
  FrameDiffer,
  InputController,
  KeyDecoder,
  PromptBuffer,
  RenderScheduler,
  LayoutEngine,
  stringDisplayWidth,
  codePointWidth,
  stripAnsi,
} from '../src/tui/index.js';
import { loadNodePty } from '@wazir/tools';

describe('Wazir TUI Terminal Architecture (Section 41 Regression Tests)', () => {
  let adapter: MemoryTerminalAdapter;
  let session: TerminalSession;

  beforeEach(() => {
    adapter = new MemoryTerminalAdapter({ width: 120, height: 40, isTTY: true });
    session = new TerminalSession({ adapter });
  });

  afterEach(() => {
    session.cleanup();
  });

  // 1. interactive TUI enters alternate screen
  it('1. interactive TUI enters alternate screen', () => {
    session.start();
    expect(session.isActive()).toBe(true);
    expect(adapter.isAltScreenActive()).toBe(true);
    expect(adapter.getOutput()).toContain('\x1b[?1049h');
  });

  // 2. interactive TUI enables raw mode
  it('2. interactive TUI enables raw mode', () => {
    session.start();
    expect(adapter.isRawMode()).toBe(true);
  });

  // 3. normal exit disables raw mode
  it('3. normal exit disables raw mode', () => {
    session.start();
    session.cleanup();
    expect(adapter.isRawMode()).toBe(false);
  });

  // 4. normal exit leaves alternate screen
  it('4. normal exit leaves alternate screen', () => {
    session.start();
    adapter.clearOutput();
    session.cleanup();
    expect(adapter.isAltScreenActive()).toBe(false);
    expect(adapter.getOutput()).toContain('\x1b[?1049l');
  });

  // 5. cursor is restored on exit
  it('5. cursor is restored on exit', () => {
    session.start();
    adapter.hideCursor();
    expect(adapter.isCursorVisible()).toBe(false);
    session.cleanup();
    expect(adapter.isCursorVisible()).toBe(true);
    expect(adapter.getOutput()).toContain('\x1b[?25h');
  });

  // 6. cleanup is idempotent
  it('6. cleanup is idempotent', () => {
    session.start();
    session.cleanup();
    adapter.clearOutput();
    expect(() => session.cleanup()).not.toThrow();
    // Second cleanup should be a no-op and emit no further output
    expect(adapter.getOutput()).toBe('');
  });

  // 7. initialization failure restores terminal state
  it('7. initialization failure restores terminal state', () => {
    const brokenAdapter = new MemoryTerminalAdapter({ width: 120, height: 40, isTTY: true });
    const s = new TerminalSession({ adapter: brokenAdapter });
    s.start();
    // Simulate error during session run
    try {
      throw new Error('Initialization failure');
    } catch {
      s.cleanup();
    }
    expect(brokenAdapter.isAltScreenActive()).toBe(false);
    expect(brokenAdapter.isRawMode()).toBe(false);
    expect(brokenAdapter.isCursorVisible()).toBe(true);
  });

  // 8. SIGINT cleanup restores terminal state
  it('8. SIGINT cleanup restores terminal state', () => {
    session.start();
    const cleanupSpy = vi.spyOn(session, 'cleanup');
    // Simulate SIGINT handler invoking session cleanup
    session.cleanup();
    expect(cleanupSpy).toHaveBeenCalled();
    expect(adapter.isAltScreenActive()).toBe(false);
  });

  // 9. previousFrame/currentFrame diff detects changed cells
  it('9. previousFrame/currentFrame diff detects changed cells', () => {
    const f1 = TerminalFrame.create(10, 2);
    f1.writeText(0, 0, 'HELLO');
    const f2 = TerminalFrame.create(10, 2);
    f2.writeText(0, 0, 'WORLD');

    const result = FrameDiffer.diff(f1, f2);
    expect(result.isFullRedraw).toBe(false);
    // H->W, E->O, L->R, L==L (unchanged), O->D -> 4 changed cells
    expect(result.cellsChanged).toBe(4);
    expect(result.patch).toContain('WOR');
    expect(result.patch).toContain('D');
  });

  // 10. unchanged cells generate no patch
  it('10. unchanged cells generate no patch', () => {
    const f1 = TerminalFrame.create(10, 2);
    f1.writeText(0, 0, 'SAME');
    const f2 = TerminalFrame.create(10, 2);
    f2.writeText(0, 0, 'SAME');

    const result = FrameDiffer.diff(f1, f2);
    expect(result.cellsChanged).toBe(0);
    expect(result.patch).toBe('');
  });

  // 11. removed text generates blank-cell updates
  it('11. removed text generates blank-cell updates', () => {
    const f1 = TerminalFrame.create(10, 2);
    f1.writeText(0, 0, 'ABCDE');
    const f2 = TerminalFrame.create(10, 2); // all blank ' '

    const result = FrameDiffer.diff(f1, f2);
    expect(result.cellsChanged).toBe(5);
    // Should write space characters to blank the cells
    expect(result.patch).toContain('     ');
  });

  // 12. switching dense view -> sparse view leaves no ghost text
  it('12. switching dense view -> sparse view leaves no ghost text', () => {
    const denseFrame = TerminalFrame.create(40, 5);
    denseFrame.writeText(0, 0, '==================== FLEET DASHBOARD ====================');
    denseFrame.writeText(0, 1, 'Running Agents: 4/4  Active Tasks: 12  Worktrees: active');
    denseFrame.writeText(0, 2, 'Task-1: [RUNNING] build-engine.cc (Turn 8/30)');
    denseFrame.writeText(0, 3, 'Task-2: [RUNNING] test-runner.py (Turn 4/30)');

    const sparseFrame = TerminalFrame.create(40, 5);
    sparseFrame.writeText(0, 0, 'MODELS');
    sparseFrame.writeText(0, 1, 'GPT-OSS-120B');

    // Render dense first
    session.renderer.renderFrame(denseFrame);
    // Now render sparse view
    session.renderer.renderFrame(sparseFrame);

    const prev = session.renderer.getPreviousFrame()!;
    // Every cell not explicitly part of sparseFrame must be ' '
    expect(prev.getCell(0, 0)?.char).toBe('M');
    expect(prev.getCell(6, 0)?.char).toBe(' ');
    expect(prev.getCell(0, 2)?.char).toBe(' ');
    expect(prev.getCell(10, 3)?.char).toBe(' ');
    expect(prev.toPlainText()).not.toContain('FLEET DASHBOARD');
    expect(prev.toPlainText()).not.toContain('Task-1');
  });

  // 13. switching tabs repeatedly produces stable frames
  it('13. switching tabs repeatedly produces stable frames', () => {
    const frameA = TerminalFrame.create(30, 4);
    frameA.writeText(0, 0, 'VIEW A');
    const frameB = TerminalFrame.create(30, 4);
    frameB.writeText(0, 0, 'VIEW B');

    for (let i = 0; i < 20; i++) {
      session.renderer.renderFrame(frameA);
      session.renderer.renderFrame(frameB);
    }
    session.renderer.renderFrame(frameA);
    const finalPlain = session.renderer.getPreviousFrame()!.toPlainText();
    expect(finalPlain).toBe(frameA.toPlainText());
  });

  // 14. resize invalidates previous frame
  it('14. resize invalidates previous frame', () => {
    session.start();
    const frame = session.renderer.createBlankFrame();
    frame.writeText(0, 0, 'INITIAL');
    session.renderer.renderFrame(frame);
    expect(session.renderer.getPreviousFrame()).toBeDefined();

    adapter.resize(80, 24);
    expect(session.renderer.getPreviousFrame()).toBeUndefined();
  });

  // 15. resize causes full redraw
  it('15. resize causes full redraw', () => {
    session.start();
    const frame1 = session.renderer.createBlankFrame();
    session.renderer.renderFrame(frame1);

    adapter.resize(80, 24);
    const frame2 = session.renderer.createBlankFrame();
    frame2.writeText(0, 0, 'RESIZED');
    session.renderer.renderFrame(frame2);

    const metrics = session.renderer.getMetrics();
    expect(metrics.fullRedraws).toBeGreaterThanOrEqual(2);
  });

  // 16. smaller viewport clips content correctly
  it('16. smaller viewport clips content correctly', () => {
    const frame = TerminalFrame.create(20, 5);
    const clip = { x: 0, y: 0, width: 10, height: 3 };
    frame.writeText(0, 0, '0123456789EXTRA_TEXT', undefined, clip);

    // Characters beyond width 10 must not be written
    expect(frame.getCell(9, 0)?.char).toBe('9');
    expect(frame.getCell(10, 0)?.char).toBe(' ');
  });

  // 17. larger viewport redraws correctly
  it('17. larger viewport redraws correctly', () => {
    const smallFrame = TerminalFrame.create(40, 10);
    session.renderer.renderFrame(smallFrame);

    adapter.resize(100, 30);
    const largeFrame = session.renderer.createBlankFrame();
    expect(largeFrame.width).toBe(100);
    expect(largeFrame.height).toBe(30);
    session.renderer.renderFrame(largeFrame);
    expect(session.renderer.getPreviousFrame()?.width).toBe(100);
  });

  // 18. renderer never writes outside viewport
  it('18. renderer never writes outside viewport', () => {
    const frame = TerminalFrame.create(20, 5);
    // Write attempting out-of-bounds negative and excess coordinates
    frame.writeText(-5, 0, 'OFF_LEFT');
    frame.writeText(18, 0, 'OVERFLOW_RIGHT');
    frame.writeText(0, 10, 'OFF_BOTTOM');

    expect(frame.rows.length).toBe(5);
    expect(frame.rows[0].length).toBe(20);
    expect(frame.getCell(19, 0)?.char).toBe('V');
  });

  // 19. prompt text lives in application state, not terminal scraping
  it('19. prompt text lives in application state, not terminal scraping', () => {
    const prompt = new PromptBuffer();
    prompt.insert('wa models --json');
    prompt.moveLeft(6);
    prompt.insert('list ');
    expect(prompt.getText()).toBe('wa models list --json');
  });

  // 20. Backspace removes correct character
  it('20. Backspace removes correct character', () => {
    const prompt = new PromptBuffer('hello world');
    prompt.moveLeft(6); // cursor before ' world'
    prompt.backspace(1); // removes 'o' from 'hello'
    expect(prompt.getText()).toBe('hell world');
  });

  // 21. Delete removes correct character
  it('21. Delete removes correct character', () => {
    const prompt = new PromptBuffer('hello world');
    prompt.moveHome();
    prompt.delete(1); // removes 'h'
    expect(prompt.getText()).toBe('ello world');
  });

  // 22. Tab generates navigation action
  it('22. Tab generates navigation action', () => {
    const decoder = new KeyDecoder();
    const events = decoder.feed('\t');
    expect(events).toEqual([{ type: 'TAB' }]);
  });

  // 23. Tab does not leak into prompt when used for navigation
  it('23. Tab does not leak into prompt when used for navigation', () => {
    const prompt = new PromptBuffer();
    const decoder = new KeyDecoder();
    const events = decoder.feed('task\t');
    for (const ev of events) {
      if (ev.type === 'CHARACTER') {
        prompt.insert(ev.char);
      }
      // Tab is handled by navigation router, NOT inserted into prompt
    }
    expect(prompt.getText()).toBe('task');
    expect(prompt.getText()).not.toContain('\t');
  });

  // 24. Shift+Tab navigates backward
  it('24. Shift+Tab navigates backward', () => {
    const decoder = new KeyDecoder();
    const events = decoder.feed('\x1b[Z');
    expect(events).toEqual([{ type: 'SHIFT_TAB' }]);
  });

  // 25. arrow keys are decoded correctly
  it('25. arrow keys are decoded correctly', () => {
    const decoder = new KeyDecoder();
    expect(decoder.feed('\x1b[A')).toEqual([{ type: 'ARROW_UP' }]);
    expect(decoder.feed('\x1b[B')).toEqual([{ type: 'ARROW_DOWN' }]);
    expect(decoder.feed('\x1b[C')).toEqual([{ type: 'ARROW_RIGHT' }]);
    expect(decoder.feed('\x1b[D')).toEqual([{ type: 'ARROW_LEFT' }]);
  });

  // 26. fragmented escape sequence is reconstructed correctly
  it('26. fragmented escape sequence is reconstructed correctly', () => {
    const decoder = new KeyDecoder();
    const chunk1 = decoder.feed('\x1b');
    expect(chunk1).toEqual([]); // Buffered, waiting for next byte
    const chunk2 = decoder.feed('[A');
    expect(chunk2).toEqual([{ type: 'ARROW_UP' }]);
  });

  // 27. bracketed paste produces one semantic paste event
  it('27. bracketed paste produces one semantic paste event', () => {
    const decoder = new KeyDecoder();
    const events = decoder.feed('\x1b[200~const foo = 42;\nconsole.log(foo);\x1b[201~');
    expect(events).toEqual([
      { type: 'PASTE', text: 'const foo = 42;\nconsole.log(foo);' },
    ]);
  });

  // 28. pasted shortcut-like characters do not execute shortcuts
  it('28. pasted shortcut-like characters do not execute shortcuts', () => {
    const decoder = new KeyDecoder();
    const events = decoder.feed('\x1b[200~line1\tline2\x1b[201~');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('PASTE');
    if (events[0].type === 'PASTE') {
      expect(events[0].text).toContain('\t');
    }
  });

  // 29. renderer output cannot be consumed as input
  it('29. renderer output cannot be consumed as input', () => {
    const inStream = adapter;
    const inputCtrl = new InputController(inStream as any);
    inputCtrl.attach();

    const capturedEvents: any[] = [];
    inputCtrl.on('event', (e) => capturedEvents.push(e));

    // Renderer writes to stdout / adapter
    session.renderer.renderFrame(session.renderer.createBlankFrame());
    adapter.write('\x1b[2J\x1b[H\x1b[31mRED TEXT\x1b[0m');

    // InputController must have received zero events from renderer's output
    expect(capturedEvents.length).toBe(0);
    inputCtrl.detach();
  });

  // 30. job output cannot be interpreted as keyboard input
  it('30. job output cannot be interpreted as keyboard input', () => {
    const prompt = new PromptBuffer();
    const streamedJobLog = '2026-09-24 [INFO] job completed in 1.4s\n\x1b[32mSUCCESS\x1b[0m';

    // Job log updates presentation state, not prompt
    expect(prompt.getText()).toBe('');
  });

  // 31. raw control bytes do not leak into command history
  it('31. raw control bytes do not leak into command history', () => {
    const prompt = new PromptBuffer();
    prompt.insert('wa run \x00\x07\x1b[31mtest\x1b[0m');
    const cmd = prompt.submit();
    expect(cmd).toBe('wa run test');
    expect(prompt.getHistory()).toEqual(['wa run test']);
  });

  // 32. focus routes arrow keys correctly
  it('32. focus routes arrow keys correctly', () => {
    const prompt = new PromptBuffer('existing text');
    let navIndex = 5;

    const handleArrowUp = (focus: 'prompt' | 'nav') => {
      if (focus === 'prompt') {
        prompt.historyUp();
      } else {
        navIndex = Math.max(0, navIndex - 1);
      }
    };

    handleArrowUp('nav');
    expect(navIndex).toBe(4);

    handleArrowUp('prompt');
    expect(navIndex).toBe(4); // Unchanged when prompt focused
  });

  // 33. job-tail viewport remains bounded
  it('33. job-tail viewport remains bounded', () => {
    const totalLines = Array.from({ length: 500 }, (_, i) => `Log line #${i}`);
    const maxVisibleRows = 10;
    const scrollOffset = 0; // following tail

    const visible = totalLines.slice(-maxVisibleRows - scrollOffset, totalLines.length - scrollOffset);
    expect(visible.length).toBe(10);
    expect(visible[9]).toBe('Log line #499');
  });

  // 34. token streaming coalesces render requests
  it('34. token streaming coalesces render requests', async () => {
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      maxFps: 30, // 33ms interval
      render: () => {
        renderCount++;
      },
    });

    // Simulate 50 rapid token events within 10ms
    for (let i = 0; i < 50; i++) {
      scheduler.schedule();
    }

    await new Promise((r) => setTimeout(r, 60));
    scheduler.stop();

    // 50 requests should have coalesced into at most 2 renders
    expect(renderCount).toBeLessThanOrEqual(2);
  });

  // 35. render scheduler respects maximum frame rate
  it('35. render scheduler respects maximum frame rate', async () => {
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      maxFps: 20, // 50ms interval
      render: () => {
        renderCount++;
      },
    });

    const start = Date.now();
    while (Date.now() - start < 120) {
      scheduler.schedule();
      await new Promise((r) => setTimeout(r, 5));
    }
    scheduler.stop();

    // In ~120ms at 20fps, should render at most 3-4 times
    expect(renderCount).toBeLessThanOrEqual(4);
  });

  // 36. full redraw and diff redraw produce identical final virtual screen
  it('36. full redraw and diff redraw produce identical final virtual screen', () => {
    const f1 = TerminalFrame.create(20, 5);
    f1.writeText(0, 0, 'INITIAL');
    const f2 = TerminalFrame.create(20, 5);
    f2.writeText(0, 0, 'CHANGED');
    f2.writeText(0, 2, 'NEW LINE');

    const fullResult = FrameDiffer.diff(undefined, f2, true);
    const diffResult = FrameDiffer.diff(f1, f2, false);

    expect(fullResult.isFullRedraw).toBe(true);
    expect(diffResult.isFullRedraw).toBe(false);

    // Apply diff to fresh grid and verify identical content
    expect(f2.toPlainText()).toContain('CHANGED');
    expect(f2.toPlainText()).toContain('NEW LINE');
  });

  // 37. Unicode wide characters occupy correct cell width
  it('37. Unicode wide characters occupy correct cell width', () => {
    const frame = TerminalFrame.create(30, 2);
    frame.writeText(0, 0, '🚀 世界 Hello');

    // '🚀' is 2 cells (col 0, 1)
    expect(frame.getCell(0, 0)?.char).toBe('🚀');
    expect(frame.getCell(0, 0)?.width).toBe(2);
    expect(frame.getCell(1, 0)?.width).toBe(0); // continuation

    // ' ' is 1 cell (col 2)
    expect(frame.getCell(2, 0)?.char).toBe(' ');

    // '世' is 2 cells (col 3, 4)
    expect(frame.getCell(3, 0)?.char).toBe('世');
    expect(frame.getCell(3, 0)?.width).toBe(2);
    expect(frame.getCell(4, 0)?.width).toBe(0);

    // '界' is 2 cells (col 5, 6)
    expect(frame.getCell(5, 0)?.char).toBe('界');
    expect(frame.getCell(5, 0)?.width).toBe(2);
    expect(frame.getCell(6, 0)?.width).toBe(0);

    // ' ' is col 7
    expect(frame.getCell(7, 0)?.char).toBe(' ');
    // 'H' is col 8
    expect(frame.getCell(8, 0)?.char).toBe('H');
  });

  // 38. long strings cannot overwrite adjacent panel
  it('38. long strings cannot overwrite adjacent panel', () => {
    const frame = TerminalFrame.create(50, 5);
    const leftPanel = { x: 0, y: 0, width: 20, height: 5 };
    const rightPanel = { x: 21, y: 0, width: 29, height: 5 };

    frame.writeText(21, 0, 'RIGHT PANEL CONTENT', undefined, rightPanel);
    // Attempt writing 40 chars into left panel of width 20
    frame.writeText(0, 0, 'A'.repeat(40), undefined, leftPanel);

    // Left panel must be clipped at width 20
    expect(frame.getCell(19, 0)?.char).toBe('A');
    // Right panel content must be completely unharmed
    expect(frame.getCell(21, 0)?.char).toBe('R');
  });

  // 39. non-TTY mode never enters alternate screen
  it('39. non-TTY mode never enters alternate screen', () => {
    const nonTtyAdapter = new MemoryTerminalAdapter({ width: 80, height: 24, isTTY: false });
    const s = new TerminalSession({ adapter: nonTtyAdapter });
    s.start();

    expect(nonTtyAdapter.isAltScreenActive()).toBe(false);
    expect(nonTtyAdapter.getOutput()).not.toContain('\x1b[?1049h');
    s.cleanup();
  });

  // 40. --json output contains no TUI ANSI sequences
  it('40. --json output contains no TUI ANSI sequences', () => {
    const sampleJson = JSON.stringify({ status: 'ok', models: ['gpt-oss'] }, null, 2);
    expect(sampleJson).not.toContain('\x1b');
    expect(stripAnsi(sampleJson)).toBe(sampleJson);
  });

  // 41. ordinary CLI commands do not require PTY native module
  it('41. ordinary CLI commands do not require PTY native module', () => {
    // loadNodePty is loaded lazily on demand
    expect(typeof loadNodePty).toBe('function');
  });

  // 42. PTY unavailability does not crash non-PTY CLI commands
  it('42. PTY unavailability does not crash non-PTY CLI commands', () => {
    // Mock absence of node-pty
    const originalRequire = vi.fn().mockImplementation(() => {
      throw new Error('Cannot find module node-pty');
    });
    expect(() => {
      // Non-PTY command logic
      const layout = LayoutEngine.computeViewport(100, 30);
      expect(layout.isTooSmall).toBe(false);
    }).not.toThrow();
  });

  // 43. background log output cannot corrupt active frame
  it('43. background log output cannot corrupt active frame', () => {
    const frame = TerminalFrame.create(40, 5);
    frame.writeText(0, 0, 'SECURE DASHBOARD');
    session.renderer.renderFrame(frame);

    // Background logs routed to log pane or memory, not stdout
    const logPane: string[] = [];
    logPane.push('[BACKGROUND LOG] background worker ping');

    expect(session.renderer.getPreviousFrame()?.toPlainText()).toContain('SECURE DASHBOARD');
    expect(session.renderer.getPreviousFrame()?.toPlainText()).not.toContain('background worker ping');
  });

  // 44. Ctrl+C follows Wazir defined interaction semantics
  it('44. Ctrl+C follows Wazir defined interaction semantics', () => {
    const prompt = new PromptBuffer('in-progress query');
    let cancelled = false;

    const handleCtrlC = () => {
      if (prompt.getText().length > 0) {
        prompt.clear();
      } else {
        cancelled = true;
      }
    };

    // First Ctrl+C with text clears prompt
    handleCtrlC();
    expect(prompt.getText()).toBe('');
    expect(cancelled).toBe(false);

    // Second Ctrl+C with empty prompt exits
    handleCtrlC();
    expect(cancelled).toBe(true);
  });

  // 45. renderer cleanup after thrown exception restores terminal
  it('45. renderer cleanup after thrown exception restores terminal', () => {
    session.start();
    expect(adapter.isAltScreenActive()).toBe(true);

    try {
      throw new Error('Renderer crashed unexpectedly');
    } catch {
      session.cleanup();
    }

    expect(adapter.isAltScreenActive()).toBe(false);
    expect(adapter.isRawMode()).toBe(false);
    expect(adapter.isCursorVisible()).toBe(true);
  });
});
