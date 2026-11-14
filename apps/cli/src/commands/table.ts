// Dependency-free so that commands registered at startup (e.g. goalCommands)
// can render tables without loading @wazir/core via formatters.ts.
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i] ?? 0)).join('  ');
  const out = [line(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of rows) {
    out.push(line(row));
  }
  return out.join('\n');
}
