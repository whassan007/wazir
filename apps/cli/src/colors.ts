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

const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

export function paint(text: string, color: Color): string {
  if (!enabled) return text;
  return `${codes[color]}${text}${codes.reset}`;
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
