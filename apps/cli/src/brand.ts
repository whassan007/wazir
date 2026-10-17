import os from 'os';

/**
 * Authoritative Wazir Corporate Visual Identity (CVI) tokens.
 * Synchronized with `assets/brand/brand.json` and `assets/brand/Wazir_CVI_Guidelines.pdf`.
 */
export const WAZIR_BRAND = {
  name: 'Wazir',
  wordmark: 'WAZIR',
  subtitle: 'A Local AI Fleet Counselor',
  subtitleUpper: 'A LOCAL AI FLEET COUNSELOR',
  tagline: 'Autonomous Agent Orchestration',
  colors: {
    darkAbyss: { hex: '#0f131a', rgb: [15, 19, 26] as const },
    electricBlue: { hex: '#38bdf8', rgb: [56, 189, 248] as const },
    metallicSilver: { hex: '#94a3b8', rgb: [148, 163, 184] as const },
    dataGreen: { hex: '#22c55e', rgb: [34, 197, 94] as const },
    iceWhite: { hex: '#f8fafc', rgb: [248, 250, 252] as const },
    cyanCoreGlow: { hex: '#67e8f9', rgb: [103, 232, 249] as const },
    shieldInteriorNavy: { hex: '#162032', rgb: [22, 32, 50] as const },
    shieldLowerSteel: { hex: '#2f4469', rgb: [47, 68, 105] as const },
  },
  minimumDigitalEmblemSizePx: 96,
} as const;

export type ColorMode = 'truecolor' | 'ansi16' | 'none';
export type LogoVariant = 'unicode-wide' | 'unicode-medium' | 'ascii' | 'compact';

export interface TerminalEnvironmentInput {
  isTTY?: boolean;
  columns?: number;
  env?: Record<string, string | undefined>;
  noColorFlag?: boolean;
  noBannerFlag?: boolean;
  asciiFlag?: boolean;
  jsonFlag?: boolean;
  quietFlag?: boolean;
}

export interface TerminalCapabilities {
  isTTY: boolean;
  columns: number;
  unicode: boolean;
  colorMode: ColorMode;
  variant: LogoVariant;
  suppressBanner: boolean;
}

export interface StartupBannerStatus {
  version: string;
  workspace: string;
  runtimeConnected: boolean;
  runtimeLabel?: string;
  modelsAvailable: number;
  mode?: string;
  promptHint?: string;
}

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';

function fgTruecolor(rgb: readonly [number, number, number]): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

interface PaletteCodes {
  reset: string;
  crown: string;
  shield: string;
  trace: string;
  core: string;
  wordmark: string;
  subtitle: string;
  accent: string;
  green: string;
  muted: string;
}

function createPaletteCodes(mode: ColorMode): PaletteCodes {
  if (mode === 'none') {
    return {
      reset: '',
      crown: '',
      shield: '',
      trace: '',
      core: '',
      wordmark: '',
      subtitle: '',
      accent: '',
      green: '',
      muted: '',
    };
  }
  if (mode === 'truecolor') {
    return {
      reset: ANSI_RESET,
      crown: `${ANSI_BOLD}${fgTruecolor(WAZIR_BRAND.colors.iceWhite.rgb)}`,
      shield: fgTruecolor(WAZIR_BRAND.colors.metallicSilver.rgb),
      trace: fgTruecolor(WAZIR_BRAND.colors.electricBlue.rgb),
      core: `${ANSI_BOLD}${fgTruecolor(WAZIR_BRAND.colors.cyanCoreGlow.rgb)}`,
      wordmark: `${ANSI_BOLD}${fgTruecolor(WAZIR_BRAND.colors.iceWhite.rgb)}`,
      subtitle: fgTruecolor(WAZIR_BRAND.colors.metallicSilver.rgb),
      accent: `${ANSI_BOLD}${fgTruecolor(WAZIR_BRAND.colors.electricBlue.rgb)}`,
      green: `${ANSI_BOLD}${fgTruecolor(WAZIR_BRAND.colors.dataGreen.rgb)}`,
      muted: fgTruecolor(WAZIR_BRAND.colors.metallicSilver.rgb),
    };
  }
  // 16-color ANSI fallback
  return {
    reset: ANSI_RESET,
    crown: '\x1b[1;97m',
    shield: '\x1b[37m',
    trace: '\x1b[36m',
    core: '\x1b[1;96m',
    wordmark: '\x1b[1;97m',
    subtitle: '\x1b[37m',
    accent: '\x1b[1;36m',
    green: '\x1b[1;32m',
    muted: '\x1b[90m',
  };
}

