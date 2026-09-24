/**
 * Unicode and ANSI display width calculations for terminal cell grids.
 * Terminal coordinates are CELL based, not JavaScript string-length based.
 */

// Regex for ANSI escape sequences (CSI, OSC, SGR, etc.)
export const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z~]|\x1b\([B0]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Strips all ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/**
 * Determines whether a code point is a full-width character (occupies 2 terminal cells).
 * Uses standard East Asian Width ranges and common emoji ranges.
 */
export function isFullWidthCodePoint(codePoint: number): boolean {
  if (codePoint < 0x1100) return false;

  return (
    // Hangul Jamo
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    // CJK Radicals Supplement .. Enclosed CJK Letters and Months
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    // Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    // CJK Unified Ideographs .. Yi Radicals
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    // Hangul Syllables
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    // CJK Compatibility Ideographs
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    // Vertical Forms .. CJK Compatibility Forms
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    // Fullwidth Forms
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    // Kana Supplement
    (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
    // CJK Unified Ideographs Extension B .. Extension F
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd) ||
    // Common emojis (Miscellaneous Symbols and Pictographs, Emoticons, Transport, etc.)
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa00 && codePoint <= 0x1fa6f) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x26ff) ||
    (codePoint >= 0x2700 && codePoint <= 0x27bf)
  );
}

/**
 * Returns the terminal cell width of a single character / code point.
 * Zero-width for combining characters and control codes, 2 for full-width/emojis, 1 otherwise.
 */
export function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Control characters: 0 width
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  // Combining diacritical marks
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }
  return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

/**
 * Computes the visible display width of a string in terminal cells.
 * Accurately handles ANSI styling, CJK, emoji, and combining characters.
 */
export function stringDisplayWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (const char of clean) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) {
      width += codePointWidth(cp);
    }
  }
  return width;
}

/**
 * Truncates a string to fit within a given terminal cell width, taking ANSI into account.
 * Appends ANSI reset code if an escape sequence was open.
 */
export function truncateToDisplayWidth(str: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  const totalWidth = stringDisplayWidth(str);
  if (totalWidth <= maxWidth) return str;

  const ellipsisWidth = stringDisplayWidth(ellipsis);
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);

  let currentWidth = 0;
  let result = '';
  let inEscape = false;
  let escapeBuf = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '\x1b') {
      inEscape = true;
      escapeBuf = char;
      continue;
    }
    if (inEscape) {
      escapeBuf += char;
      if (/[a-zA-Z~]/.test(char)) {
        inEscape = false;
        result += escapeBuf;
        escapeBuf = '';
      }
      continue;
    }

    const cp = char.codePointAt(0);
    const cpWidth = cp !== undefined ? codePointWidth(cp) : 1;
    if (currentWidth + cpWidth > targetWidth) {
      break;
    }
    currentWidth += cpWidth;
    result += char;
  }

  return result + ellipsis + '\x1b[0m';
}
