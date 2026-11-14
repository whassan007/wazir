import { stripTerminalEscapes } from '@wazir/shared';
import { stringDisplayWidth, truncateToDisplayWidth } from './unicode.js';
import type { ConversationTheme } from './theme.js';

const GRAPHEME_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

function splitGraphemes(text: string): string[] {
  if (!text) return [];
  if (GRAPHEME_SEGMENTER) {
    return Array.from(GRAPHEME_SEGMENTER.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * Strips internal reasoning tags (`<think>...</think>`, `<reasoning>...</reasoning>`)
 * and raw tool-protocol envelopes (`<tool_call>...</tool_call>`, raw JSON action objects)
 * so only user-facing prose enters the conversation transcript.
 */
export function sanitizeAssistantText(raw: string, options: { streaming?: boolean } = {}): string {
  if (!raw) return '';
  let text = stripTerminalEscapes(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Remove closed reasoning / tool XML blocks
  text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '');
  text = text.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '');
  text = text.replace(/<function_calls\b[^>]*>[\s\S]*?<\/function_calls>/gi, '');

  // During streaming, hide trailing unclosed <think> / <tool_call> blocks
  if (options.streaming) {
    text = text.replace(/<(?:think|reasoning|tool_call|function_calls)\b[^>]*>[\s\S]*$/i, '');
  }

  // Remove standalone single-line raw JSON tool-call protocol envelopes mixed with prose
  text = text.replace(/^\s*\{\s*"action"\s*:\s*"(?!done"|answer")[a-z0-9_-]+"\s*,[^\n]*\}\s*$/gim, '');

  const trimmed = text.trim();
  if (!trimmed) return '';

  // Filter legacy single-object JSON protocol turns: {"action":"tool",...} / {"action":"done","summary":"..."}
  if (trimmed.startsWith('{') && (trimmed.endsWith('}') || options.streaming)) {
    if (/^\{\s*"action"\s*:\s*"(tool|shell|read|write|edit|glob|search|git|test|build|lint|typecheck|plan)"/.test(trimmed)) {
      if (options.streaming) return '';
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.action === 'plan' && typeof parsed.content === 'string') {
          return parsed.content.trim();
        }
        return '';
      } catch {
        return '';
      }
    }
    if (!options.streaming && /^\{\s*"action"\s*:\s*"(done|answer)"/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const summary = typeof parsed.summary === 'string' ? parsed.summary : typeof parsed.content === 'string' ? parsed.content : '';
        return summary.trim();
      } catch {
        // Fall through if not valid JSON
      }
    }
  }

  return text.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Word-aware, grapheme-safe wrapping of a single plain-text line to `maxWidth` cells.
 */
export function wrapPlainText(line: string, maxWidth: number): string[] {
  const safeWidth = Math.max(8, maxWidth);
  if (!line) return [''];
  if (stringDisplayWidth(line) <= safeWidth) return [line];

  const leadingMatch = /^(\s*)/.exec(line);
  const leading = leadingMatch?.[1] ?? '';
  const body = line.slice(leading.length);
  const leadingWidth = Math.min(Math.floor(safeWidth / 3), stringDisplayWidth(leading));
  const effectiveLeading = ' '.repeat(leadingWidth);

  const tokens = body.split(/(\s+)/).filter((t) => t.length > 0);
  const out: string[] = [];
  let current = effectiveLeading;
  let currentW = leadingWidth;

  const pushHardWrappedToken = (token: string): void => {
    for (const g of splitGraphemes(token)) {
      const gw = Math.max(1, stringDisplayWidth(g));
      if (currentW + gw > safeWidth && currentW > leadingWidth) {
        out.push(current.trimEnd());
        current = effectiveLeading + g;
        currentW = leadingWidth + gw;
      } else {
        current += g;
        currentW += gw;
      }
    }
  };

  for (const token of tokens) {
    const isSpace = /^\s+$/.test(token);
    if (isSpace) {
      if (currentW > leadingWidth && currentW + token.length <= safeWidth) {
        current += token;
        currentW += token.length;
      }
      continue;
    }

    const tw = stringDisplayWidth(token);
    if (currentW + tw <= safeWidth) {
      current += token;
      currentW += tw;
    } else if (tw > safeWidth - leadingWidth) {
      if (currentW > leadingWidth) {
        out.push(current.trimEnd());
        current = effectiveLeading;
        currentW = leadingWidth;
      }
      pushHardWrappedToken(token);
    } else {
      out.push(current.trimEnd());
      current = effectiveLeading + token;
      currentW = leadingWidth + tw;
    }
  }

  if (current.length > 0 || out.length === 0) {
    out.push(current.trimEnd());
  }
  return out;
}

/**
 * Formats inline Markdown spans (`**bold**`, `*italic*`, `` `code` ``, `[label](url)`)
 * AFTER wrapping so ANSI escape codes never distort column width calculations.
 */
export function styleInlineMarkdown(line: string, theme: ConversationTheme): string {
  const styleNonCode = (segment: string): string => {
    let out = segment.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
      return `${theme.accent(label)} ${theme.muted(`(${url})`)}`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, boldText: string) => theme.bold(boldText));
    out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, (_m, pre: string, itText: string) => {
      return `${pre}${theme.italic(itText)}`;
    });
    return out;
  };

  // Split by inline `code` spans first so **bold** / *italic* never mutate code literals
  const parts = line.split(/(`[^`]+`)/g);
  return parts
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length >= 2 ? theme.code(part.slice(1, -1)) : styleNonCode(part)))
    .join('');
}

/**
 * Renders unified git diff or tool patch output with semantic colors and clear +/- prefixes
 * so diffs remain unambiguous in monochrome and ASCII terminals.
 */
export function renderUnifiedDiff(
  diffText: string,
  columns: number,
  theme: ConversationTheme,
  options: { indent?: number; maxLines?: number } = {},
): string[] {
  const indent = options.indent ?? 4;
  const maxLines = options.maxLines ?? 120;
  const pad = ' '.repeat(Math.max(0, columns < 56 ? 2 : indent));
  const avail = Math.max(16, columns - pad.length - 1);
  const rawLines = stripTerminalEscapes(diffText).replace(/\r\n/g, '\n').split('\n');
  const rendered: string[] = [];

  const visibleLines = rawLines.slice(0, maxLines);
  let lastDiffGitFile = '';
  for (const raw of visibleLines) {
    if (raw.startsWith('diff --git ')) {
      const filePart = raw.replace(/^diff --git a\/\S+\s+b\//, '');
      lastDiffGitFile = filePart;
      rendered.push(`${pad}${theme.bold(truncateToDisplayWidth(filePart, avail, '…'))}`);
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      if (raw.startsWith('+++ b/')) {
        const plusFile = raw.slice(6);
        if (plusFile !== lastDiffGitFile) {
          rendered.push(`${pad}${theme.bold(truncateToDisplayWidth(plusFile, avail, '…'))}`);
          lastDiffGitFile = plusFile;
        }
      }
      continue;
    }
    const clamped = truncateToDisplayWidth(raw, avail, '…');
    if (raw.startsWith('@@')) {
      rendered.push(`${pad}${theme.diffHunk(clamped)}`);
    } else if (raw.startsWith('+')) {
      rendered.push(`${pad}${theme.diffAdd(clamped)}`);
    } else if (raw.startsWith('-')) {
      rendered.push(`${pad}${theme.diffDel(clamped)}`);
    } else {
      rendered.push(`${pad}${theme.muted(clamped)}`);
    }
  }

  if (rawLines.length > maxLines) {
    rendered.push(`${pad}${theme.muted(`… ${rawLines.length - maxLines} more diff lines (use /diff --full or git diff)`)}`);
  }

  return rendered;
}

/**
 * Builds a concise inline preview diff for an `edit` or `write` tool approval/result.
 */
export function buildInlineEditPreview(
  filePath: string,
  oldString: string | undefined,
  newString: string | undefined,
  columns: number,
  theme: ConversationTheme,
  maxPreviewLines = 12,
): string[] {
  const pad = ' '.repeat(columns < 56 ? 2 : 4);
  const avail = Math.max(16, columns - pad.length - 2);
  const lines: string[] = [`${pad}${theme.bold(truncateToDisplayWidth(filePath, avail, '…'))}`];

  const oldLines = oldString ? oldString.replace(/\r\n/g, '\n').split('\n') : [];
  const newLines = newString ? newString.replace(/\r\n/g, '\n').split('\n') : [];

  let shown = 0;
  for (const l of oldLines) {
    if (shown >= Math.ceil(maxPreviewLines / 2)) {
      lines.push(`${pad}${theme.muted(`  … ${oldLines.length - shown} more removed line(s)`)}`);
      break;
    }
    lines.push(`${pad}${theme.diffDel(truncateToDisplayWidth(`- ${l}`, avail, '…'))}`);
    shown++;
  }

  let addedShown = 0;
  for (const l of newLines) {
    if (addedShown >= maxPreviewLines - shown) {
      lines.push(`${pad}${theme.muted(`  … ${newLines.length - addedShown} more added line(s)`)}`);
      break;
    }
    lines.push(`${pad}${theme.diffAdd(truncateToDisplayWidth(`+ ${l}`, avail, '…'))}`);
    addedShown++;
  }

  return lines;
}

/**
 * Renders assistant Markdown prose, fenced code blocks (preserving clean copy-paste without
 * box characters inside code lines), lists, headings, and fenced `diff` blocks.
 */
export function renderMarkdownMessage(
  markdown: string,
  columns: number,
  theme: ConversationTheme,
  options: { indent?: number } = {},
): string[] {
  const cleaned = sanitizeAssistantText(markdown);
  if (!cleaned) return [];

  const baseIndent = columns < 56 ? 2 : (options.indent ?? 2);
  const pad = ' '.repeat(baseIndent);
  const codePad = ' '.repeat(baseIndent + 2);
  const contentWidth = Math.max(16, columns - baseIndent - 2);
  const codeWidth = Math.max(14, columns - baseIndent - 4);

  const rawLines = cleaned.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLang = '';
  let fenceBuffer: string[] = [];

  const flushFence = (): void => {
    if (fenceLang === 'diff' || fenceLang === 'patch') {
      out.push(...renderUnifiedDiff(fenceBuffer.join('\n'), columns, theme, { indent: baseIndent + 2 }));
      fenceBuffer = [];
      return;
    }
    const label = fenceLang ? ` ${fenceLang} ` : '';
    const ruleLen = Math.max(4, Math.min(28, codeWidth - label.length));
    const headerRule = label
      ? `${theme.glyphs.codeRule.repeat(2)}${label}${theme.glyphs.codeRule.repeat(Math.max(2, ruleLen - 2))}`
      : theme.glyphs.codeRule.repeat(Math.min(20, codeWidth));
    out.push(`${codePad}${theme.muted(headerRule)}`);
    for (const codeLine of fenceBuffer) {
      const expanded = codeLine.replace(/\t/g, '  ');
      if (stringDisplayWidth(expanded) <= codeWidth) {
        out.push(`${codePad}${theme.code(expanded)}`);
      } else {
        for (const wrapped of wrapPlainText(expanded, codeWidth)) {
          out.push(`${codePad}${theme.code(wrapped)}`);
        }
      }
    }
    fenceBuffer = [];
  };

  for (const rawLine of rawLines) {
    const fenceMatch = /^\s*```([a-zA-Z0-9_+-]*)\s*$/.exec(rawLine);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = (fenceMatch[1] ?? '').toLowerCase();
        fenceBuffer = [];
      } else {
        flushFence();
        inFence = false;
        fenceLang = '';
      }
      continue;
    }

    if (inFence) {
      fenceBuffer.push(rawLine);
      continue;
    }

    if (!rawLine.trim()) {
      if (out.length > 0 && out.at(-1) !== '') {
        out.push('');
      }
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(rawLine)) {
      out.push(`${pad}${theme.muted(theme.glyphs.rule.repeat(Math.min(40, contentWidth)))}`);
      continue;
    }

    // Headings
    const headingMatch = /^\s*(#{1,4})\s+(.+)$/.exec(rawLine);
    if (headingMatch) {
      const title = headingMatch[2]!.trim();
      for (const w of wrapPlainText(title, contentWidth)) {
        out.push(`${pad}${theme.bold(styleInlineMarkdown(w, theme))}`);
      }
      continue;
    }

    // Bullet list items
    const bulletMatch = /^(\s*)[-*•]\s+(.+)$/.exec(rawLine);
    if (bulletMatch) {
      const depth = Math.min(6, Math.floor((bulletMatch[1]?.length ?? 0) / 2) * 2);
      const itemPad = `${pad}${' '.repeat(depth)}`;
      const bulletPrefix = `${theme.glyphs.bullet} `;
      const contPrefix = '  ';
      const itemWidth = Math.max(12, contentWidth - depth - 2);
      const wrapped = wrapPlainText(bulletMatch[2]!, itemWidth);
      wrapped.forEach((w, idx) => {
        const prefix = idx === 0 ? theme.muted(bulletPrefix) : contPrefix;
        out.push(`${itemPad}${prefix}${styleInlineMarkdown(w, theme)}`);
      });
      continue;
    }

    // Numbered list items
    const numMatch = /^(\s*)(\d+\.)\s+(.+)$/.exec(rawLine);
    if (numMatch) {
      const depth = Math.min(6, Math.floor((numMatch[1]?.length ?? 0) / 2) * 2);
      const numLabel = `${numMatch[2]} `;
      const itemPad = `${pad}${' '.repeat(depth)}`;
      const itemWidth = Math.max(12, contentWidth - depth - numLabel.length);
      const wrapped = wrapPlainText(numMatch[3]!, itemWidth);
      wrapped.forEach((w, idx) => {
        const prefix = idx === 0 ? theme.muted(numLabel) : ' '.repeat(numLabel.length);
        out.push(`${itemPad}${prefix}${styleInlineMarkdown(w, theme)}`);
      });
      continue;
    }

    // Blockquote
    const quoteMatch = /^\s*>\s?(.*)$/.exec(rawLine);
    if (quoteMatch) {
      const bar = theme.unicode ? '│ ' : '| ';
      const qWidth = Math.max(12, contentWidth - 2);
      for (const w of wrapPlainText(quoteMatch[1]!, qWidth)) {
        out.push(`${pad}${theme.muted(bar)}${theme.muted(w)}`);
      }
      continue;
    }

    // Ordinary paragraph line
    for (const w of wrapPlainText(rawLine, contentWidth)) {
      out.push(`${pad}${styleInlineMarkdown(w, theme)}`);
    }
  }

  // Unclosed code fence (e.g. during streaming)
  if (inFence && fenceBuffer.length > 0) {
    flushFence();
  }

  return out;
}