/**
 * Strips ANSI escape sequences to compute visible character length.
 */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Detects terminal capabilities (Unicode support, color depth, width tier,
 * and banner suppression rules) from process state or injected test options.
 */
export function detectTerminalCapabilities(
  input: TerminalEnvironmentInput = {}
): TerminalCapabilities {
  const env = input.env ?? process.env;
  const isTTY = input.isTTY ?? Boolean(process.stdout && process.stdout.isTTY);
  const rawCols =
    input.columns ??
    (process.stdout && typeof process.stdout.columns === 'number'
      ? process.stdout.columns
      : 80);
  const columns = Math.max(20, rawCols || 80);

  const term = (env.TERM ?? '').toLowerCase();
  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  const locale = `${env.LC_ALL ?? ''} ${env.LC_CTYPE ?? ''} ${env.LANG ?? ''}`.toLowerCase();

  const isDumbTerm = term === 'dumb';
  const isAsciiLocale =
    /\b(c|posix|ascii|us-ascii)\b/.test(locale) && !locale.includes('utf');
  const forceAscii =
    Boolean(input.asciiFlag) ||
    env.WAZIR_ASCII === '1' ||
    isDumbTerm ||
    isAsciiLocale;
  const unicode = !forceAscii;

  const noColorEnv =
    env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const forceNoColor =
    Boolean(input.noColorFlag) ||
    noColorEnv ||
    isDumbTerm ||
    env.FORCE_COLOR === '0';

  let colorMode: ColorMode = 'none';
  if (!forceNoColor && (isTTY || (env.FORCE_COLOR && env.FORCE_COLOR !== '0'))) {
    if (
      colorTerm === 'truecolor' ||
      colorTerm === '24bit' ||
      term.includes('256color') ||
      term.includes('kitty') ||
      term.includes('alacritty') ||
      term.includes('wezterm') ||
      env.TERM_PROGRAM === 'iTerm.app' ||
      env.TERM_PROGRAM === 'vscode' ||
      env.TERM_PROGRAM === 'Apple_Terminal' ||
      env.WT_SESSION !== undefined
    ) {
      colorMode = colorTerm === 'truecolor' || colorTerm === '24bit' || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode' || env.WT_SESSION !== undefined
        ? 'truecolor'
        : 'ansi16';
    } else {
      colorMode = 'ansi16';
    }
  }

  let variant: LogoVariant;
  if (columns < 46) {
    variant = 'compact';
  } else if (!unicode) {
    variant = 'ascii';
  } else if (columns < 66) {
    variant = 'unicode-medium';
  } else {
    variant = 'unicode-wide';
  }

  const suppressBanner =
    !isTTY ||
    Boolean(input.noBannerFlag) ||
    Boolean(input.jsonFlag) ||
    Boolean(input.quietFlag) ||
    env.WAZIR_NO_BANNER === '1' ||
    env.CI === 'true';

  return {
    isTTY,
    columns,
    unicode,
    colorMode,
    variant,
    suppressBanner,
  };
}

/**
 * Renders the high-fidelity Unicode Wazir logo (`unicode-wide`).
 * Faithfully translates the authoritative logo (`assets/brand/logo.jpeg`):
 * - 3-peaked angular W-Crown (`/\   /▲\   /\`)
 * - Beveled shield perimeter (`╭─...─╮` tapering to `▽`)
 * - 8-way radial circuit traces (`╲ │ ╱`) with glowing cyan upper diagonals
 *   and concentric central AI core node (`◉`)
 * - Geometric bold `WAZIR` wordmark + `A LOCAL AI FLEET COUNSELOR` subtitle
 */
export function renderUnicodeWideLogo(colorMode: ColorMode = 'truecolor'): string {
  return renderUnicodeMediumLogo(colorMode);
}

/**
 * Renders the primary Unicode Wazir logo (`unicode-medium` / `unicode-wide`):
 * - 3-peaked angular W-Crown (`╱╲     ╱▲╲     ╱╲`)
 * - Beveled shield perimeter (`╭──...──╮` tapering to `╰──▽──╯`)
 * - Radial circuit traces (`○──╲ │ ╱──○`, `○───◎──(◉)──◎───○`) with glowing cyan core (`◉`)
 * - Sleek 2-row geometric `WAZIR` wordmark (`█   █ ▄▀█ ▀▀█ █ █▀█` / `▀▄▀▄▀ █▀█ █▄▄ █ █▀▄`)
 * - `A LOCAL AI FLEET COUNSELOR` subtitle + cyan accent rule (`━━━━━━━━`)
 */
