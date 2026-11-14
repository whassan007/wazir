import { stringDisplayWidth } from './unicode.js';

const GRAPHEME_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

export interface GraphemeSpan {
  segment: string;
  start: number;
  end: number;
  width: number;
}

export function segmentGraphemes(text: string): GraphemeSpan[] {
  if (!text) return [];
  if (GRAPHEME_SEGMENTER) {
    const out: GraphemeSpan[] = [];
    for (const part of GRAPHEME_SEGMENTER.segment(text)) {
      out.push({
        segment: part.segment,
        start: part.index,
        end: part.index + part.segment.length,
        width: part.segment === '\n' ? 0 : Math.max(1, stringDisplayWidth(part.segment)),
      });
    }
    return out;
  }
  const out: GraphemeSpan[] = [];
  let offset = 0;
  for (const ch of Array.from(text)) {
    out.push({
      segment: ch,
      start: offset,
      end: offset + ch.length,
      width: ch === '\n' ? 0 : Math.max(1, stringDisplayWidth(ch)),
    });
    offset += ch.length;
  }
  return out;
}

export function clampGraphemeCursor(text: string, cursor: number): number {
  const clamped = Math.max(0, Math.min(text.length, cursor));
  if (clamped === 0 || clamped === text.length) return clamped;
  for (const span of segmentGraphemes(text)) {
    if (clamped === span.start || clamped === span.end) return clamped;
    if (clamped > span.start && clamped < span.end) return span.end;
  }
  return clamped;
}

export interface WrappedPromptLayout {
  /** Plain text lines WITHOUT prefix, one per visual wrapped row */
  contentLines: string[];
  /** UTF-16 start offset in `text` for each visual row */
  rowStarts: number[];
  /** UTF-16 end offset in `text` for each visual row */
  rowEnds: number[];
  /** 0-based visual row index containing `cursor` */
  cursorRow: number;
  /** 0-based terminal display column (including `prefixWidth`) of `cursor` */
  cursorCol: number;
}

/**
 * Wraps `text` across visual lines of width `columns - prefixWidth` while computing
 * the exact `(cursorRow, cursorCol)` in terminal display cells across:
 * - horizontal movement (`Left`, `Right`, `Home`, `End`)
 * - soft-wrapped lines and explicit `\n` multiline prompts
 * - wide CJK characters (2 cells), emoji ZWJ sequences, and combining characters.
 */
export function layoutPromptWithCursor(
  text: string,
  rawCursor: number,
  columns: number,
  prefixWidth = 2,
): WrappedPromptLayout {
  const safeCols = Math.max(prefixWidth + 4, columns);
  const maxContentCols = Math.max(4, safeCols - prefixWidth);
  const cursor = clampGraphemeCursor(text, rawCursor);

  if (text.length === 0) {
    return {
      contentLines: [''],
      rowStarts: [0],
      rowEnds: [0],
      cursorRow: 0,
      cursorCol: prefixWidth,
    };
  }

  const spans = segmentGraphemes(text);
  const contentLines: string[] = [];
  const rowStarts: number[] = [];
  const rowEnds: number[] = [];

  let currentText = '';
  let currentCols = 0;
  let currentStart = 0;
  let cursorRow = 0;
  let cursorCol = prefixWidth;
  let cursorPlaced = false;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;

    if (span.segment === '\n') {
      if (!cursorPlaced && cursor <= span.start) {
        cursorRow = contentLines.length;
        cursorCol = prefixWidth + currentCols;
        cursorPlaced = true;
      }
      contentLines.push(currentText);
      rowStarts.push(currentStart);
      rowEnds.push(span.start);
      currentText = '';
      currentCols = 0;
      currentStart = span.end;
      if (!cursorPlaced && cursor === span.end) {
        cursorRow = contentLines.length;
        cursorCol = prefixWidth;
        cursorPlaced = true;
      }
      continue;
    }

    // Soft-wrap BEFORE placing `span` if it would overflow `maxContentCols`
    if (currentCols + span.width > maxContentCols && currentCols > 0) {
      if (!cursorPlaced && cursor === span.start) {
        // Cursor sits right at the soft-wrap boundary -> place at start of the new wrapped row
        contentLines.push(currentText);
        rowStarts.push(currentStart);
        rowEnds.push(span.start);
        currentText = '';
        currentCols = 0;
        currentStart = span.start;
        cursorRow = contentLines.length;
        cursorCol = prefixWidth;
        cursorPlaced = true;
      } else {
        contentLines.push(currentText);
        rowStarts.push(currentStart);
        rowEnds.push(span.start);
        currentText = '';
        currentCols = 0;
        currentStart = span.start;
      }
    }

    if (!cursorPlaced && cursor <= span.start) {
      cursorRow = contentLines.length;
      cursorCol = prefixWidth + currentCols;
      cursorPlaced = true;
    }

    currentText += span.segment;
    currentCols += span.width;

    // If adding this grapheme filled the row completely and it's the end of text (or cursor is right after it
    // with no newline next), check if cursor is at `span.end` and would overflow `safeCols - 1`.
    if (!cursorPlaced && cursor === span.end) {
      const nextSpan = spans[i + 1];
      if (currentCols >= maxContentCols && (!nextSpan || nextSpan.segment !== '\n')) {
        contentLines.push(currentText);
        rowStarts.push(currentStart);
        rowEnds.push(span.end);
        currentText = '';
        currentCols = 0;
        currentStart = span.end;
        cursorRow = contentLines.length;
        cursorCol = prefixWidth;
        cursorPlaced = true;
      } else {
        cursorRow = contentLines.length;
        cursorCol = prefixWidth + currentCols;
        cursorPlaced = true;
      }
    }
  }

  // Push final row unless we just pushed an empty trailing wrap row with nothing left
  if (contentLines.length === 0 || currentText.length > 0 || text.endsWith('\n') || cursorRow === contentLines.length) {
    contentLines.push(currentText);
    rowStarts.push(currentStart);
    rowEnds.push(text.length);
  }

  if (!cursorPlaced) {
    cursorRow = Math.max(0, contentLines.length - 1);
    cursorCol = prefixWidth + stringDisplayWidth(contentLines[cursorRow] ?? '');
  }

  cursorCol = Math.max(0, Math.min(safeCols - 1, cursorCol));

  return {
    contentLines,
    rowStarts,
    rowEnds,
    cursorRow,
    cursorCol,
  };
}

