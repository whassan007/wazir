import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { ConversationRenderer } from '../src/tui/conversationRenderer.js';
import { EventSummarizer } from '../src/tui/eventSummarizer.js';
import { StatusProjection } from '../src/tui/statusProjection.js';
import { TerminalScreen } from '../src/tui/screen.js';
import { stringDisplayWidth } from '../src/tui/unicode.js';
import { ClipboardController } from '../src/tui/clipboardController.js';

describe('conversation presentation projections', () => {
  it('keeps terminal task states absorbing across delayed and duplicated events', () => {
    const events = [
      { type: 'task:completed', taskId: 'a' },
      { type: 'task:progress', taskId: 'a', phase: 'plan' },
      { type: 'task:started', taskId: 'a' },
      { type: 'task:failed', taskId: 'a' },
      { type: 'task:cancelled', taskId: 'a' },
      { type: 'task:completed', taskId: 'a' },
    ];
    const projection = new StatusProjection();
    for (const event of events) projection.apply(event);
    expect(projection.getTask('a')?.status).toBe('COMPLETED');
    expect(projection.getTask('a')?.activity).toBe('Completed');
  });

  it.each([
    ['task:failed', 'FAILED'],
    ['task:cancelled', 'CANCELLED'],
    ['task:completed', 'COMPLETED'],
  ] as const)('uses first authoritative terminal outcome as the race winner (%s)', (terminalEvent, expected) => {
    const delayed = [
      { type: 'task:started', taskId: 'race' },
      { type: 'task:progress', taskId: 'race', phase: 'plan' },
      { type: 'task:progress', taskId: 'race', event: { kind: 'token', content: 'late' } },
    ];
    const permutations = [delayed, [...delayed].reverse(), [delayed[1], delayed[0], delayed[2]], [delayed[2], delayed[1], delayed[0]]];
    for (const events of permutations) {
      const projection = new StatusProjection();
      projection.apply({ type: terminalEvent, taskId: 'race' });
      projection.apply({ type: terminalEvent, taskId: 'race' });
      for (const event of events) projection.apply(event);
      expect(projection.getTask('race')?.status).toBe(expected);
    }
  });

  it('isolates concurrent task state and permits explicit retry after failure', () => {
    const projection = new StatusProjection();
    projection.seed(['one', 'two']);
    projection.apply({ type: 'task:started', taskId: 'one' });
    projection.apply({ type: 'task:failed', taskId: 'one' });
    projection.apply({ type: 'task:progress', taskId: 'two', phase: 'plan' });
    expect(projection.getTask('one')?.status).toBe('FAILED');
    expect(projection.getTask('two')?.status).toBe('PLANNING');
    projection.apply({ type: 'task:retry', taskId: 'one' });
    expect(projection.getTask('one')?.status).toBe('RUNNING');
  });

  it('does not turn failed checks into a verification success summary', () => {
    const summary = new EventSummarizer();
    summary.progress({ tool: 'test', error: 'assertion failed\nstack trace' });
    expect(summary.completion()).toContain('0/1 checks passed · 1 failed');
    expect(summary.logLines()).toContain('test failed: assertion failed');
  });

  it('leaves transcript output stable and emits no mouse or alternate-screen modes', () => {
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    const renderer = new ConversationRenderer(output, () => ({ columns: 80, rows: 24 }));
    renderer.start('waelbot', 'LM Studio');
    renderer.append('> hello\n\nAssistant response');
    const durable = raw;
    renderer.render({ identity: 'waelbot', model: 'LM Studio', prompt: 'edit this', cursor: 4, active: 1, waitingApproval: 0, activity: 'Compiling...', elapsedSeconds: 5 });
    const firstFrame = raw.slice(durable.length);
    renderer.render({ identity: 'waelbot', model: 'LM Studio', prompt: 'edit this', cursor: 4, active: 1, waitingApproval: 0, activity: 'Running tests...', elapsedSeconds: 6 });
    const secondFrame = raw.slice(durable.length + firstFrame.length);
    expect(raw.slice(0, durable.length)).toBe(durable);
    expect(firstFrame).not.toContain('Assistant response');
    expect(secondFrame).not.toContain('Assistant response');
    expect(raw).not.toMatch(/\x1b\[\?(?:1049|1047|1000|1002|1003|1006)[hl]/);
  });

  it('preserves durable transcript in a terminal emulator while the live region changes', async () => {
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    let columns = 60;
    const renderer = new ConversationRenderer(output, () => ({ columns, rows: 12 }));
    renderer.start('waelbot', 'LM Studio');
    renderer.append('> original prompt\n\nAssistant response that stays in scrollback.');
    renderer.render({ identity: 'waelbot', model: 'LM Studio', prompt: 'long prompt '.repeat(30), cursor: 360, active: 1, waitingApproval: 0, activity: 'Compiling...' });
    const terminal = new Terminal({ cols: 60, rows: 12, scrollback: 100, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(raw, resolve));
    const initialBytes = raw.length;
    columns = 40;
    terminal.resize(40, 12);
    renderer.render({ identity: 'waelbot', model: 'LM Studio', prompt: 'long prompt '.repeat(30), cursor: 360, active: 1, waitingApproval: 0, activity: 'Running tests...' });
    await new Promise<void>((resolve) => terminal.write(raw.slice(initialBytes), resolve));
    let lastBytes = raw.length;
    for (const width of [80, 120, 200, 40, 60]) {
      columns = width;
      terminal.resize(width, 12);
      const activity = `Activity at ${width} columns`;
      renderer.render({ identity: 'waelbot', model: 'LM Studio', prompt: 'long prompt '.repeat(30), cursor: 360, active: 1, waitingApproval: 0, activity });
      await new Promise<void>((resolve) => terminal.write(raw.slice(lastBytes), resolve));
      lastBytes = raw.length;
    }
    const contents: string[] = [];
    for (let i = 0; i < terminal.buffer.active.length; i++) contents.push(terminal.buffer.active.getLine(i)?.translateToString(true) ?? '');
    expect(contents.join('\n').replace(/\s+/g, ' ')).toContain('Assistant response that stays in scrollback.');
    const visible = contents.slice(terminal.buffer.active.baseY, terminal.buffer.active.baseY + terminal.rows).join('\n');
    expect(visible).toContain('Activity at 60 columns');
    expect(visible).not.toContain('Activity at 40 columns');
    expect(visible).not.toContain('Compiling...');
    for (const line of contents.slice(terminal.buffer.active.baseY, terminal.buffer.active.baseY + terminal.rows)) {
      expect(stringDisplayWidth(line)).toBeLessThanOrEqual(60);
    }
    terminal.dispose();
  });

  it('prints redirected output without cursor controls or spinner frames', () => {
    const output = new PassThrough();
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    const renderer = new ConversationRenderer(output, () => ({ columns: 80, rows: 24 }), { isTTY: false });
    renderer.start('waelbot', 'LM Studio');
    renderer.render({ identity: 'waelbot', model: 'LM Studio', prompt: 'task', cursor: 4, active: 1, waitingApproval: 0, activity: 'Working...' });
    expect(raw).not.toContain('\x1b');
    expect(raw).toContain('Working...');
  });

  it('enters and leaves conversation mode without alternate-screen or mouse tracking', () => {
    const input = new PassThrough() as PassThrough & { setRawMode?: (mode: boolean) => void };
    input.setRawMode = () => undefined;
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
    output.isTTY = true; output.columns = 80; output.rows = 24;
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    const screen = new TerminalScreen(input, output, 'conversation');
    screen.enter();
    screen.leave();
    expect(raw).not.toMatch(/\x1b\[\?(?:1049|1047|1000|1002|1003|1006)[hl]/);
    expect(raw).toContain('\x1b[?2004h');
    expect(raw).toContain('\x1b[?2004l');
    expect(raw).toContain('\x1b[?25h');
  });

  it('requires explicit OSC52 opt-in and blocks secrets and oversized copies', () => {
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    const enabled = new ClipboardController(output, { TERM: 'xterm-256color', WAZIR_OSC52: '1' });
    expect(enabled.copy('ordinary transcript').copied).toBe(true);
    expect(raw).toContain('\x1b]52;c;');
    expect(enabled.copy('API_KEY=super-secret-value')).toMatchObject({ copied: false });
    expect(enabled.copy('x'.repeat(100_001))).toMatchObject({ copied: false });
    const disabled = new ClipboardController(output, { TERM: 'xterm-256color' });
    expect(disabled.copy('ordinary transcript')).toMatchObject({ copied: false });
  });

  it('displays operational status in interactive TTY live frames without erasing durable transcript', () => {
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    const renderer = new ConversationRenderer(output, () => ({ columns: 100, rows: 24 }));
    renderer.start('controller', 'auto-routed model');
    renderer.append('> !pwd\n/workspace\n✓ Command completed · exit 0 · 5ms · ref @1');
    const durablePrefix = raw;

    const statuses = [
      'Command running: [SHELL] Running: ls -la...',
      'Command completed (4ms) · [SHELL #1] exit 0: total 8 (ref @1)',
      'Model unavailable (0 models registered). Shell commands (!cmd) available.',
      'Provider disconnected · Model unavailable (0 models registered).',
      'Scheduler rejected task · Scheduling failed: no capacity',
      'Waiting for approval: shell (1 pending)',
      'Execution failed: task exited with error',
      'Tool execution failed: shell failed — non-zero exit',
    ];

    for (const status of statuses) {
      const beforeLen = raw.length;
      renderer.render({
        identity: 'controller',
        model: 'auto-routed model',
        prompt: '',
        cursor: 0,
        active: 0,
        waitingApproval: 0,
        activity: '',
        status,
      });
      const frameDelta = raw.slice(beforeLen);
      expect(frameDelta).toContain(status.slice(0, 40));
    }

    expect(raw.slice(0, durablePrefix.length)).toBe(durablePrefix);
  });

  it('renders rich welcome screen matching Section 4 and clears cleanly on /clear', () => {
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    const renderer = new ConversationRenderer(output, () => ({ columns: 80, rows: 24 }));

    renderer.start({
      identity: 'waelbot',
      model: undefined,
      modelsCount: 3,
      computerName: 'DGX Spark',
    });

    expect(raw).toContain('WAZIR');
    expect(raw).toContain('Multi-Model AI Coding Assistant');
    expect(raw).toContain('● 3 models ready');
    expect(raw).toContain('● DGX Spark connected');
    expect(raw).toContain('What would you like to do?');
    expect(raw).toContain('> Explain this repository');
    expect(raw).toContain('> Find and fix failing tests');
    expect(raw).toContain('Type a request and press Enter.');
    expect(raw).toContain('/help    /models    /status    Ctrl+C cancel');

    // Test clear
    renderer.append('User query in progress');
    expect(renderer.transcript.list().map((e) => e.text)).toContain('User query in progress');

    renderer.clear({
      identity: 'waelbot',
      model: 'qwen3-coder',
      modelsCount: 3,
      computerName: 'DGX Spark',
    });

    // Transcript should be wiped and welcome screen re-rendered
    expect(renderer.transcript.list()).toHaveLength(0);
    expect(raw).toContain('\x1b[2J\x1b[H');
    expect(raw).toContain('Model: qwen3-coder');
  });

  it('streams tokens incrementally without disrupting the live prompt region', () => {
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let raw = '';
    output.on('data', (chunk) => { raw += chunk.toString(); });
    const renderer = new ConversationRenderer(output, () => ({ columns: 80, rows: 24 }));

    renderer.start('controller', 'auto');
    renderer.render({
      identity: 'controller',
      prompt: 'hello world',
      cursor: 11,
      active: 1,
      waitingApproval: 0,
      activity: 'thinking',
    });

    // Stream tokens
    renderer.streamToken('Hello');
    renderer.streamToken(' there!');
    expect(raw).toContain('Hello');
    expect(raw).toContain(' there!');

    // Flush tokens
    renderer.flushStreaming();
    expect(renderer.transcript.list().map((e) => e.text)).toContain('Hello there!');
  });
});
