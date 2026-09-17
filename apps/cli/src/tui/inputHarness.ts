import { TerminalScreen, type TerminalSize } from './screen.js';
import { FleetTui, type FleetTuiOptions } from './fleetTui.js';
import { EventEmitter } from 'node:events';

export class MockTerminalStream extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 40;
  private buffer = '';

  write(chunk: string): boolean {
    this.buffer += chunk;
    return true;
  }

  getOutput(): string {
    return this.buffer;
  }

  clearOutput(): void {
    this.buffer = '';
  }

  setRawMode(_mode: boolean): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

export class TuiTestHarness {
  readonly inStream: MockTerminalStream;
  readonly outStream: MockTerminalStream;
  readonly screen: TerminalScreen;
  readonly tui: FleetTui;

  constructor(options: Omit<FleetTuiOptions, 'screen'>) {
    this.inStream = new MockTerminalStream();
    this.outStream = new MockTerminalStream();
    this.screen = new TerminalScreen(
      this.inStream as unknown as NodeJS.ReadableStream,
      this.outStream as unknown as NodeJS.WritableStream,
    );
    this.tui = new FleetTui({
      ...options,
      screen: this.screen,
    });
  }

  async start(): Promise<void> {
    await this.tui.start();
  }

  stop(): void {
    this.tui.stop();
  }

  sendKey(key: string): void {
    this.tui.handleKey(key);
  }

  sendKeys(text: string): void {
    for (const char of text) {
      this.tui.handleKey(char);
    }
  }

  sendLine(text: string): void {
    this.sendKeys(text);
    this.sendKey('\r');
  }

  getScreenBuffer(): string {
    return this.screen.getLastBuffer();
  }

  getLines(): string[] {
    return this.screen.getLastBuffer().split('\n');
  }
}
