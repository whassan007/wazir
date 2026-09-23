import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

/**
 * Before this, a tool subprocess whose stdout/stderr exceeded `maxBuffer`
 * (1MB) was SIGKILLed outright — a noisy-but-passing test run with verbose
 * output turned into a hard failure with no way to see what actually
 * happened. This keeps the process running and streams overflow to disk
 * instead of holding it (or discarding it) in memory, returning a truncated
 * head/tail plus the full file's path so the caller — usually a model —
 * still gets the shape of what happened without either OOMing the harness
 * or losing the evidence.
 */

export interface SpillingBufferOptions {
  /** Directory overflow is written under, e.g. `.wazir/runs/<job-id>/outputs`. Created on first actual spill, not eagerly. */
  runDir: string;
  /** File name within runDir, e.g. `stdout.log`. */
  fileName: string;
  /** Bytes kept in memory before spilling triggers. Default 1MB (matches the old hard maxBuffer). */
  spillThresholdBytes?: number;
  /** Bytes of the head/tail preview kept for the returned summary. Default 4000 each. */
  previewBytes?: number;
}

export interface SpillResult {
  /** Head+tail preview (or the full text, if it never spilled) for handing to a model. */
  preview: string;
  /** Total bytes actually produced by the process, spilled or not. */
  totalBytes: number;
  /** True once spillThresholdBytes was exceeded and output started going to disk. */
  spilled: boolean;
  /** Absolute path to the full output, only set once spilled. */
  filePath?: string;
}

/** A bounded ring buffer of the last `capacity` bytes pushed to it. */
class TailRing {
  private buf: string[] = [];
  private size = 0;
  constructor(private readonly capacity: number) {}
  push(chunk: string): void {
    this.buf.push(chunk);
    this.size += chunk.length;
    while (this.size > this.capacity && this.buf.length > 1) {
      this.size -= this.buf.shift()!.length;
    }
    if (this.size > this.capacity && this.buf.length === 1) {
      const over = this.size - this.capacity;
      this.buf[0] = this.buf[0].slice(over);
      this.size = this.buf[0].length;
    }
  }
  text(): string {
    return this.buf.join('').slice(-this.capacity);
  }
}

export class SpillingBuffer {
  /** Everything seen so far, kept in full ONLY until spilling actually starts (bounded by spillThreshold). */
  private pending = '';
  private head = '';
  private tail: TailRing;
  private totalBytes = 0;
  private spilling = false;
  private stream: WriteStream | undefined;
  private filePath: string | undefined;
  private readonly spillThreshold: number;
  private readonly previewBytes: number;

  constructor(private readonly options: SpillingBufferOptions) {
    this.spillThreshold = options.spillThresholdBytes ?? 1024 * 1024;
    this.previewBytes = options.previewBytes ?? 4000;
    this.tail = new TailRing(this.previewBytes);
  }

  /** Appends a chunk of process output. Never throws — a spill-write failure degrades to memory-only rather than crashing the tool call. */
  push(chunk: string): void {
    this.totalBytes += Buffer.byteLength(chunk, 'utf8');
    this.tail.push(chunk);

    if (this.spilling) {
      try {
        this.stream?.write(chunk);
      } catch {
        // best effort — the tail preview is still accurate
      }
      return;
    }

    this.pending += chunk;
    if (this.head.length < this.previewBytes) {
      this.head = (this.head + chunk).slice(0, this.previewBytes);
    }
    if (this.pending.length > this.spillThreshold) {
      this.startSpilling();
    }
  }

  private startSpilling(): void {
    this.spilling = true;
    try {
      if (!existsSync(this.options.runDir)) mkdirSync(this.options.runDir, { recursive: true });
      this.filePath = path.join(this.options.runDir, this.options.fileName);
      this.stream = createWriteStream(this.filePath, { flags: 'w' });
      // Flush everything buffered so far — nothing between "started
      // accumulating" and "crossed the threshold" is dropped.
      this.stream.write(this.pending);
    } catch {
      this.spilling = false;
      this.stream = undefined;
      this.filePath = undefined;
    } finally {
      this.pending = '';
    }
  }

  /** Closes the spill file (if any) and returns the final summary. Safe to call once output has fully settled. */
  async finish(): Promise<SpillResult> {
    if (this.stream) {
      await new Promise<void>((resolve) => this.stream!.end(resolve));
    }
    if (!this.spilling || !this.filePath) {
      return { preview: this.pending, totalBytes: this.totalBytes, spilled: false };
    }
    const headText = this.head;
    const tailText = this.tail.text();
    const omitted = this.totalBytes - Buffer.byteLength(headText, 'utf8') - Buffer.byteLength(tailText, 'utf8');
    const preview = omitted > 0
      ? `${headText}\n\n... [${omitted} bytes omitted, full output at ${this.filePath}] ...\n\n${tailText}`
      : headText + tailText;
    return { preview, totalBytes: this.totalBytes, spilled: true, filePath: this.filePath };
  }
}
