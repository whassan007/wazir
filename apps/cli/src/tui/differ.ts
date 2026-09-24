/**
 * FrameDiffer: compares previousFrame and currentFrame,
 * emitting minimal ANSI patches.
 * Supports both full redraw and differential redraw.
 * Enforces complete frame semantics: removed content is explicitly blanked.
 */

import { areCellsEqual, areStylesEqual, type CellStyle, type TerminalCell, type TerminalFrame } from './frame.js';

export interface DiffResult {
  patch: string;
  cellsChanged: number;
  isFullRedraw: boolean;
}

export class FrameDiffer {
  /**
   * Generates the minimal ANSI patch to transition from previousFrame to currentFrame.
   * If previousFrame is undefined or dimensions changed, generates a full redraw.
   */
  static diff(
    previousFrame: TerminalFrame | undefined,
    currentFrame: TerminalFrame,
    forceFull = false,
  ): DiffResult {
    const width = currentFrame.width;
    const height = currentFrame.height;

    const isFull =
      forceFull ||
      !previousFrame ||
      previousFrame.width !== width ||
      previousFrame.height !== height;

    if (isFull) {
      return FrameDiffer.renderFull(currentFrame);
    }

    return FrameDiffer.renderDiff(previousFrame, currentFrame);
  }

  /**
   * Renders the complete frame from scratch.
   */
  private static renderFull(frame: TerminalFrame): DiffResult {
    let patch = '\x1b[?25l'; // Hide cursor during paint
    let currentStyle: CellStyle | undefined;
    let cellsChanged = 0;

    for (let y = 0; y < frame.height; y++) {
      patch += `\x1b[${y + 1};1H`; // Move to row start
      for (let x = 0; x < frame.width; x++) {
        const cell = frame.rows[y][x];
        cellsChanged++;
        if (cell.width === 0) continue; // Trailing cell of wide character

        if (!areStylesEqual(currentStyle, cell.style)) {
          patch += styleToAnsi(cell.style);
          currentStyle = cell.style;
        }
        patch += cell.char;
      }
    }

    // Reset style after paint
    if (currentStyle) {
      patch += '\x1b[0m';
    }

    // Position cursor if requested
    if (frame.cursor && frame.cursor.visible) {
      patch += `\x1b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\x1b[?25h`;
    } else {
      patch += '\x1b[?25l';
    }

    return {
      patch,
      cellsChanged,
      isFullRedraw: true,
    };
  }

  /**
   * Renders only the cells that changed between previousFrame and currentFrame.
   */
  private static renderDiff(
    previousFrame: TerminalFrame,
    currentFrame: TerminalFrame,
  ): DiffResult {
    const width = currentFrame.width;
    const height = currentFrame.height;

    let patch = '';
    let cellsChanged = 0;
    let currentStyle: CellStyle | undefined;

    for (let y = 0; y < height; y++) {
      let inRun = false;
      let runStartX = 0;

      for (let x = 0; x < width; x++) {
        const prevCell = previousFrame.rows[y][x];
        const currCell = currentFrame.rows[y][x];

        if (!areCellsEqual(prevCell, currCell)) {
          cellsChanged++;
          if (!inRun) {
            inRun = true;
            runStartX = x;
            // If starting a run, position cursor
            patch += `\x1b[${y + 1};${x + 1}H`;
          }

          if (currCell.width === 0) {
            // Continuation cell of wide character — nothing to print directly
            continue;
          }

          if (!areStylesEqual(currentStyle, currCell.style)) {
            patch += styleToAnsi(currCell.style);
            currentStyle = currCell.style;
          }
          patch += currCell.char;
        } else {
          inRun = false;
        }
      }
    }

    // If nothing changed except cursor position
    if (cellsChanged > 0 && currentStyle) {
      patch += '\x1b[0m';
    }

    // Handle cursor
    const prevCursor = previousFrame.cursor;
    const currCursor = currentFrame.cursor;
    const cursorChanged =
      Boolean(prevCursor) !== Boolean(currCursor) ||
      (Boolean(prevCursor && currCursor) &&
        (prevCursor!.row !== currCursor!.row ||
          prevCursor!.col !== currCursor!.col ||
          prevCursor!.visible !== currCursor!.visible));

    if (cellsChanged > 0 || cursorChanged) {
      if (currCursor && currCursor.visible) {
        patch += `\x1b[${currCursor.row + 1};${currCursor.col + 1}H\x1b[?25h`;
      } else if (cursorChanged) {
        patch += '\x1b[?25l';
      }
    }

    return {
      patch,
      cellsChanged,
      isFullRedraw: false,
    };
  }
}

/**
 * Converts a CellStyle into an SGR ANSI escape sequence.
 */
export function styleToAnsi(style?: CellStyle): string {
  if (!style) return '\x1b[0m';

  const parts: string[] = ['0']; // reset first
  if (style.bold) parts.push('1');
  if (style.dim) parts.push('2');
  if (style.italic) parts.push('3');
  if (style.underline) parts.push('4');
  if (style.inverse) parts.push('7');
  if (style.fg) parts.push(style.fg);
  if (style.bg) parts.push(style.bg);

  return `\x1b[${parts.join(';')}m`;
}
