export type EditMatchStrategy = 'exact' | 'crlf_normalized' | 'line_trimmed' | 'block_anchor';

export interface SmartEditSuccess {
  ok: true;
  nextContent: string;
  count: number;
  strategyUsed: EditMatchStrategy;
  startLine: number;
  endLine: number;
  diffSnippet: string;
  error?: undefined;
}

export interface SmartEditFailure {
  ok: false;
  error: string;
}

export type SmartEditResult = SmartEditSuccess | SmartEditFailure;

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function leadingWhitespace(line: string): string {
  const m = /^[\t ]*/.exec(line);
  return m ? m[0] : '';
}

function normalizeCollapsed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildCompactDiff(
  beforeText: string,
  afterText: string,
  approxStartLine: number,
  oldLineCount: number,
  newLineCount: number,
): string {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const context = 2;
  const startIdx = Math.max(0, approxStartLine - 1);
  const ctxBeforeStart = Math.max(0, startIdx - context);
  const oldEndIdx = Math.min(beforeLines.length, startIdx + Math.max(1, oldLineCount));
  const newEndIdx = Math.min(afterLines.length, startIdx + Math.max(1, newLineCount));
  const ctxAfterEnd = Math.min(afterLines.length, newEndIdx + context);

  const out: string[] = [`@@ -${startIdx + 1},${oldLineCount} +${startIdx + 1},${newLineCount} @@`];
  for (let i = ctxBeforeStart; i < startIdx; i++) {
    out.push(`  ${beforeLines[i]}`);
  }
  const maxRemoved = Math.min(oldEndIdx, startIdx + 12);
  for (let i = startIdx; i < maxRemoved; i++) {
    out.push(`- ${beforeLines[i]}`);
  }
  if (oldEndIdx > maxRemoved) {
    out.push(`- ... (${oldEndIdx - maxRemoved} more line(s))`);
  }
  const maxAdded = Math.min(newEndIdx, startIdx + 12);
  for (let i = startIdx; i < maxAdded; i++) {
    out.push(`+ ${afterLines[i]}`);
  }
  if (newEndIdx > maxAdded) {
    out.push(`+ ... (${newEndIdx - maxAdded} more line(s))`);
  }
  for (let i = newEndIdx; i < ctxAfterEnd; i++) {
    out.push(`  ${afterLines[i]}`);
  }
  return out.join('\n');
}

function buildClosestSnippet(rawLines: string[], oldLines: string[]): string {
  if (rawLines.length === 0) return '';
  const nonEmptyTargets = oldLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (nonEmptyTargets.length === 0) return '';

  let bestLineIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const candidate = rawLines[i].trim();
    if (!candidate) continue;
    for (const target of nonEmptyTargets) {
      if (candidate === target) {
        const score = 2 + Math.min(1, target.length / 40);
        if (score > bestScore) {
          bestScore = score;
          bestLineIdx = i;
        }
      } else if (target.length >= 6 && (candidate.includes(target) || target.includes(candidate))) {
        const score = 1 + Math.min(0.9, Math.min(candidate.length, target.length) / 40);
        if (score > bestScore) {
          bestScore = score;
          bestLineIdx = i;
        }
      }
    }
  }

  if (bestLineIdx === -1) return '';
  const winStart = Math.max(0, bestLineIdx - 5);
  const winEnd = Math.min(rawLines.length, bestLineIdx + 10);
  const snippet = rawLines
    .slice(winStart, winEnd)
    .map((line, idx) => `${winStart + idx + 1}: ${line}`)
    .join('\n');
  return `\nClosest region in file (lines ${winStart + 1}-${winEnd}):\n${snippet}`;
}

