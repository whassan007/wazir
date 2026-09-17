const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

type Color = keyof typeof codes;

const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(text: string, color: Color): string {
  if (!enabled) return text;
  return `${codes[color]}${text}${codes.reset}`;
}

export const color = {
  bold: (t: string) => paint(t, 'bold'),
  red: (t: string) => paint(t, 'red'),
  green: (t: string) => paint(t, 'green'),
  cyan: (t: string) => paint(t, 'cyan'),
  gray: (t: string) => paint(t, 'gray'),
};
