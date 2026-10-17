import { detectTerminalCapabilities } from './terminalCapabilities.js';

export type ClipboardResult = { copied: true } | { copied: false; reason: string };

/** OSC52 is only used after an explicit keyboard copy action and an explicit opt-in. */
export class ClipboardController {
  constructor(private readonly output: NodeJS.WritableStream, private readonly env: NodeJS.ProcessEnv = process.env) {}

  copy(text: string): ClipboardResult {
    const capabilities = detectTerminalCapabilities(this.output, this.env);
    if (!capabilities.isTTY || !capabilities.osc52OptIn || !isOsc52Terminal(this.env)) {
      return { copied: false, reason: 'OSC52 clipboard is disabled or unsupported; use the terminal native selection.' };
    }
    if (Buffer.byteLength(text, 'utf8') > 100_000) return { copied: false, reason: 'Selection exceeds the 100 KB clipboard limit.' };
    if (containsSecret(text)) return { copied: false, reason: 'Selection looks like it contains a credential; it was not copied.' };
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    this.output.write(`\x1b]52;c;${encoded}\x07`);
    return { copied: true };
  }
}

function isOsc52Terminal(env: NodeJS.ProcessEnv): boolean {
  const term = env.TERM ?? '';
  const program = env.TERM_PROGRAM ?? '';
  return /xterm|screen|tmux|kitty|wezterm/i.test(term) || /iTerm|WezTerm|vscode|WindowsTerminal|Apple_Terminal/i.test(program);
}

function containsSecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text)
    || /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client_secret)\s*[:=]\s*[^\s,;]+/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(text);
}
