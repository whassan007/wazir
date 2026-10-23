/**
 * Strict parser for the YAML subset used by Goal Studio graph files.
 *
 * No YAML library is a dependency of this repository, so this module parses
 * the subset the goal-graph format needs and rejects everything else with a
 * line-numbered error instead of guessing:
 *
 * Supported: block mappings and sequences (indentation based, spaces only),
 * `- key: value` mappings inside sequences, flow sequences/mappings (which may
 * span lines), plain / single-quoted / double-quoted scalars, literal (`|`)
 * and folded (`>`) block scalars with strip/clip/keep chomping, `#` comments,
 * an optional leading `---` document marker.
 *
 * Rejected: tabs in indentation, duplicate mapping keys, anchors, aliases,
 * tags, directives, complex keys, multiple documents, inputs over the size
 * and nesting limits.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`YAML line ${line}: ${message}`);
    this.name = 'YamlParseError';
    this.line = line;
  }
}

export interface YamlParseOptions {
  /** Maximum input size in bytes (UTF-8). Default 1 MiB. */
  maxBytes?: number;
  /** Maximum nesting depth. Default 64. */
  maxDepth?: number;
}

interface SigLine {
  index: number;
  indent: number;
  content: string;
}

const RESERVED_PLAIN_START = /^[&*!%@`|>]/;

export function parseYaml(source: string, options: YamlParseOptions = {}): YamlValue {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (typeof source !== 'string') throw new YamlParseError('input must be a string', 0);
  if (Buffer.byteLength(source, 'utf8') > maxBytes) throw new YamlParseError(`input exceeds ${maxBytes} bytes`, 0);
  return new Parser(source, options.maxDepth ?? 64).parseDocument();
}

class Parser {
  private readonly lines: string[];
  private pos = 0;

  constructor(source: string, private readonly maxDepth: number) {
    this.lines = source.replace(/^﻿/, '').split(/\r?\n/);
  }

  parseDocument(): YamlValue {
    const first = this.peek();
    if (first && first.indent === 0 && /^---(\s|$)/.test(first.content)) {
      if (first.content.replace(/^---/, '').trim() !== '') throw this.error('content after document marker is not supported', first.index);
      this.pos = first.index + 1;
    }
    const start = this.peek();
    if (!start) return null;
    if (start.indent !== 0) throw this.error('top-level content must not be indented', start.index);
    const value = this.parseBlock(0, 1);
    const rest = this.peek();
    if (rest) {
      if (rest.indent === 0 && /^\.\.\.(\s|$)/.test(rest.content)) {
        this.pos = rest.index + 1;
        if (this.peek()) throw this.error('content after document end marker', this.peek()!.index);
      } else if (rest.indent === 0 && /^---(\s|$)/.test(rest.content)) {
        throw this.error('multiple documents are not supported', rest.index);
      } else {
        throw this.error('unexpected content (check indentation)', rest.index);
      }
    }
    return value;
  }

  // -- line helpers ---------------------------------------------------------

  private error(message: string, index: number): YamlParseError {
    return new YamlParseError(message, index + 1);
  }

  /** Next significant (non-blank, non-comment) line, without consuming it. */
  private peek(): SigLine | undefined {
    for (let i = this.pos; i < this.lines.length; i++) {
      const raw = this.lines[i];
      const indentMatch = /^[ \t]*/.exec(raw)![0];
      const rest = raw.slice(indentMatch.length);
      if (rest === '' || rest.startsWith('#')) continue;
      if (indentMatch.includes('\t')) throw this.error('tabs are not allowed in indentation', i);
      return { index: i, indent: indentMatch.length, content: stripComment(rest) };
    }
    return undefined;
  }

  // -- block structures ------------------------------------------------------

  /** Parses the block node whose first line is the next significant line. */
  private parseBlock(indent: number, depth: number): YamlValue {
    if (depth > this.maxDepth) throw this.error(`nesting deeper than ${this.maxDepth}`, this.pos);
    const line = this.peek()!;
    if (isSequenceItem(line.content)) return this.parseSequence(line.indent, depth);
    if (findMappingColon(line.content) >= 0) return this.parseMapping(line.indent, depth);
    // A lone scalar block (e.g. a multi-line plain scalar) is outside the subset.
    this.pos = line.index + 1;
    return this.parseInline(line.content, indent - 1, line.index, depth);
  }

  private parseMapping(indent: number, depth: number): YamlValue {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw this.error('unexpected indentation in mapping', line.index);
      if (isSequenceItem(line.content)) break; // sibling sequence belongs to the parent key
      const colon = findMappingColon(line.content);
      if (colon < 0) throw this.error(`expected "key: value", got "${truncate(line.content)}"`, line.index);
      const key = parseKey(line.content.slice(0, colon).trim(), line.index, this);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw this.error(`duplicate key "${key}"`, line.index);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw this.error(`reserved key "${key}"`, line.index);
      const rest = line.content.slice(colon + 1).trim();
      this.pos = line.index + 1;
      if (rest === '') {
        const next = this.peek();
        if (next && next.indent > indent) out[key] = this.parseBlock(next.indent, depth + 1);
        else if (next && next.indent === indent && isSequenceItem(next.content)) out[key] = this.parseSequence(indent, depth + 1);
        else out[key] = null;
      } else {
        out[key] = this.parseInline(rest, indent, line.index, depth + 1);
      }
    }
    return out;
  }

  private parseSequence(indent: number, depth: number): YamlValue {
    const out: YamlValue[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw this.error('unexpected indentation in sequence', line.index);
      if (!isSequenceItem(line.content)) break;
      const afterDash = line.content.slice(1);
      const rest = afterDash.trimStart();
      if (rest === '') {
        this.pos = line.index + 1;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.parseBlock(next.indent, depth + 1) : null);
        continue;
      }
      const childIndent = indent + 1 + (afterDash.length - rest.length);
      if (isSequenceItem(rest) || findMappingColon(rest) >= 0) {
        // Re-home the item content as if it began on its own line at childIndent.
        this.lines[line.index] = ' '.repeat(childIndent) + rest;
        out.push(this.parseBlock(childIndent, depth + 1));
      } else {
        this.pos = line.index + 1;
        out.push(this.parseInline(rest, indent, line.index, depth + 1));
      }
    }
    return out;
  }

  /** Value that starts on the same line as its key or dash. `ownerIndent` bounds block-scalar content. */
  private parseInline(text: string, ownerIndent: number, index: number, depth: number): YamlValue {
    if (text.startsWith('|') || text.startsWith('>')) return this.parseBlockScalar(text, ownerIndent, index);
    if (text.startsWith('[') || text.startsWith('{')) return this.parseFlow(text, index, depth);
    if (!text.startsWith('"') && !text.startsWith("'") && /:(\s|$)/.test(text)) {
      throw this.error(`plain scalar must not contain ": " (quote it): "${truncate(text)}"`, index);
    }
    return parseScalar(text, index, this);
  }

  private parseBlockScalar(header: string, ownerIndent: number, index: number): string {
    const m = /^([|>])([-+]?)$/.exec(header.trim());
    if (!m) throw this.error(`unsupported block scalar header "${header}"`, index);
    const folded = m[1] === '>';
    const chomp = m[2];
    const body: Array<string | null> = []; // null = blank line
    let contentIndent = -1;
    let i = index + 1;
    for (; i < this.lines.length; i++) {
      const raw = this.lines[i];
      if (raw.trim() === '') {
        body.push(null);
        continue;
      }
      const indentStr = /^[ \t]*/.exec(raw)![0];
      if (indentStr.includes('\t')) throw this.error('tabs are not allowed in indentation', i);
      const ind = indentStr.length;
      if (ind <= ownerIndent) break;
      if (contentIndent < 0) contentIndent = ind;
      if (ind < contentIndent) throw this.error('block scalar line is less indented than its first line', i);
      body.push(raw.slice(contentIndent));
    }
    // Trailing blank lines only matter for keep-chomping.
    let trailingBlank = 0;
    while (body.length && body[body.length - 1] === null) {
      body.pop();
      trailingBlank++;
    }
    this.pos = i;
    let text: string;
    if (!folded) {
      text = body.map((l) => l ?? '').join('\n');
    } else {
      text = '';
      let prevWasText = false;
      for (const l of body) {
        if (l === null) {
          text += '\n';
          prevWasText = false;
        } else if (/^\s/.test(l)) {
          // More-indented lines keep their line breaks.
          text += (text && !text.endsWith('\n') ? '\n' : '') + l + '\n';
          prevWasText = false;
        } else {
          text += (prevWasText ? ' ' : '') + l;
          prevWasText = true;
        }
      }
      text = text.replace(/\n$/, '');
    }
    if (body.length === 0) return '';
    if (chomp === '-') return text.replace(/\n+$/, '');
    if (chomp === '+') return text + '\n' + '\n'.repeat(trailingBlank);
    return text.replace(/\n+$/, '') + '\n';
  }

  private parseFlow(first: string, index: number, depth: number): YamlValue {
    let text = first;
    let end = index;
    while (!flowBalanced(text)) {
      end++;
      if (end >= this.lines.length) throw this.error('unterminated flow collection', index);
      const raw = this.lines[end];
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      text += ' ' + stripComment(trimmed);
    }
    this.pos = end + 1;
    const reader = new FlowReader(text, index, this, depth, this.maxDepth);
    const value = reader.readValue();
    reader.skipSpace();
    if (!reader.done()) throw this.error(`unexpected text after flow collection: "${truncate(reader.remaining())}"`, index);
    return value;
  }

  fail(message: string, index: number): never {
    throw this.error(message, index);
  }
}

class FlowReader {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly line: number,
    private readonly parser: Parser,
    private readonly depth: number,
    private readonly maxDepth: number,
  ) {}

  done(): boolean {
    return this.i >= this.s.length;
  }
  remaining(): string {
    return this.s.slice(this.i);
  }
  skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  readValue(level = 0): YamlValue {
    if (this.depth + level > this.maxDepth) this.parser.fail(`nesting deeper than ${this.maxDepth}`, this.line);
    this.skipSpace();
    const c = this.s[this.i];
    if (c === '[') return this.readSeq(level);
    if (c === '{') return this.readMap(level);
    return this.readScalar();
  }

  private readSeq(level: number): YamlValue[] {
    this.i++;
    const out: YamlValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      out.push(this.readValue(level + 1));
      this.skipSpace();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c === ']') continue;
      else this.parser.fail(`expected "," or "]" in flow sequence`, this.line);
    }
  }

  private readMap(level: number): { [key: string]: YamlValue } {
    this.i++;
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      this.skipSpace();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const keyValue = this.readScalar(true);
      if (typeof keyValue !== 'string' && typeof keyValue !== 'number' && typeof keyValue !== 'boolean') this.parser.fail('flow mapping keys must be scalars', this.line);
      const key = String(keyValue);
      if (Object.prototype.hasOwnProperty.call(out, key)) this.parser.fail(`duplicate key "${key}"`, this.line);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') this.parser.fail(`reserved key "${key}"`, this.line);
      this.skipSpace();
      if (this.s[this.i] !== ':') this.parser.fail('expected ":" in flow mapping', this.line);
      this.i++;
      out[key] = this.readValue(level + 1);
      this.skipSpace();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c === '}') continue;
      else this.parser.fail('expected "," or "}" in flow mapping', this.line);
    }
  }

  private readScalar(isKey = false): YamlValue {
    this.skipSpace();
    const c = this.s[this.i];
    if (c === '"' || c === "'") {
      const end = findQuoteEnd(this.s, this.i);
      if (end < 0) this.parser.fail('unterminated quoted string', this.line);
      const raw = this.s.slice(this.i, end + 1);
      this.i = end + 1;
      return parseQuoted(raw, this.line, this.parser);
    }
    let j = this.i;
    while (j < this.s.length) {
      const ch = this.s[j];
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
      if (isKey && ch === ':') break;
      if (ch === ':' && (j + 1 >= this.s.length || /[\s,\]}]/.test(this.s[j + 1]))) this.parser.fail('nested "key: value" inside a flow sequence is not supported', this.line);
      j++;
    }
    const raw = this.s.slice(this.i, j).trim();
    this.i = j;
    if (raw === '') this.parser.fail('empty flow entry', this.line);
    return parseScalar(raw, this.line, this.parser);
  }
}

// -- lexical helpers ---------------------------------------------------------

function isSequenceItem(content: string): boolean {
  return content === '-' || content.startsWith('- ');
}

/** Index of the `:` separating a block mapping key from its value, or -1. */
function findMappingColon(content: string): number {
  if (content.startsWith('[') || content.startsWith('{') || content.startsWith('|') || content.startsWith('>')) return -1;
  let i = 0;
  if (content.startsWith('"') || content.startsWith("'")) {
    const end = findQuoteEnd(content, 0);
    if (end < 0) return -1;
    i = end + 1;
    const after = content.slice(i);
    return /^\s*:(\s|$)/.test(after) ? i + after.indexOf(':') : -1;
  }
  for (; i < content.length; i++) {
    if (content[i] === ':' && (i + 1 === content.length || content[i + 1] === ' ')) return i;
  }
  return -1;
}

function findQuoteEnd(s: string, start: number): number {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Removes a trailing `# comment` that is outside quotes. */
function stripComment(content: string): string {
  let tokenStart = true;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if ((c === '"' || c === "'") && tokenStart) {
      const end = findQuoteEnd(content, i);
      if (end < 0) return content.trimEnd();
      i = end;
      tokenStart = false;
      continue;
    }
    if (c === '#' && (i === 0 || content[i - 1] === ' ')) return content.slice(0, i).trimEnd();
    tokenStart = c === ' ' || c === '[' || c === '{' || c === ',' || c === ':' || c === '-';
  }
  return content.trimEnd();
}

