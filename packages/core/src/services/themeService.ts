import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type WazirThemeId =
  | 'tokyo-night'
  | 'catppuccin'
  | 'gruvbox'
  | 'rose-pine'
  | 'nord'
  | 'kanagawa'
  | 'everforest'
  | 'wazir-dark'
  | 'wazir-light';

export interface WazirThemeTokens {
  bg: string;
  panel: string;
  panel2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  ok: string;
  warn: string;
  err: string;
}

export interface WazirThemeAnsiPalette {
  primaryHex: string;
  accentHex: string;
  successHex: string;
  warningHex: string;
  errorHex: string;
  mutedHex: string;
}

export interface WazirThemePreset {
  id: WazirThemeId;
  name: string;
  description: string;
  mode: 'dark' | 'light';
  tokens: WazirThemeTokens;
  ansi: WazirThemeAnsiPalette;
}

export interface WazirThemeState {
  themeId: WazirThemeId;
  updatedAt: string;
}

export const DEFAULT_WAZIR_THEME_ID: WazirThemeId = 'tokyo-night';

export const WAZIR_THEMES: Record<WazirThemeId, WazirThemePreset> = {
  'tokyo-night': {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Deep indigo-night slate with electric cyan and violet accents',
    mode: 'dark',
    tokens: {
      bg: '#1a1b26',
      panel: '#16161e',
      panel2: '#24283b',
      border: '#3b4261',
      text: '#c0caf5',
      muted: '#737aa2',
      accent: '#7aa2f7',
      ok: '#9ece6a',
      warn: '#e0af68',
      err: '#f7768e',
    },
    ansi: {
      primaryHex: '#c0caf5',
      accentHex: '#7aa2f7',
      successHex: '#9ece6a',
      warningHex: '#e0af68',
      errorHex: '#f7768e',
      mutedHex: '#737aa2',
    },
  },
  catppuccin: {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    description: 'Soothing pastel dark palette with lavender and sapphire highlights',
    mode: 'dark',
    tokens: {
      bg: '#1e1e2e',
      panel: '#181825',
      panel2: '#313244',
      border: '#45475a',
      text: '#cdd6f4',
      muted: '#9399b2',
      accent: '#cba6f7',
      ok: '#a6e3a1',
      warn: '#f9e2af',
      err: '#f38ba8',
    },
    ansi: {
      primaryHex: '#cdd6f4',
      accentHex: '#cba6f7',
      successHex: '#a6e3a1',
      warningHex: '#f9e2af',
      errorHex: '#f38ba8',
      mutedHex: '#9399b2',
    },
  },
  gruvbox: {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    description: 'Warm retro groove with amber, ochre, and forest tones',
    mode: 'dark',
    tokens: {
      bg: '#282828',
      panel: '#1d2021',
      panel2: '#3c3836',
      border: '#504945',
      text: '#ebdbb2',
      muted: '#a89984',
      accent: '#fe8019',
      ok: '#b8bb26',
      warn: '#fabd2f',
      err: '#fb4934',
    },
    ansi: {
      primaryHex: '#ebdbb2',
      accentHex: '#fe8019',
      successHex: '#b8bb26',
      warningHex: '#fabd2f',
      errorHex: '#fb4934',
      mutedHex: '#a89984',
    },
  },
  'rose-pine': {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Soho vibes with muted rose, iris, and pine accents',
    mode: 'dark',
    tokens: {
      bg: '#191724',
      panel: '#1f1d2e',
      panel2: '#26233a',
      border: '#403d52',
      text: '#e0def4',
      muted: '#908caa',
      accent: '#ebbcba',
      ok: '#9ccfd8',
      warn: '#f6c177',
      err: '#eb6f92',
    },
    ansi: {
      primaryHex: '#e0def4',
      accentHex: '#ebbcba',
      successHex: '#9ccfd8',
      warningHex: '#f6c177',
      errorHex: '#eb6f92',
      mutedHex: '#908caa',
    },
  },
  nord: {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic, north-bluish clean and crisp workspace palette',
    mode: 'dark',
    tokens: {
      bg: '#2e3440',
      panel: '#242933',
      panel2: '#3b4252',
      border: '#4c566a',
      text: '#eceff4',
      muted: '#9aa7bd',
      accent: '#88c0d0',
      ok: '#a3be8c',
      warn: '#ebcb8b',
      err: '#bf616a',
    },
    ansi: {
      primaryHex: '#eceff4',
      accentHex: '#88c0d0',
      successHex: '#a3be8c',
      warningHex: '#ebcb8b',
      errorHex: '#bf616a',
      mutedHex: '#9aa7bd',
    },
  },
  kanagawa: {
    id: 'kanagawa',
    name: 'Kanagawa',
    description: 'Sumi-ink dark canvas inspired by The Great Wave off Kanagawa',
    mode: 'dark',
    tokens: {
      bg: '#1f1f28',
      panel: '#16161d',
      panel2: '#2a2a37',
      border: '#54546d',
      text: '#dcd7ba',
      muted: '#727169',
      accent: '#7e9cd8',
      ok: '#98bb6c',
      warn: '#e6c384',
      err: '#e82424',
    },
    ansi: {
      primaryHex: '#dcd7ba',
      accentHex: '#7e9cd8',
      successHex: '#98bb6c',
      warningHex: '#e6c384',
      errorHex: '#e82424',
      mutedHex: '#727169',
    },
  },
  everforest: {
    id: 'everforest',
    name: 'Everforest',
    description: 'Warm, comfortable forest-green dark palette for long sessions',
    mode: 'dark',
    tokens: {
      bg: '#2d353b',
      panel: '#232a2e',
      panel2: '#343f44',
      border: '#4f585e',
      text: '#d3c6aa',
      muted: '#859289',
      accent: '#a7c080',
      ok: '#83c092',
      warn: '#dbbc7f',
      err: '#e67e80',
    },
    ansi: {
      primaryHex: '#d3c6aa',
      accentHex: '#a7c080',
      successHex: '#83c092',
      warningHex: '#dbbc7f',
      errorHex: '#e67e80',
      mutedHex: '#859289',
    },
  },
  'wazir-dark': {
    id: 'wazir-dark',
    name: 'Wazir Dark',
    description: 'Default Wazir AI OS obsidian command center palette',
    mode: 'dark',
    tokens: {
      bg: '#0b0f17',
      panel: '#111827',
      panel2: '#1f2937',
      border: '#2d3748',
      text: '#f3f4f6',
      muted: '#9ca3af',
      accent: '#6366f1',
      ok: '#10b981',
      warn: '#f59e0b',
      err: '#ef4444',
    },
    ansi: {
      primaryHex: '#f3f4f6',
      accentHex: '#6366f1',
      successHex: '#10b981',
      warningHex: '#f59e0b',
      errorHex: '#ef4444',
      mutedHex: '#9ca3af',
    },
  },
  'wazir-light': {
    id: 'wazir-light',
    name: 'Wazir Light',
    description: 'High-contrast daylight workspace palette',
    mode: 'light',
    tokens: {
      bg: '#f8fafc',
      panel: '#ffffff',
      panel2: '#f1f5f9',
      border: '#cbd5e1',
      text: '#0f172a',
      muted: '#64748b',
      accent: '#4f46e5',
      ok: '#059669',
      warn: '#d97706',
      err: '#dc2626',
    },
    ansi: {
      primaryHex: '#0f172a',
      accentHex: '#4f46e5',
      successHex: '#059669',
      warningHex: '#d97706',
      errorHex: '#dc2626',
      mutedHex: '#64748b',
    },
  },
};