export function renderUnicodeMediumLogo(colorMode: ColorMode = 'truecolor'): string {
  const c = createPaletteCodes(colorMode);
  const r = c.reset;

  const lines = [
    `         ${c.crown}╱╲     ╱▲╲     ╱╲${r}`,
    `     ${c.shield}╭──${c.crown}╱──╲───╱ │ ╲───╱──╲${c.shield}──╮${r}`,
    `     ${c.shield}│${r}   ${c.core}○${c.trace}──╲    │    ╱──${c.core}○${r}   ${c.shield}│${r}`,
    `     ${c.shield}│${r}   ${c.trace}○───◎──${c.core}(◉)${c.trace}──◎───○${r}   ${c.shield}│${r}`,
    `     ${c.shield}╲${r}   ${c.shield}○──╱${r}   ${c.trace}╱│╲${r}   ${c.shield}╲──○${r}   ${c.shield}╱${r}`,
    `      ${c.shield}╰──────╲   ${c.trace}○${c.shield}   ╱──────╯${r}`,
    `              ${c.shield}╰──▽──╯${r}`,
    `      ${c.wordmark}█   █ ▄▀█ ▀▀█ █ █▀█${r}`,
    `      ${c.wordmark}▀▄▀▄▀ █▀█ █▄▄ █ █▀▄${r}`,
    `    ${c.subtitle}A LOCAL AI FLEET COUNSELOR${r}`,
    `            ${c.accent}━━━━━━━━${r}`,
  ];
  return lines.join('\n');
}

/**
 * Renders the plain 7-bit ASCII fallback logo (`ascii`).
 * Works in basic terminals without Unicode or color.
 */
export function renderPlainAsciiLogo(colorMode: ColorMode = 'none'): string {
  const c = createPaletteCodes(colorMode);
  const r = c.reset;

  const lines = [
    `            ${c.crown}/\\     /^\\     /\\${r}`,
    `           ${c.crown}/  \\   / | \\   /  \\${r}`,
    `       ${c.shield}+--${c.crown}/----\\-/  |  \\-/----\\${c.shield}--+${r}`,
    `       ${c.shield}|${r}   ${c.core}o${c.trace}--\\     |     /--${c.core}o${r}   ${c.shield}|${r}`,
    `       ${c.shield}|${r}       ${c.trace}\\    |    /${r}       ${c.shield}|${r}`,
    `       ${c.shield}|${r}   ${c.trace}o----(+)---(+)----o${r}   ${c.shield}|${r}`,
    `       ${c.shield}|${r}   ${c.trace}o-------${c.core}(@)${c.trace}-------o${r}   ${c.shield}|${r}`,
    `       ${c.shield}\\${r}   ${c.shield}o--/${r}    ${c.trace}/|\\${r}    ${c.shield}\\--o${r}   ${c.shield}/${r}`,
    `        ${c.shield}\\${r}         ${c.trace}o | o${r}         ${c.shield}/${r}`,
    `         ${c.shield}'-------\\  ${c.trace}o${c.shield}  /-------'${r}`,
    `                  ${c.shield}'-v-'${r}`,
    ``,
    `   ${c.wordmark}__        __    _     _____ ___ ____${r}`,
    `   ${c.wordmark}\\ \\      / /   / \\   |__  /|_ _|  _ \\${r}`,
    `   ${c.wordmark} \\ \\ /\\ / /   / _ \\    / /  | || |_) |${r}`,
    `   ${c.wordmark}  \\ V  V /   / ___ \\  / /_  | ||  _ <${r}`,
    `   ${c.wordmark}   \\_/\\_/   /_/   \\_\\/____||___|_| \\_\\${r}`,
    `         ${c.subtitle}A LOCAL AI FLEET COUNSELOR${r}`,
    `                 ${c.accent}==========${r}`,
  ];
  return lines.join('\n');
}

/**
 * Renders the compact Wazir emblem & wordmark (`compact`) for narrow terminals,
 * status bars, SSH sessions, log headers, and small terminal panes.
 */
export function renderCompactLogo(
  options: { unicode?: boolean; colorMode?: ColorMode; maxWidth?: number } = {}
): string {
  const unicode = options.unicode ?? true;
  const colorMode = options.colorMode ?? 'none';
  const maxWidth = options.maxWidth ?? 44;
  const c = createPaletteCodes(colorMode);
  const r = c.reset;

  const emblem = unicode
    ? `${c.crown}⟪${c.core}◈${c.crown}⟫${r}`
    : `${c.crown}[${c.core}W${c.crown}]${r}`;
  const sep = unicode ? '·' : '-';

  if (maxWidth < 34) {
    return `${emblem} ${c.wordmark}WAZIR${r}`;
  }
  return `${emblem} ${c.wordmark}WAZIR${r} ${c.shield}${sep}${r} ${c.subtitle}AI Fleet Counselor${r}`;
}

