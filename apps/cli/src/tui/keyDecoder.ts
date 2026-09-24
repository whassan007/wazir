/**
 * KeyDecoder: Decodes raw terminal input bytes and fragmented escape sequences
 * into semantic InputEvents.
 * Buffers partial multi-byte sequences across reads.
 */

export type InputEvent =
  | { type: 'CHARACTER'; char: string }
  | { type: 'ENTER' }
  | { type: 'CTRL_ENTER' }
  | { type: 'BACKSPACE' }
  | { type: 'DELETE' }
  | { type: 'TAB' }
  | { type: 'SHIFT_TAB' }
  | { type: 'ESCAPE' }
  | { type: 'ARROW_UP' }
  | { type: 'ARROW_DOWN' }
  | { type: 'ARROW_LEFT' }
  | { type: 'ARROW_RIGHT' }
  | { type: 'HOME' }
  | { type: 'END' }
  | { type: 'PAGE_UP' }
  | { type: 'PAGE_DOWN' }
  | { type: 'CTRL_C' }
  | { type: 'CTRL_D' }
  | { type: 'CTRL_L' }
  | { type: 'CTRL_P' }
  | { type: 'CTRL_R' }
  | { type: 'CTRL_U' }
  | { type: 'CTRL_W' }
  | { type: 'CTRL_Y' }
  | { type: 'CTRL_G' }
  | { type: 'CTRL_T' }
  | { type: 'CTRL_B' }
  | { type: 'PASTE'; text: string };

export class KeyDecoder {
  private buffer = '';
  private inBracketedPaste = false;
  private pasteBuffer = '';

