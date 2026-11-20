/**
 * Wazir OS Design System Tokens (v1.0.0)
 * Derived from authoritative brand assets:
 *   - assets/brand/brand.json
 *   - assets/brand/Wazir_CVI_Guidelines.pdf
 * Never mutates authoritative brand assets.
 */

export const DESIGN_SYSTEM_VERSION = '1.0.0' as const;

export const BRAND_AUTHORITY = {
  name: 'Wazir',
  subtitle: 'A Local AI Fleet Counselor',
  tagline: 'Autonomous Agent Orchestration',
  minimumDigitalEmblemSizePx: 96,
  minimumPrintEmblemSizeMm: 25,
  clearSpaceRatio: 0.25,
  colors: {
    darkAbyss: '#0f131a',
    electricBlue: '#38bdf8',
    metallicSilver: '#94a3b8',
    dataGreen: '#22c55e',
    iceWhite: '#f8fafc',
    cyanCoreGlow: '#67e8f9',
    shieldInteriorNavy: '#162032',
    shieldLowerSteel: '#2f4469',
  },
} as const;

export type ThemeVariant = 'dark' | 'light' | 'dark-hc' | 'light-hc';

export interface SemanticPalette {
  variant: ThemeVariant;
  isDark: boolean;
  isHighContrast: boolean;
  bgCanvas: string;
  bgSurface: string;
  bgSurfaceElevated: string;
  bgSurfaceHover: string;
  bgMenuBar: string;
  bgDock: string;
  bgDialog: string;
  bgNotification: string;
  bgSpotlight: string;
  bgTerminal: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;
  borderDefault: string;
  borderSubtle: string;
  borderFocus: string;
  accentPrimary: string;
  accentHover: string;
  accentGlow: string;
  statusOk: string;
  statusWarn: string;
  statusError: string;
  selectionBg: string;
  selectionText: string;
  windowClose: string;
  windowMinimize: string;
  windowMaximize: string;
}

