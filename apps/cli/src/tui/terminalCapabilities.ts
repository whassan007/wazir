export interface TerminalCapabilities {
  isTTY: boolean;
  columns: number;
  rows: number;
  color: boolean;
  unicode: boolean;
  osc52OptIn: boolean;
  distinguishShiftEnter: boolean;
  distinguishCtrlEnter: boolean;
}

export function detectTerminalCapabilities(output: NodeJS.WritableStream, env: NodeJS.ProcessEnv = process.env): TerminalCapabilities {
  const terminal = output as NodeJS.WriteStream;
  const isTTY = Boolean(terminal.isTTY);
  const term = env.TERM ?? '';
  return {
    isTTY,
    columns: terminal.columns && terminal.columns > 0 ? terminal.columns : 80,
    rows: terminal.rows && terminal.rows > 0 ? terminal.rows : 24,
    color: isTTY && !('NO_COLOR' in env) && term !== 'dumb',
    unicode: env.WAZIR_UNICODE !== '0' && term !== 'dumb',
    // Merely report explicit opt-in. This release never writes clipboard data.
    osc52OptIn: env.WAZIR_OSC52 === '1',
    // Modifier reporting is terminal-dependent and cannot be inferred safely from
    // TERM alone. Keep universal fallbacks available in the composer.
    distinguishShiftEnter: false,
    distinguishCtrlEnter: Boolean(env.KITTY_WINDOW_ID || env.WT_SESSION || env.TERM_PROGRAM === 'WezTerm'),
  };
}
