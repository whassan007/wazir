export interface TranscriptEntry {
  text: string;
  timestamp: number;
}

/** Bounded presentation history; terminal scrollback remains the durable user-visible transcript. */
export class TranscriptStore {
  private readonly entries: TranscriptEntry[] = [];
  constructor(private readonly maxEntries = 2_000) {}

  append(text: string, timestamp = Date.now()): void {
    this.entries.push({ text, timestamp });
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  list(limit = this.maxEntries): TranscriptEntry[] {
    return this.entries.slice(-Math.max(0, limit)).map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries.length = 0;
  }
}
