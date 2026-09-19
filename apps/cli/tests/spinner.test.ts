import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  StatusLoader,
  BrailleSpinner,
  BRAILLE_FRAMES,
  getBrailleFrame,
  createSpinner,
  withSpinner,
} from '../src/tui/spinner.js';

class MockWritableStream extends EventEmitter {
  isTTY = true;
  output = '';
  cleared = 0;

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }

  clearOutput(): void {
    this.output = '';
  }
}

describe('Braille Spinner & Status Loader (§1, §2, §3)', () => {
  it('uses standard Unicode braille pattern animation frames (§1)', () => {
    expect(BRAILLE_FRAMES).toEqual(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
    expect(BRAILLE_FRAMES.length).toBe(10);

    // Frame rotation
    expect(getBrailleFrame(0)).toBe('⠋');
    expect(getBrailleFrame(1)).toBe('⠙');
    expect(getBrailleFrame(9)).toBe('⠏');
    expect(getBrailleFrame(10)).toBe('⠋');
    expect(getBrailleFrame(11)).toBe('⠙');
  });

  it('performs in-place terminal updates without flooding scrollback history (§2)', () => {
    const mock = new MockWritableStream();
    const loader = new StatusLoader({
      stream: mock as unknown as NodeJS.WritableStream,
      interval: 50,
      isTTY: true,
    });

    expect(loader.isSpinning()).toBe(false);

    // Start with "Reading file..."
    loader.start('Reading file config.json...');
    expect(loader.isSpinning()).toBe(true);
    expect(loader.getText()).toBe('Reading file config.json...');

    // Verified cursor hidden (\x1b[?25l) and braille frame rendered
    expect(mock.output).toContain('\x1b[?25l');
    expect(mock.output).toContain('Reading file config.json...');
    expect(mock.output).toContain('⠋');

    // Dynamic in-place text update without newline flooding
    mock.clearOutput();
    loader.setText('Waiting for model response (gemini-pro)...');
    expect(loader.getText()).toBe('Waiting for model response (gemini-pro)...');
    expect(mock.output).toContain('Waiting for model response (gemini-pro)...');
    // Confirm in-place update does not write trailing newline
    expect(mock.output.endsWith('\n')).toBe(false);

    // Advance manually via tick()
    const nextFrame = loader.tick();
    expect(nextFrame).toBe(BRAILLE_FRAMES[1]); // '⠙'

    // Stop and verify cursor restored (\x1b[?25h)
    loader.stop();
    expect(loader.isSpinning()).toBe(false);
    expect(mock.output).toContain('\x1b[?25h');
  });

  it('binds spinner activation to active execution phases and safely stops/clears on completion (§3)', () => {
    const mock = new MockWritableStream();
    const loader = new StatusLoader({
      stream: mock as unknown as NodeJS.WritableStream,
      isTTY: true,
    });

    // Test success completion
    loader.start('Executing bash command...');
    expect(loader.isSpinning()).toBe(true);

    loader.succeed('Command executed successfully');
    expect(loader.isSpinning()).toBe(false);
    expect(mock.output).toContain('✓');
    expect(mock.output).toContain('Command executed successfully');
    expect(mock.output).toContain('\x1b[?25h');

    // Test failure completion
    mock.clearOutput();
    loader.start('Reading file missing.txt...');
    loader.fail('File not found');
    expect(loader.isSpinning()).toBe(false);
    expect(mock.output).toContain('✕');
    expect(mock.output).toContain('File not found');

    // Test warning and info
    mock.clearOutput();
    loader.start('Running memory check...');
    loader.warn('Memory usage high');
    expect(mock.output).toContain('!');
    expect(mock.output).toContain('Memory usage high');

    mock.clearOutput();
    loader.start('Connecting to runtime...');
    loader.info('Runtime online');
    expect(mock.output).toContain('ℹ');
    expect(mock.output).toContain('Runtime online');
  });

  it('supports withSpinner helper for automatic lifecycle binding (§3)', async () => {
    const mock = new MockWritableStream();
    let executed = false;

    const result = await withSpinner(
      'Reading file source.ts...',
      async (sp) => {
        expect(sp.isSpinning()).toBe(true);
        expect(sp.getText()).toBe('Reading file source.ts...');
        sp.setText('Compiling AST...');
        executed = true;
        return 42;
      },
      { stream: mock as unknown as NodeJS.WritableStream, isTTY: true },
    );

    expect(executed).toBe(true);
    expect(result).toBe(42);
    expect(mock.output).toContain('\x1b[?25h'); // Cursor restored
  });

  it('handles errors inside withSpinner safely and marks failure (§3)', async () => {
    const mock = new MockWritableStream();

    await expect(
      withSpinner(
        'Connecting to remote worker...',
        async () => {
          throw new Error('Connection refused');
        },
        { stream: mock as unknown as NodeJS.WritableStream, isTTY: true },
      ),
    ).rejects.toThrow('Connection refused');

    expect(mock.output).toContain('✕');
    expect(mock.output).toContain('Connection refused');
    expect(mock.output).toContain('\x1b[?25h');
  });

  it('provides clean non-TTY stream fallback without flooding or escape sequences', () => {
    const mock = new MockWritableStream();
    mock.isTTY = false;

    const loader = createSpinner('Running in CI / pipe mode', {
      stream: mock as unknown as NodeJS.WritableStream,
      isTTY: false,
    });

    loader.start();
    expect(mock.output).toContain('[-] Running in CI / pipe mode\n');
    expect(mock.output).not.toContain('\x1b[?25l');

    mock.clearOutput();
    loader.succeed('Finished');
    expect(mock.output).toContain('[✓] Finished\n');
  });
});