export const THEME_PALETTES: Record<ThemeVariant, SemanticPalette> = {
  dark: {
    variant: 'dark',
    isDark: true,
    isHighContrast: false,
    bgCanvas: BRAND_AUTHORITY.colors.darkAbyss,
    bgSurface: BRAND_AUTHORITY.colors.shieldInteriorNavy,
    bgSurfaceElevated: '#1b283d',
    bgSurfaceHover: '#22324d',
    bgMenuBar: 'rgba(15, 19, 26, 0.88)',
    bgDock: 'rgba(22, 32, 50, 0.84)',
    bgDialog: BRAND_AUTHORITY.colors.shieldInteriorNavy,
    bgNotification: 'rgba(22, 32, 50, 0.96)',
    bgSpotlight: 'rgba(15, 19, 26, 0.94)',
    bgTerminal: BRAND_AUTHORITY.colors.darkAbyss,
    textPrimary: BRAND_AUTHORITY.colors.iceWhite,
    textSecondary: '#cbd5e1',
    textMuted: BRAND_AUTHORITY.colors.metallicSilver,
    textOnAccent: BRAND_AUTHORITY.colors.darkAbyss,
    borderDefault: BRAND_AUTHORITY.colors.shieldLowerSteel,
    borderSubtle: '#1e293b',
    borderFocus: BRAND_AUTHORITY.colors.electricBlue,
    accentPrimary: BRAND_AUTHORITY.colors.electricBlue,
    accentHover: BRAND_AUTHORITY.colors.cyanCoreGlow,
    accentGlow: BRAND_AUTHORITY.colors.cyanCoreGlow,
    statusOk: BRAND_AUTHORITY.colors.dataGreen,
    statusWarn: '#eab308',
    statusError: '#ef4444',
    selectionBg: '#1d4ed8',
    selectionText: BRAND_AUTHORITY.colors.iceWhite,
    windowClose: '#ef4444',
    windowMinimize: '#eab308',
    windowMaximize: BRAND_AUTHORITY.colors.dataGreen,
  },
  light: {
    variant: 'light',
    isDark: false,
    isHighContrast: false,
    bgCanvas: BRAND_AUTHORITY.colors.iceWhite,
    bgSurface: '#ffffff',
    bgSurfaceElevated: '#f1f5f9',
    bgSurfaceHover: '#e2e8f0',
    bgMenuBar: 'rgba(248, 250, 252, 0.88)',
    bgDock: 'rgba(255, 255, 255, 0.84)',
    bgDialog: '#ffffff',
    bgNotification: 'rgba(255, 255, 255, 0.96)',
    bgSpotlight: 'rgba(248, 250, 252, 0.95)',
    bgTerminal: BRAND_AUTHORITY.colors.darkAbyss,
    textPrimary: BRAND_AUTHORITY.colors.darkAbyss,
    textSecondary: '#334155',
    textMuted: '#475569',
    textOnAccent: '#ffffff',
    borderDefault: '#cbd5e1',
    borderSubtle: '#e2e8f0',
    borderFocus: '#0284c7',
    accentPrimary: '#0284c7',
    accentHover: '#0369a1',
    accentGlow: BRAND_AUTHORITY.colors.electricBlue,
    statusOk: '#15803d',
    statusWarn: '#a16207',
    statusError: '#b91c1c',
    selectionBg: '#0284c7',
    selectionText: '#ffffff',
    windowClose: '#dc2626',
    windowMinimize: '#ca8a04',
    windowMaximize: '#16a34a',
  },
  'dark-hc': {
    variant: 'dark-hc',
    isDark: true,
    isHighContrast: true,
    bgCanvas: '#07090d',
    bgSurface: BRAND_AUTHORITY.colors.darkAbyss,
    bgSurfaceElevated: BRAND_AUTHORITY.colors.shieldInteriorNavy,
    bgSurfaceHover: '#23334f',
    bgMenuBar: '#07090d',
    bgDock: BRAND_AUTHORITY.colors.darkAbyss,
    bgDialog: BRAND_AUTHORITY.colors.darkAbyss,
    bgNotification: BRAND_AUTHORITY.colors.darkAbyss,
    bgSpotlight: '#07090d',
    bgTerminal: '#07090d',
    textPrimary: '#ffffff',
    textSecondary: BRAND_AUTHORITY.colors.iceWhite,
    textMuted: '#cbd5e1',
    textOnAccent: '#07090d',
    borderDefault: BRAND_AUTHORITY.colors.electricBlue,
    borderSubtle: BRAND_AUTHORITY.colors.metallicSilver,
    borderFocus: BRAND_AUTHORITY.colors.cyanCoreGlow,
    accentPrimary: BRAND_AUTHORITY.colors.cyanCoreGlow,
    accentHover: '#a5f3fc',
    accentGlow: BRAND_AUTHORITY.colors.cyanCoreGlow,
    statusOk: '#4ade80',
    statusWarn: '#facc15',
    statusError: '#f87171',
    selectionBg: BRAND_AUTHORITY.colors.electricBlue,
    selectionText: '#07090d',
    windowClose: '#f87171',
    windowMinimize: '#facc15',
    windowMaximize: '#4ade80',
  },
  'light-hc': {
    variant: 'light-hc',
    isDark: false,
    isHighContrast: true,
    bgCanvas: '#ffffff',
    bgSurface: BRAND_AUTHORITY.colors.iceWhite,
    bgSurfaceElevated: '#e2e8f0',
    bgSurfaceHover: '#cbd5e1',
    bgMenuBar: '#ffffff',
    bgDock: '#ffffff',
    bgDialog: '#ffffff',
    bgNotification: '#ffffff',
    bgSpotlight: '#ffffff',
    bgTerminal: BRAND_AUTHORITY.colors.darkAbyss,
    textPrimary: '#000000',
    textSecondary: BRAND_AUTHORITY.colors.darkAbyss,
    textMuted: '#1e293b',
    textOnAccent: '#ffffff',
    borderDefault: BRAND_AUTHORITY.colors.darkAbyss,
    borderSubtle: '#334155',
    borderFocus: '#0369a1',
    accentPrimary: '#0369a1',
    accentHover: '#075985',
    accentGlow: '#0284c7',
    statusOk: '#166534',
    statusWarn: '#854d0e',
    statusError: '#991b1b',
    selectionBg: '#0369a1',
    selectionText: '#ffffff',
    windowClose: '#991b1b',
    windowMinimize: '#854d0e',
    windowMaximize: '#166534',
  },
};

export const SPACING_TOKENS = {
  baseUnitPx: 4,
  xxs: '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
  menuBarHeightPx: 28,
  dockHeightPx: 54,
  dockIconSizePx: 40,
  dockPaddingPx: 8,
  windowTitleBarHeightPx: 32,
  spotlightWidthPx: 680,
} as const;

export const RADIUS_TOKENS = {
  none: '0px',
  sm: '6px',
  md: '10px',
  lg: '14px',
  dock: '18px',
  pill: '9999px',
} as const;

export const TYPOGRAPHY_TOKENS = {
  display: {
    family: 'Archon Bold, SF Pro Display, Inter, system-ui, sans-serif',
    weight: 700,
  },
  ui: {
    family: 'Nexus Light, Inter, -apple-system, BlinkMacSystemFont, sans-serif',
    weights: [400, 500] as const,
  },
  mono: {
    family: 'JetBrains Mono, Fira Code, ui-monospace, SFMono-Regular, monospace',
    weights: [400, 700] as const,
  },
  sizes: {
    xs: '11px',
    sm: '12px',
    base: '13px',
    md: '14px',
    lg: '16px',
    xl: '20px',
    display: '28px',
  },
} as const;

export const MOTION_TOKENS = {
  standard: {
    fastMs: 120,
    normalMs: 180,
    slowMs: 260,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  reduced: {
    fastMs: 0,
    normalMs: 0,
    slowMs: 0,
    easing: 'linear',
  },
} as const;

/** Parses #rrggbb hex string into [r, g, b] 0..255 tuple. */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

/** Computes WCAG 2.1 relative luminance for an sRGB #rrggbb color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Computes WCAG 2.1 contrast ratio between two #rrggbb colors. */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
