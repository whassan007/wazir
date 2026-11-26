import { readActiveWazirTheme, type WazirThemePreset } from '@wazir/core';

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

type Color = keyof typeof codes;

export function getActiveCliTheme(): WazirThemePreset {
  return readActiveWazirTheme();
}

export function hexToAnsiFg(hex: string): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return '';
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return '';
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function isColorEnabled(): boolean {
  if (process.argv.includes('--no-color')) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return process.stdout?.isTTY === true;
}

export function paint(text: string, color: Color): string {
  if (!isColorEnabled()) return text;
  return `${codes[color]}${text}${codes.reset}`;
}

export function paintHex(text: string, hex: string): string {
  if (!isColorEnabled()) return text;
  const fg = hexToAnsiFg(hex);
  return fg ? `${fg}${text}${codes.reset}` : text;
}

export const color = {
  bold: (t: string) => paint(t, 'bold'),
  dim: (t: string) => paint(t, 'dim'),
  red: (t: string) => paint(t, 'red'),
  green: (t: string) => paint(t, 'green'),
  yellow: (t: string) => paint(t, 'yellow'),
  blue: (t: string) => paint(t, 'blue'),
  magenta: (t: string) => paint(t, 'magenta'),
  cyan: (t: string) => paint(t, 'cyan'),
  gray: (t: string) => paint(t, 'gray'),
};