export function listWazirThemes(): WazirThemePreset[] {
  return Object.values(WAZIR_THEMES);
}

export function isWazirThemeId(id: string): id is WazirThemeId {
  return Object.prototype.hasOwnProperty.call(WAZIR_THEMES, id);
}

export function getWazirThemePreset(id?: string): WazirThemePreset {
  if (id && isWazirThemeId(id.trim().toLowerCase())) {
    return WAZIR_THEMES[id.trim().toLowerCase() as WazirThemeId];
  }
  return WAZIR_THEMES[DEFAULT_WAZIR_THEME_ID];
}

export function resolveWazirThemeFilePath(
  wazirHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = wazirHome || env.WAZIR_HOME || path.join(os.homedir(), '.wazir');
  return path.join(home, 'theme.json');
}

export function readActiveWazirTheme(options: {
  wazirHome?: string;
  env?: NodeJS.ProcessEnv;
} = {}): WazirThemePreset {
  const env = options.env ?? process.env;
  const envTheme = env.WAZIR_THEME?.trim().toLowerCase();
  if (envTheme && isWazirThemeId(envTheme)) {
    return WAZIR_THEMES[envTheme];
  }

  const filePath = resolveWazirThemeFilePath(options.wazirHome, env);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WazirThemeState>;
      if (parsed && typeof parsed.themeId === 'string' && isWazirThemeId(parsed.themeId)) {
        return WAZIR_THEMES[parsed.themeId];
      }
    }
  } catch {
    // Fall back to default theme if theme.json is unreadable or malformed
  }
  return WAZIR_THEMES[DEFAULT_WAZIR_THEME_ID];
}

export function writeActiveWazirTheme(
  themeId: string,
  options: { wazirHome?: string; env?: NodeJS.ProcessEnv } = {},
): WazirThemePreset {
  const normalized = themeId.trim().toLowerCase();
  if (!isWazirThemeId(normalized)) {
    throw new Error(
      `Unknown Wazir theme '${themeId}'. Available themes: ${Object.keys(WAZIR_THEMES).join(', ')}`,
    );
  }
  const filePath = resolveWazirThemeFilePath(options.wazirHome, options.env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: WazirThemeState = {
    themeId: normalized,
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return WAZIR_THEMES[normalized];
}

export function formatThemeCssVariables(preset: WazirThemePreset): Record<string, string> {
  return {
    '--bg': preset.tokens.bg,
    '--panel': preset.tokens.panel,
    '--panel2': preset.tokens.panel2,
    '--border': preset.tokens.border,
    '--text': preset.tokens.text,
    '--muted': preset.tokens.muted,
    '--accent': preset.tokens.accent,
    '--ok': preset.tokens.ok,
    '--warn': preset.tokens.warn,
    '--err': preset.tokens.err,
  };
}
