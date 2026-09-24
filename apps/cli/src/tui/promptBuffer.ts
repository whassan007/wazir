/**
 * PromptBuffer: Explicit, deterministic state machine for terminal prompt editing.
 * The prompt's canonical value lives strictly in application memory, never derived
 * by scraping terminal contents.
 * Rejects and filters literal control bytes.
 */

export class PromptBuffer {
  private buffer = '';
  private cursor = 0; // 0..buffer.length
  private history: string[] = [];
  private historyIndex = -1;
  private savedDraft = '';

  constructor(initialText = '') {
    this.setText(initialText);
  }

  getText(): string {
    return this.buffer;
  }

  getCursor(): number {
    return this.cursor;
  }

  /**
   * Sets text and positions cursor at the end.
   */
  setText(text: string): void {
    this.buffer = this.sanitizeText(text);
    this.cursor = this.buffer.length;
  }

  /**
   * Inserts text at the current cursor position.
   * Strips out any ASCII or ANSI control characters.
   */
  insert(text: string): void {
    const clean = this.sanitizeText(text);
    if (!clean) return;

    this.buffer =
      this.buffer.slice(0, this.cursor) + clean + this.buffer.slice(this.cursor);
    this.cursor += clean.length;
  }

  /**
   * Backspace: removes count characters immediately preceding the cursor.
   */
  backspace(count = 1): boolean {
    if (this.cursor <= 0 || count <= 0) return false;
    const actualCount = Math.min(this.cursor, count);
    this.buffer =
      this.buffer.slice(0, this.cursor - actualCount) + this.buffer.slice(this.cursor);
    this.cursor -= actualCount;
    return true;
  }

  /**
   * Delete: removes count characters at the current cursor position.
   */
  delete(count = 1): boolean {
    if (this.cursor >= this.buffer.length || count <= 0) return false;
    const actualCount = Math.min(this.buffer.length - this.cursor, count);
    this.buffer =
      this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + actualCount);
    return true;
  }

  /**
   * Deletes one word backward from the cursor (Ctrl+W).
   */
  deleteWordBackward(): boolean {
    if (this.cursor <= 0) return false;
    const before = this.buffer.slice(0, this.cursor);
    const after = this.buffer.slice(this.cursor);
    const trimmed = before.replace(/\s*\S*\s*$/, '');
    this.buffer = trimmed + after;
    this.cursor = trimmed.length;
    return true;
  }

  /**
   * Moves cursor left by count positions.
   */
  moveLeft(count = 1): void {
    this.cursor = Math.max(0, this.cursor - count);
  }

  /**
   * Moves cursor right by count positions.
   */
  moveRight(count = 1): void {
    this.cursor = Math.min(this.buffer.length, this.cursor + count);
  }

  /**
   * Moves cursor to the start of the line (Home).
   */
  moveHome(): void {
    this.cursor = 0;
  }

  /**
   * Moves cursor to the end of the line (End).
   */
  moveEnd(): void {
    this.cursor = this.buffer.length;
  }

  /**
   * Clears the entire prompt buffer (Ctrl+U).
   */
  clear(): void {
    this.buffer = '';
    this.cursor = 0;
    this.historyIndex = -1;
  }

  /**
   * Submits the current command, appending it to history if non-empty, and clears buffer.
   */
  submit(): string {
    const text = this.buffer.trim();
    if (text.length > 0) {
      // Don't add consecutive duplicates
      if (this.history.length === 0 || this.history[this.history.length - 1] !== text) {
        this.history.push(text);
      }
    }
    this.clear();
    return text;
  }

  /**
   * Recalls earlier command from history (Up arrow).
   */
  historyUp(): boolean {
    if (this.history.length === 0) return false;
    if (this.historyIndex === -1) {
      this.savedDraft = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return false;
    }
    this.buffer = this.history[this.historyIndex];
    this.cursor = this.buffer.length;
    return true;
  }

  /**
   * Recalls later command from history (Down arrow).
   */
  historyDown(): boolean {
    if (this.historyIndex === -1) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.buffer = this.history[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this.buffer = this.savedDraft;
      this.savedDraft = '';
    }
    this.cursor = this.buffer.length;
    return true;
  }

  getHistory(): string[] {
    return [...this.history];
  }

  setHistory(history: string[]): void {
    this.history = [...history];
    this.historyIndex = -1;
  }

  /**
   * Filters out literal control bytes, escape sequences, and unprintable ASCII.
   * Preserves standard printable characters, spaces, and Unicode.
   */
  private sanitizeText(raw: string): string {
    // Strip ANSI escapes
    const withoutAnsi = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z~]|\x1b\([B0]/g, '');
    // Strip control characters (0x00-0x1F, 0x7F-0x9F) except newline if allowed
    return withoutAnsi.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
  }
}