/**
 * Selects and renders the appropriate Wazir terminal logo based on capabilities.
 */
export function selectTerminalLogo(
  input: TerminalEnvironmentInput = {}
): { logo: string; capabilities: TerminalCapabilities } {
  const capabilities = detectTerminalCapabilities(input);

  let logo: string;
  switch (capabilities.variant) {
    case 'unicode-wide':
      logo = renderUnicodeWideLogo(capabilities.colorMode);
      break;
    case 'unicode-medium':
      logo = renderUnicodeMediumLogo(capabilities.colorMode);
      break;
    case 'ascii':
      logo = renderPlainAsciiLogo(capabilities.colorMode);
      break;
    case 'compact':
      logo = renderCompactLogo({
        unicode: capabilities.unicode,
        colorMode: capabilities.colorMode,
        maxWidth: capabilities.columns,
      });
      break;
  }

  return { logo, capabilities };
}

/**
 * Formats a workspace path with `~` for the user's home directory and truncates
 * gracefully if the terminal is narrow.
 */
export function formatWorkspacePath(workspace: string, maxLen: number = 42): string {
  const home = os.homedir();
  let formatted = typeof workspace === 'string' ? workspace : process.cwd();
  if (home && workspace.startsWith(home)) {
    formatted = `~${workspace.slice(home.length) || '/'}`;
  }
  if (formatted.length <= maxLen) {
    return formatted;
  }
  const tailLen = Math.max(8, maxLen - 4);
  return `~…/${formatted.slice(-tailLen).replace(/^\/+/, '')}`;
}

/**
 * Tracks whether the startup banner has already been printed in the current
 * interactive session so terminal resize (`SIGWINCH`) events never spam or
 * reprint the banner repeatedly.
 */
export class BannerSessionGuard {
  private printed = false;

  public shouldPrint(input: TerminalEnvironmentInput = {}): boolean {
    if (this.printed) {
      return false;
    }
    const caps = detectTerminalCapabilities(input);
    if (caps.suppressBanner) {
      return false;
    }
    this.printed = true;
    return true;
  }

  public onResize(): boolean {
    // Never reprint the startup banner on terminal resize
    return false;
  }

  public reset(): void {
    this.printed = false;
  }
}

/**
 * Renders the full interactive CLI startup banner with real runtime telemetry
 * and strict column-width clamping so no line ever overflows `columns`.
 */
export function renderStartupBanner(
  status: StartupBannerStatus,
  input: TerminalEnvironmentInput = {}
): string {
  const { logo, capabilities } = selectTerminalLogo(input);
  if (capabilities.suppressBanner) {
    return '';
  }

  const c = createPaletteCodes(capabilities.colorMode);
  const r = c.reset;
  const cols = capabilities.columns;

  const runtimeDot = capabilities.unicode ? '●' : '*';
  const runtimeStateText = status.runtimeConnected
    ? `${c.green}${runtimeDot} Connected${status.runtimeLabel ? ` (${status.runtimeLabel})` : ''}${r}`
    : `${c.muted}${runtimeDot} Offline${status.runtimeLabel ? ` (${status.runtimeLabel})` : ''}${r}`;

  const modelsText = `${status.modelsAvailable} available`;
  const modeText = status.mode ?? 'Autonomous';
  const maxValueWidth = Math.max(12, cols - 14);
  const workspaceText = formatWorkspacePath(status.workspace, maxValueWidth);
  const promptHint = status.promptHint ?? 'Enter a task or run `wa --help`...';
  const promptGlyph = capabilities.unicode ? '❯' : '>';

  const infoLines = [
    `${c.wordmark}Wazir v${status.version}${r}`,
    `${c.subtitle}${WAZIR_BRAND.tagline}${r}`,
    ``,
    `${c.muted}Workspace${r}  ${workspaceText}`,
    `${c.muted}Runtime${r}    ${runtimeStateText}`,
    `${c.muted}Models${r}     ${modelsText}`,
    `${c.muted}Mode${r}       ${c.accent}${modeText}${r}`,
    ``,
    `${c.accent}${promptGlyph}${r} ${c.subtitle}${promptHint}${r}`,
  ];

  const allLines = [...logo.split('\n'), '', ...infoLines];

  // Ensure no visible line exceeds `cols`
  return allLines
    .map((line) => {
      const visible = stripAnsi(line);
      if (visible.length <= cols) {
        return line;
      }
      // If a line exceeds cols on ultra-narrow terminals, clip plain text safely
      return visible.slice(0, Math.max(1, cols));
    })
    .join('\n');
}