function parseKey(raw: string, index: number, parser: Parser): string {
  if (raw === '') parser.fail('empty mapping key', index);
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const v = parseQuoted(raw, index, parser);
    return v;
  }
  if (raw.startsWith('?')) parser.fail('complex mapping keys are not supported', index);
  if (RESERVED_PLAIN_START.test(raw) || raw.startsWith('[') || raw.startsWith('{')) parser.fail(`unsupported key syntax "${truncate(raw)}"`, index);
  return raw;
}

function parseQuoted(raw: string, index: number, parser: Parser): string {
  const q = raw[0];
  if (raw.length < 2 || raw[raw.length - 1] !== q || findQuoteEnd(raw, 0) !== raw.length - 1) parser.fail(`malformed quoted string ${truncate(raw)}`, index);
  const body = raw.slice(1, -1);
  if (q === "'") return body.replace(/''/g, "'");
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = body[++i];
    switch (e) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case ' ': out += ' '; break;
      case 'u': {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) parser.fail('invalid \\u escape', index);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        parser.fail(`unsupported escape "\\${e ?? ''}"`, index);
    }
  }
  return out;
}

function parseScalar(raw: string, index: number, parser: Parser): YamlValue {
  const text = raw.trim();
  if (text.startsWith('"') || text.startsWith("'")) return parseQuoted(text, index, parser);
  if (RESERVED_PLAIN_START.test(text)) parser.fail(`unsupported YAML feature (anchor, alias, tag or directive) in "${truncate(text)}"`, index);
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if (/^[-+]?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text) || /^\.(nan|NaN|NAN)$/.test(text)) parser.fail('non-finite numbers are not supported', index);
  return text;
}

function flowBalanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = findQuoteEnd(text, i);
      if (end < 0) return false;
      i = end;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

function truncate(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
