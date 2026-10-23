/**
 * Minimal YAML subset parser used only by the Goal Studio test fakes and
 * benchmarks. The repository has no YAML dependency, and the integration
 * suites must not add one, so this covers exactly what the goal-graph
 * fixtures use: block mappings, block sequences (including sequences of
 * mappings), single-/multi-line flow sequences of scalars, folded (`>-`) and
 * literal (`|-`) block scalars, quoted and plain scalars, and comments.
 *
 * JSON documents are accepted too (JSON is valid YAML flow style).
 * This is NOT a production parser: the real importer belongs to workstream 02.
 */

interface Line {
  indent: number;
  text: string;
  lineNo: number;
}

export class YamlLiteError extends Error {}

function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
  }
  return raw;
}

function parseScalar(token: string): unknown {
  const t = token.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return JSON.parse(t);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('[')) return parseFlowSequence(t);
  if (t === '{}') return {};
  return t;
}

function parseFlowSequence(t: string): unknown[] {
  if (!t.endsWith(']')) throw new YamlLiteError(`unterminated flow sequence: ${t}`);
  const body = t.slice(1, -1).trim();
  if (body === '') return [];
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  let inQuote: string | null = null;
  for (const c of body) {
    if (inQuote) {
      cur += c;
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") inQuote = c;
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === ',' && depth === 0) {
      items.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') items.push(cur);
  return items.map((i) => parseScalar(i));
}

function splitKey(text: string): { key: string; rest: string } | undefined {
  // key: value — key is plain or quoted, colon followed by space or EOL
  const m = /^("[^"]*"|'[^']*'|[^\s:'"][^:]*?)\s*:(\s+|$)(.*)$/.exec(text);
  if (!m) return undefined;
  const rawKey = m[1]!;
  const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? String(parseScalar(rawKey)) : rawKey;
  return { key, rest: m[3] ?? '' };
}

export function parseYamlLite(source: string): unknown {
  const trimmed = source.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to YAML parsing
    }
  }
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');
  const lines: Line[] = [];
  // Keep raw lines for block scalars; pre-tokenize the rest lazily.
  let i = 0;
  const all = rawLines.map((raw, idx) => ({ raw, idx }));

  function significant(raw: string): Line | undefined {
    const noComment = stripComment(raw);
    if (noComment.trim() === '') return undefined;
    if (/^\t/.test(raw)) throw new YamlLiteError('tabs are not allowed for indentation');
    const indent = noComment.length - noComment.trimStart().length;
    return { indent, text: noComment.trim(), lineNo: 0 };
  }

  // Tokenize, folding block scalars and multi-line flow sequences into one logical line.
  while (i < all.length) {
    const { raw, idx } = all[i]!;
    const line = significant(raw);
    if (!line) {
      i++;
      continue;
    }
    line.lineNo = idx + 1;
    const blockMatch = /(^|:\s+|^-\s+)([>|])([-+]?)$/.exec(line.text);
    if (blockMatch) {
      const style = blockMatch[2]!;
      const chomp = blockMatch[3]!;
      const parts: string[] = [];
      let j = i + 1;
      let blockIndent = -1;
      while (j < all.length) {
        const r = all[j]!.raw;
        if (r.trim() === '') {
          parts.push('');
          j++;
          continue;
        }
        const ind = r.length - r.trimStart().length;
        if (blockIndent < 0) blockIndent = ind;
        if (ind < blockIndent || ind <= line.indent) break;
        parts.push(r.slice(blockIndent));
        j++;
      }
      while (parts.length && parts[parts.length - 1] === '') parts.pop();
      let value = style === '|' ? parts.join('\n') : parts.join(' ').replace(/\s+/g, ' ').trim();
      if (chomp !== '-') value += '\n';
      const prefix = line.text.slice(0, line.text.length - (style + chomp).length);
      lines.push({ indent: line.indent, text: `${prefix}${JSON.stringify(value)}`, lineNo: line.lineNo });
      i = j;
      continue;
    }
    // Multi-line flow sequence: join until brackets balance.
    let text = line.text;
    const open = (s: string) => (s.match(/\[/g) ?? []).length - (s.match(/\]/g) ?? []).length;
    let balance = open(text);
    let j = i + 1;
    while (balance > 0 && j < all.length) {
      const cont = significant(all[j]!.raw);
      j++;
      if (!cont) continue;
      text += ` ${cont.text}`;
      balance = open(text);
    }
    if (balance > 0) throw new YamlLiteError(`unterminated flow sequence at line ${line.lineNo}`);
    lines.push({ indent: line.indent, text, lineNo: line.lineNo });
    i = j;
  }

  let pos = 0;

  function parseNode(indent: number): unknown {
    const line = lines[pos];
    if (!line || line.indent < indent) return null;
    if (line.text.startsWith('- ') || line.text === '-') return parseSequence(line.indent);
    return parseMapping(line.indent);
  }

  function parseSequence(indent: number): unknown[] {
    const out: unknown[] = [];
    while (pos < lines.length) {
      const line = lines[pos]!;
      if (line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) {
        if (line.indent > indent) throw new YamlLiteError(`bad indentation at line ${line.lineNo}`);
        break;
      }
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      if (rest === '') {
        pos++;
        out.push(parseNode(indent + 1));
        continue;
      }
      const kv = splitKey(rest);
      if (kv && !rest.startsWith('"') && !rest.startsWith("'") && !rest.startsWith('[')) {
        // Sequence of mappings: re-enter as a virtual mapping line at a deeper indent.
        const childIndent = indent + 2;
        lines[pos] = { indent: childIndent, text: rest, lineNo: line.lineNo };
        out.push(parseMapping(childIndent));
        continue;
      }
      pos++;
      out.push(parseScalar(rest));
    }
    return out;
  }

  function parseMapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (pos < lines.length) {
      const line = lines[pos]!;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlLiteError(`bad indentation at line ${line.lineNo}: ${line.text}`);
      if (line.text.startsWith('- ')) break;
      const kv = splitKey(line.text);
      if (!kv) throw new YamlLiteError(`expected "key: value" at line ${line.lineNo}: ${line.text}`);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlLiteError(`duplicate key "${kv.key}" at line ${line.lineNo}`);
      pos++;
      if (kv.rest.trim() === '') {
        const next = lines[pos];
        if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) {
          out[kv.key] = parseNode(next.indent);
        } else {
          out[kv.key] = null;
        }
      } else {
        out[kv.key] = parseScalar(kv.rest);
      }
    }
    return out;
  }

  if (lines.length === 0) return null;
  const result = parseNode(lines[0]!.indent);
  if (pos < lines.length) throw new YamlLiteError(`unexpected content at line ${lines[pos]!.lineNo}: ${lines[pos]!.text}`);
  return result;
}
