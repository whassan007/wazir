/**
 * Virtual Terminal Frame and Cell Grid.
 * Every frame represents the ENTIRE viewport.
 * Components render into frames without directly emitting ANSI.
 */

import { codePointWidth, stripAnsi, stringDisplayWidth } from './unicode.js';

export interface CellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface TerminalCell {
  char: string;
  width: number; // 1 for normal, 2 for wide glyph, 0 for trailing continuation
  style?: CellStyle;
}

export function createBlankCell(): TerminalCell {
  return { char: ' ', width: 1 };
}

export function cloneCell(cell: TerminalCell): TerminalCell {
  return {
    char: cell.char,
    width: cell.width,
    style: cell.style ? { ...cell.style } : undefined,
  };
}

export function areStylesEqual(a?: CellStyle, b?: CellStyle): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dim) === Boolean(b.dim) &&
    Boolean(a.italic) === Boolean(a.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.inverse) === Boolean(b.inverse)
  );
}

export function areCellsEqual(a: TerminalCell, b: TerminalCell): boolean {
  if (a.char !== b.char || a.width !== b.width) return false;
  return areStylesEqual(a.style, b.style);
}

export interface CursorPosition {
  row: number; // 0-indexed
  col: number; // 0-indexed
  visible: boolean;
}

export class TerminalFrame {
  readonly width: number;
  readonly height: number;
  readonly rows: TerminalCell[][];
  cursor?: CursorPosition;

  constructor(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rows = new Array(this.height);
    for (let y = 0; y < this.height; y++) {
      const row = new Array(this.width);
      for (let x = 0; x < this.width; x++) {
        row[x] = createBlankCell();
      }
      this.rows[y] = row;
    }
  }

  static create(width: number, height: number): TerminalFrame {
    return new TerminalFrame(width, height);
  }

  getCell(x: number, y: number): TerminalCell | undefined {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return undefined;
    return this.rows[y][x];
  }

  setCell(x: number, y: number, cell: TerminalCell): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.rows[y][x] = cell;
  }

  /**
   * Writes text starting at (x, y) with optional style and clipping boundaries.
   * Accurately handles wide Unicode characters (CJK/emojis) spanning 2 cells.
   * If a wide character crosses the right boundary, it is not partially written.
   */
  writeText(
    startX: number,
    y: number,
    text: string,
    style?: CellStyle,
    clip?: { x: number; y: number; width: number; height: number },
  ): number {
    if (y < 0 || y >= this.height) return startX;
    if (clip && (y < clip.y || y >= clip.y + clip.height)) return startX;

    const minX = clip ? Math.max(0, clip.x) : 0;
    const maxX = clip ? Math.min(this.width, clip.x + clip.width) : this.width;

    let x = startX;
    for (const char of text) {
      const cp = char.codePointAt(0);
      const width = cp !== undefined ? codePointWidth(cp) : 1;

      if (width === 0) continue; // skip zero-width characters

      if (x >= maxX) break;

      if (width === 2) {
        if (x + 1 >= maxX) {
          // Cannot fit 2 cells, blank and stop
          if (x >= minX && x < this.width) {
            this.rows[y][x] = { char: ' ', width: 1, style };
          }
          break;
        }
        if (x >= minX) {
          this.rows[y][x] = { char, width: 2, style };
          this.rows[y][x + 1] = { char: '', width: 0, style };
        }
        x += 2;
      } else {
        if (x >= minX) {
          this.rows[y][x] = { char, width: 1, style };
        }
        x += 1;
      }
    }
    return x;
  }

  /**
   * Parses an ANSI-styled line of text and writes it into the frame starting at (x, y).
   */
  writeAnsiLine(
    startX: number,
    y: number,
    line: string,
    clip?: { x: number; y: number; width: number; height: number },
  ): void {
    if (y < 0 || y >= this.height) return;
    if (clip && (y < clip.y || y >= clip.y + clip.height)) return;

    let currentStyle: CellStyle = {};
    let textBuffer = '';
    let x = startX;

    let i = 0;
    while (i < line.length) {
      if (line[i] === '\x1b') {
        // Flush accumulated textBuffer with currentStyle
        if (textBuffer.length > 0) {
          x = this.writeText(x, y, textBuffer, currentStyle, clip);
          textBuffer = '';
        }
        // Parse ANSI sequence
        const seqMatch = line.slice(i).match(/^\x1b\[([0-9;]*)m/);
        if (seqMatch) {
          const codes = seqMatch[1].split(';').map((c) => parseInt(c, 10) || 0);
          currentStyle = updateStyleFromCodes(currentStyle, codes);
          i += seqMatch[0].length;
          continue;
        }
        // Non-color ANSI sequence (e.g. cursor moves, other codes) — skip
        const generalMatch = line.slice(i).match(/^\x1b\[[0-9;?]*[a-zA-Z~]/);
        if (generalMatch) {
          i += generalMatch[0].length;
          continue;
        }
        i++;
      } else {
        textBuffer += line[i];
        i++;
      }
    }
    if (textBuffer.length > 0) {
      this.writeText(x, y, textBuffer, currentStyle, clip);
    }
  }

  /**
   * Fills a rectangular region with blank cells or a specified character.
   */
  fillRect(
    rect: { x: number; y: number; width: number; height: number },
    char = ' ',
    style?: CellStyle,
  ): void {
    const startX = Math.max(0, rect.x);
    const endX = Math.min(this.width, rect.x + rect.width);
    const startY = Math.max(0, rect.y);
    const endY = Math.min(this.height, rect.y + rect.height);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        this.rows[y][x] = { char, width: 1, style };
      }
    }
  }

  /**
   * Clones this frame into a new TerminalFrame.
   */
  clone(): TerminalFrame {
    const next = new TerminalFrame(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        next.rows[y][x] = cloneCell(this.rows[y][x]);
      }
    }
    if (this.cursor) {
      next.cursor = { ...this.cursor };
    }
    return next;
  }

  /**
   * Converts the frame into a plain multiline text string (without ANSI styling).
   */
  toPlainText(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) {
        const cell = this.rows[y][x];
        if (cell.width !== 0) {
          line += cell.char;
        }
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}

/**
 * Updates a CellStyle based on SGR ANSI codes.
 */
function updateStyleFromCodes(style: CellStyle, codes: number[]): CellStyle {
  const next = { ...style };
  if (codes.length === 0) {
    return {};
  }
  for (let idx = 0; idx < codes.length; idx++) {
    const code = codes[idx];
    if (code === 0) {
      return {};
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 27) {
      next.inverse = false;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      next.fg = String(code);
    } else if (code === 38 && codes[idx + 1] === 5) {
      next.fg = `38;5;${codes[idx + 2]}`;
      idx += 2;
    } else if (code === 38 && codes[idx + 1] === 2) {
      next.fg = `38;2;${codes[idx + 2]};${codes[idx + 3]};${codes[idx + 4]}`;
      idx += 4;
    } else if (code === 39) {
      delete next.fg;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      next.bg = String(code);
    } else if (code === 48 && codes[idx + 1] === 5) {
      next.bg = `48;5;${codes[idx + 2]}`;
      idx += 2;
    } else if (code === 48 && codes[idx + 1] === 2) {
      next.bg = `48;2;${codes[idx + 2]};${codes[idx + 3]};${codes[idx + 4]}`;
      idx += 4;
    } else if (code === 49) {
      delete next.bg;
    }
  }
  return next;
}