function reindentReplacement(
  matchedRawLines: string[],
  oldLines: string[],
  newLines: string[],
): string[] {
  let minRawIndent: number | undefined;
  let minOldIndent: number | undefined;
  let rawIndentChar = ' ';

  for (let i = 0; i < matchedRawLines.length && i < oldLines.length; i++) {
    if (matchedRawLines[i].trim().length === 0 || oldLines[i].trim().length === 0) continue;
    const rw = leadingWhitespace(matchedRawLines[i]);
    const ow = leadingWhitespace(oldLines[i]);
    if (rw.startsWith('\t')) rawIndentChar = '\t';
    if (minRawIndent === undefined || rw.length < minRawIndent) minRawIndent = rw.length;
    if (minOldIndent === undefined || ow.length < minOldIndent) minOldIndent = ow.length;
  }

  if (minRawIndent === undefined || minOldIndent === undefined || minRawIndent === minOldIndent) {
    return newLines;
  }

  const delta = minRawIndent - minOldIndent;
  return newLines.map((line) => {
    if (line.trim().length === 0) return line;
    if (delta > 0) {
      return rawIndentChar.repeat(delta) + line;
    }
    const removeCount = Math.min(-delta, leadingWhitespace(line).length);
    return line.slice(removeCount);
  });
}

/**
 * Qwen Code 1.0 3-stage edit matcher:
 *   1. Exact substring match (with automatic LF <-> CRLF normalization fallback)
 *   2. Line-trimmed match (ignores leading/trailing per-line whitespace drift, preserves indentation delta)
 *   3. Block-anchor match (>= 3 lines: exact trimmed first/last anchors + >= 80% normalized interior match)
 *
 * Refuses ambiguous multi-matches unless `replaceAll === true`.
 */