  /**
   * Feeds raw data (string or Buffer) and returns zero or more parsed semantic events.
   * If a multi-byte escape sequence is incomplete, buffers it until the next chunk.
   */
  feed(chunk: string | Buffer): InputEvent[] {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.buffer += str;
    const events: InputEvent[] = [];

    while (this.buffer.length > 0) {
      // 1. Bracketed paste handling
      if (this.inBracketedPaste) {
        const pasteEndIdx = this.buffer.indexOf('\x1b[201~');
        if (pasteEndIdx !== -1) {
          this.pasteBuffer += this.buffer.slice(0, pasteEndIdx);
          this.buffer = this.buffer.slice(pasteEndIdx + 6);
          this.inBracketedPaste = false;
          events.push({ type: 'PASTE', text: this.pasteBuffer });
          this.pasteBuffer = '';
          continue;
        } else {
          this.pasteBuffer += this.buffer;
          this.buffer = '';
          break;
        }
      }

      if (this.buffer.startsWith('\x1b[200~')) {
        this.inBracketedPaste = true;
        this.pasteBuffer = '';
        this.buffer = this.buffer.slice(6);
        continue;
      }

      // Check for partial bracketed paste start
      if ('\x1b[200~'.startsWith(this.buffer)) {
        break; // Wait for more data
      }

      // 2. Escape sequence handling
      if (this.buffer[0] === '\x1b') {
        if (this.buffer.length === 1) {
          // Solitary escape could be Esc key or start of sequence.
          // In raw mode, we treat solitary \x1b as ESCAPE.
          events.push({ type: 'ESCAPE' });
          this.buffer = '';
          break;
        }

        // Ctrl+Enter variants
        if (this.buffer.startsWith('\x1b\r') || this.buffer.startsWith('\x1b\n')) {
          events.push({ type: 'CTRL_ENTER' });
          this.buffer = this.buffer.slice(2);
          continue;
        }
        if (this.buffer.startsWith('\x1b[13;5~')) {
          events.push({ type: 'CTRL_ENTER' });
          this.buffer = this.buffer.slice(8);
          continue;
        }
        if (this.buffer.startsWith('\x1b[27;5;13~')) {
          events.push({ type: 'CTRL_ENTER' });
          this.buffer = this.buffer.slice(10);
          continue;
        }

        // Shift+Tab: \x1b[Z
        if (this.buffer.startsWith('\x1b[Z')) {
          events.push({ type: 'SHIFT_TAB' });
          this.buffer = this.buffer.slice(3);
          continue;
        }

        // Arrows: \x1b[A, \x1b[B, \x1b[C, \x1b[D or SS3: \x1bOA, etc.
        if (this.buffer.startsWith('\x1b[A') || this.buffer.startsWith('\x1bOA')) {
          events.push({ type: 'ARROW_UP' });
          this.buffer = this.buffer.slice(3);
          continue;
        }
        if (this.buffer.startsWith('\x1b[B') || this.buffer.startsWith('\x1bOB')) {
          events.push({ type: 'ARROW_DOWN' });
          this.buffer = this.buffer.slice(3);
          continue;
        }
        if (this.buffer.startsWith('\x1b[C') || this.buffer.startsWith('\x1bOC')) {
          events.push({ type: 'ARROW_RIGHT' });
          this.buffer = this.buffer.slice(3);
          continue;
        }
        if (this.buffer.startsWith('\x1b[D') || this.buffer.startsWith('\x1bOD')) {
          events.push({ type: 'ARROW_LEFT' });
          this.buffer = this.buffer.slice(3);
          continue;
        }

        // Home / End
        if (this.buffer.startsWith('\x1b[H') || this.buffer.startsWith('\x1bOH') || this.buffer.startsWith('\x1b[1~')) {
          events.push({ type: 'HOME' });
          this.buffer = this.buffer.slice(this.buffer.startsWith('\x1b[1~') ? 4 : 3);
          continue;
        }
        if (this.buffer.startsWith('\x1b[F') || this.buffer.startsWith('\x1bOF') || this.buffer.startsWith('\x1b[4~')) {
          events.push({ type: 'END' });
          this.buffer = this.buffer.slice(this.buffer.startsWith('\x1b[4~') ? 4 : 3);
          continue;
        }

        // PageUp / PageDown
        if (this.buffer.startsWith('\x1b[5~')) {
          events.push({ type: 'PAGE_UP' });
          this.buffer = this.buffer.slice(4);
          continue;
        }
        if (this.buffer.startsWith('\x1b[6~')) {
          events.push({ type: 'PAGE_DOWN' });
          this.buffer = this.buffer.slice(4);
          continue;
        }

        // Delete: \x1b[3~
        if (this.buffer.startsWith('\x1b[3~')) {
          events.push({ type: 'DELETE' });
          this.buffer = this.buffer.slice(4);
          continue;
        }

        // Incomplete CSI / SS3 sequence? (e.g. \x1b[ or \x1bO)
        if (this.buffer === '\x1b[' || this.buffer === '\x1bO') {
          break; // Wait for full sequence
        }
        const csiPrefix = this.buffer.match(/^\x1b\[[0-9;?]*/);
        if (csiPrefix && csiPrefix[0].length === this.buffer.length) {
          break; // Incomplete CSI parameters
        }

        // General matched sequence (consume and ignore unknown escape sequence)
        const generalMatch = this.buffer.match(/^\x1b\[[0-9;?]*[a-zA-Z~]|\x1b[0-9A-Za-z]/);
        if (generalMatch) {
          this.buffer = this.buffer.slice(generalMatch[0].length);
          continue;
        }

        // Unrecognized escape character alone
        events.push({ type: 'ESCAPE' });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // 3. Single byte control characters
      const char = this.buffer[0];

      if (char === '\r' || char === '\n') {
        events.push({ type: 'ENTER' });
        // Consume \r\n as a single enter if present
        if (char === '\r' && this.buffer[1] === '\n') {
          this.buffer = this.buffer.slice(2);
        } else {
          this.buffer = this.buffer.slice(1);
        }
        continue;
      }

      if (char === '\t') {
        events.push({ type: 'TAB' });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // Backspace: \x7f (DEL) or \x08 (BS)
      if (char === '\x7f' || char === '\b' || char === '\x08') {
        events.push({ type: 'BACKSPACE' });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // Ctrl keys (ASCII 1..26)
      if (char === '\u0003') {
        events.push({ type: 'CTRL_C' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0004') {
        events.push({ type: 'CTRL_D' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u000c') {
        events.push({ type: 'CTRL_L' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0010') {
        events.push({ type: 'CTRL_P' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0012') {
        events.push({ type: 'CTRL_R' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0015') {
        events.push({ type: 'CTRL_U' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0017') {
        events.push({ type: 'CTRL_W' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0019') {
        events.push({ type: 'CTRL_Y' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0007') {
        events.push({ type: 'CTRL_G' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0014') {
        events.push({ type: 'CTRL_T' });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (char === '\u0002') {
        events.push({ type: 'CTRL_B' });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // Ignore remaining control characters (0x00-0x1F, 0x7F-0x9F)
      if (/[\x00-\x1f\x7f-\x9f]/.test(char)) {
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // 4. Printable characters (including Unicode code points)
      events.push({ type: 'CHARACTER', char });
      this.buffer = this.buffer.slice(1);
    }

    return events;
  }

  /**
   * Resets the decoder buffer state.
   */
  reset(): void {
    this.buffer = '';
    this.inBracketedPaste = false;
    this.pasteBuffer = '';
  }
}