/**
 * Moves cursor vertically across wrapped or multiline rows while preserving target display column.
 * Returns `null` when already on the topmost (`direction = -1`) or bottommost (`direction = 1`) row
 * so the caller can seamlessly transition to prompt history navigation!
 */
export function moveCursorVertically(
  text: string,
  cursor: number,
  direction: -1 | 1,
  columns: number,
  prefixWidth = 2,
): number | null {
  const layout = layoutPromptWithCursor(text, cursor, columns, prefixWidth);
  const targetRow = layout.cursorRow + direction;
  if (targetRow < 0 || targetRow >= layout.contentLines.length) {
    return null;
  }

  const desiredContentCol = Math.max(0, layout.cursorCol - prefixWidth);
  const rowStart = layout.rowStarts[targetRow] ?? 0;
  const rowText = layout.contentLines[targetRow] ?? '';
  const rowSpans = segmentGraphemes(rowText);

  let cols = 0;
  for (const span of rowSpans) {
    if (cols + span.width > desiredContentCol) {
      return rowStart + span.start;
    }
    cols += span.width;
  }
  return rowStart + rowText.length;
}

/**
 * Logical line Home (`Ctrl+A` / `Home`): moves to start of current logical `\n`-delimited line,
 * or to offset `0` if already at the start of the current logical line.
 */
export function findLineHomeOffset(text: string, cursor: number): number {
  const clamped = clampGraphemeCursor(text, cursor);
  const lastNewline = text.lastIndexOf('\n', clamped - 1);
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
  return clamped === lineStart ? 0 : lineStart;
}

/**
 * Logical line End (`Ctrl+E` / `End`): moves to end of current logical `\n`-delimited line,
 * or to `text.length` if already at the end of the current logical line.
 */
export function findLineEndOffset(text: string, cursor: number): number {
  const clamped = clampGraphemeCursor(text, cursor);
  const nextNewline = text.indexOf('\n', clamped);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  return clamped === lineEnd ? text.length : lineEnd;
}

/**
 * Kill to end of logical line (`Ctrl+K`): deletes from `cursor` to end of logical line
 * (or deletes the `\n` itself when already at the end of a logical line).
 */
export function killToLineEnd(text: string, cursor: number): { text: string; cursor: number } {
  const clamped = clampGraphemeCursor(text, cursor);
  if (clamped >= text.length) return { text, cursor: clamped };
  const nextNewline = text.indexOf('\n', clamped);
  if (nextNewline === clamped) {
    return { text: text.slice(0, clamped) + text.slice(clamped + 1), cursor: clamped };
  }
  const end = nextNewline === -1 ? text.length : nextNewline;
  return { text: text.slice(0, clamped) + text.slice(end), cursor: clamped };
}

/**
 * Kill to start of logical line (`Ctrl+U`): deletes from start of current logical line to `cursor`
 * (or deletes entire buffer if single-line).
 */
export function killToLineStart(text: string, cursor: number): { text: string; cursor: number } {
  const clamped = clampGraphemeCursor(text, cursor);
  if (clamped === 0) return { text, cursor: 0 };
  const lastNewline = text.lastIndexOf('\n', clamped - 1);
  if (lastNewline === -1) {
    return { text: text.slice(clamped), cursor: 0 };
  }
  if (lastNewline === clamped - 1) {
    return { text: text.slice(0, lastNewline) + text.slice(clamped), cursor: lastNewline };
  }
  return {
    text: text.slice(0, lastNewline + 1) + text.slice(clamped),
    cursor: lastNewline + 1,
  };
}

/**
 * Detects reliable cross-terminal newline insertion key chords:
 * - `Ctrl+J` (`\n` when `rawKeyObj?.ctrl && rawKeyObj?.name === 'j'`, or standalone `\x0a` when terminal sends `\r` for Enter)
 * - `Alt+Enter` / `Option+Enter` / `Esc+Enter` (`\x1b\r`, `\x1b\n`, `meta && return/enter`)
 * - `Shift+Enter` (`\x1b[13;2u`, `\x1b[27;2;13~`, `shift && return/enter`)
 */
export function isExplicitNewlineChord(
  keyStr: string,
  keyObj?: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string },
): boolean {
  const seq = keyObj?.sequence ?? keyStr;
  if (seq === '\x1b\r' || seq === '\x1b\n') return true;
  if (seq === '\x1b[13;2u' || seq === '\x1b[27;2;13~') return true;
  if (keyObj?.meta && (keyObj.name === 'return' || keyObj.name === 'enter')) return true;
  if (keyObj?.shift && (keyObj.name === 'return' || keyObj.name === 'enter')) return true;
  // Ctrl+J sends \n (0x0A), whereas plain Enter on raw TTY sends \r (0x0D).
  if (keyObj?.ctrl && (keyObj.name === 'j' || keyObj.name === 'J') && seq === '\n') return true;
  return false;
}