export function computeSmartEdit(
  raw: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): SmartEditResult {
  if (!oldString) {
    return { ok: false, error: 'oldString must not be empty' };
  }

  // Stage 1A: Exact match
  const exactParts = raw.split(oldString);
  const exactCount = exactParts.length - 1;
  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      const lineNumbers: number[] = [];
      let searchFrom = 0;
      while (lineNumbers.length < 10) {
        const idx = raw.indexOf(oldString, searchFrom);
        if (idx === -1) break;
        lineNumbers.push(lineNumberAtOffset(raw, idx));
        searchFrom = idx + Math.max(1, oldString.length);
      }
      return {
        ok: false,
        error:
          `oldString matched ${exactCount} locations in file (around lines ${lineNumbers.join(', ')}). ` +
          'Include 2-3 surrounding context lines in oldString/newString so the target is unique, or pass replaceAll: true.',
      };
    }
    const firstIdx = raw.indexOf(oldString);
    const startLine = lineNumberAtOffset(raw, firstIdx);
    const oldLineCount = splitLines(oldString).length;
    const newLineCount = splitLines(newString).length;
    const nextContent = replaceAll ? exactParts.join(newString) : raw.replace(oldString, () => newString);
    return {
      ok: true,
      nextContent,
      count: replaceAll ? exactCount : 1,
      strategyUsed: 'exact',
      startLine,
      endLine: startLine + newLineCount - 1,
      diffSnippet: buildCompactDiff(raw, nextContent, startLine, oldLineCount, newLineCount),
    };
  }

  // Stage 1B: CRLF-normalized exact match
  const eol = detectEol(raw);
  if (eol === '\r\n' && !oldString.includes('\r\n')) {
    const crlfOld = oldString.replace(/\n/g, '\r\n');
    const crlfNew = newString.replace(/\r?\n/g, '\r\n');
    const crlfParts = raw.split(crlfOld);
    const crlfCount = crlfParts.length - 1;
    if (crlfCount > 0) {
      if (crlfCount > 1 && !replaceAll) {
        return {
          ok: false,
          error:
            `oldString matched ${crlfCount} locations in file (CRLF-normalized). ` +
            'Include surrounding context lines to make oldString unique, or pass replaceAll: true.',
        };
      }
      const firstIdx = raw.indexOf(crlfOld);
      const startLine = lineNumberAtOffset(raw, firstIdx);
      const oldLineCount = splitLines(oldString).length;
      const newLineCount = splitLines(newString).length;
      const nextContent = replaceAll ? crlfParts.join(crlfNew) : raw.replace(crlfOld, () => crlfNew);
      return {
        ok: true,
        nextContent,
        count: replaceAll ? crlfCount : 1,
        strategyUsed: 'crlf_normalized',
        startLine,
        endLine: startLine + newLineCount - 1,
        diffSnippet: buildCompactDiff(raw, nextContent, startLine, oldLineCount, newLineCount),
      };
    }
  }

  const rawLines = splitLines(raw);
  let oldLines = splitLines(oldString);
  let newLines = splitLines(newString);
  // Handle trailing newline on multi-line snippet when matching whole lines
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === '' && newLines.length > 1 && newLines[newLines.length - 1] === '') {
    oldLines = oldLines.slice(0, -1);
    newLines = newLines.slice(0, -1);
  }

  const hasNonEmptyOld = oldLines.some((l) => l.trim().length > 0);

  // Stage 2: Line-trimmed match
  if (hasNonEmptyOld && oldLines.length <= rawLines.length) {
    const winLen = oldLines.length;
    const trimmedOld = oldLines.map((l) => l.trim());
    const matchStarts: number[] = [];

    for (let i = 0; i <= rawLines.length - winLen; i++) {
      let allMatch = true;
      for (let j = 0; j < winLen; j++) {
        if (rawLines[i + j].trim() !== trimmedOld[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matchStarts.push(i);
        if (replaceAll) {
          i += winLen - 1; // non-overlapping windows
        }
      }
    }

    if (matchStarts.length > 1 && !replaceAll) {
      return {
        ok: false,
        error:
          `oldString matched ${matchStarts.length} locations by trimmed lines (lines ${matchStarts.map((s) => s + 1).join(', ')}). ` +
          'Include 2-3 surrounding context lines so oldString is unique, or pass replaceAll: true.',
      };
    }

    if (matchStarts.length > 0) {
      const updatedLines = [...rawLines];
      // Apply from bottom to top so line indices remain valid when replaceAll=true
      for (let m = matchStarts.length - 1; m >= 0; m--) {
        const start = matchStarts[m];
        const matchedSlice = rawLines.slice(start, start + winLen);
        const adjustedNew = reindentReplacement(matchedSlice, oldLines, newLines);
        updatedLines.splice(start, winLen, ...adjustedNew);
      }
      const nextContent = updatedLines.join(eol);
      const firstStartLine = matchStarts[0] + 1;
      return {
        ok: true,
        nextContent,
        count: matchStarts.length,
        strategyUsed: 'line_trimmed',
        startLine: firstStartLine,
        endLine: firstStartLine + newLines.length - 1,
        diffSnippet: buildCompactDiff(raw, nextContent, firstStartLine, winLen, newLines.length),
      };
    }
  }

  // Stage 3: Block-anchor match (>= 3 lines, single unambiguous occurrence only)
  if (!replaceAll && oldLines.length >= 3 && rawLines.length >= 3) {
    const firstAnchor = oldLines[0].trim();
    const lastAnchor = oldLines[oldLines.length - 1].trim();
    if (firstAnchor.length > 0 && lastAnchor.length > 0) {
      const oldInterior = normalizeCollapsed(oldLines.slice(1, -1).join('\n'));
      const candidates: Array<{ start: number; end: number }> = [];
      const minSpan = Math.max(3, oldLines.length - 1);
      const maxSpan = oldLines.length + 1;

      for (let start = 0; start < rawLines.length; start++) {
        if (rawLines[start].trim() !== firstAnchor) continue;
        for (let span = minSpan; span <= maxSpan; span++) {
          const end = start + span - 1;
          if (end >= rawLines.length) break;
          if (rawLines[end].trim() !== lastAnchor) continue;
          const rawInterior = normalizeCollapsed(rawLines.slice(start + 1, end).join('\n'));
          if (rawInterior === oldInterior) {
            candidates.push({ start, end });
          }
        }
      }

      if (candidates.length === 1) {
        const { start, end } = candidates[0];
        const spanLen = end - start + 1;
        const matchedSlice = rawLines.slice(start, end + 1);
        const adjustedNew = reindentReplacement(matchedSlice, oldLines, newLines);
        const updatedLines = [...rawLines];
        updatedLines.splice(start, spanLen, ...adjustedNew);
        const nextContent = updatedLines.join(eol);
        const startLine = start + 1;
        return {
          ok: true,
          nextContent,
          count: 1,
          strategyUsed: 'block_anchor',
          startLine,
          endLine: startLine + adjustedNew.length - 1,
          diffSnippet: buildCompactDiff(raw, nextContent, startLine, spanLen, adjustedNew.length),
        };
      }
    }
  }

  return {
    ok: false,
    error: `oldString not found in file.${buildClosestSnippet(rawLines, oldLines)}`,
  };
}
