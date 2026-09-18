import { describe, it, expect } from 'vitest';
import { generateId, redactSecrets, stripTerminalEscapes, sanitizeUntrustedOutput } from '../src/index.js';

describe('F-23: terminal escape stripping', () => {
  it('removes CSI, OSC and C1 sequences but keeps text and newlines', () => {
    expect(stripTerminalEscapes('\x1b[31mred\x1b[0m\nnext')).toBe('red\nnext');
    expect(stripTerminalEscapes('\x1b]0;evil title\x07hello')).toBe('hello');
    expect(stripTerminalEscapes('\x1b]52;c;aGVsbG8=\x1b\\clip')).toBe('clip'); // OSC 52 clipboard write
    expect(stripTerminalEscapes('\x1b[2J\x1b[H\x1b[?25lclear')).toBe('clear');
    expect(stripTerminalEscapes('a\tb\r\nc')).toBe('a\tb\r\nc');
    expect(stripTerminalEscapes('\x9b31mx')).toBe('x');
  });
});

describe('F-13: secret redaction', () => {
  it('redacts KEY=value pairs with credential-shaped names', () => {
    const out = redactSecrets('WAZIR_DATABASE_URL=postgres://u:p@h/db\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\nPATH=/usr/bin\nGITHUB_TOKEN="ghp_abcdefghijklmnopqrstuv"');
    expect(out).toContain('WAZIR_DATABASE_URL=[REDACTED]');
    expect(out).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(out).toContain('GITHUB_TOKEN="[REDACTED]"');
    expect(out).toContain('PATH=/usr/bin');
    expect(out).not.toContain('sk-abc');
    expect(out).not.toContain('ghp_');
  });

  it('redacts bearer headers, URL credentials, PEM blocks and known token shapes', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactSecrets('postgres://wazir:hunter2@db:5432/x')).toBe('postgres://wazir:[REDACTED]@db:5432/x');
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).not.toContain('MIIE');
    expect(redactSecrets('key AKIAIOSFODNN7EXAMPLE here')).toBe('key [REDACTED] here');
  });

  it('leaves ordinary output untouched', () => {
    const text = 'src/index.ts:12: const token = parse(x);\ntotal 3 files\nauth.ts';
    expect(redactSecrets(text)).toBe(text);
  });

  it('sanitizeUntrustedOutput applies both passes', () => {
    expect(sanitizeUntrustedOutput('\x1b[31mSECRET_TOKEN=abc123\x1b[0m')).toBe('SECRET_TOKEN=[REDACTED]');
  });
});

describe('F-17: generateId', () => {
  it('produces 128-bit random hex ids without a timestamp prefix', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId('req-')));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^req-[0-9a-f]{32}$/);
    const [a, b] = [...ids];
    expect(a.slice(4, 12)).not.toBe(b.slice(4, 12));
  });
});

describe('second-pass review S-7: ini/yaml-style secrets with unquoted values', () => {
  it('redacts snake/kebab-case secret keys without quotes', () => {
    expect(redactSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG')).toBe('aws_secret_access_key = [REDACTED]');
    expect(redactSecrets('db_password: hunter2')).toBe('db_password: [REDACTED]');
    expect(redactSecrets('api-key: abcdefgh12345678')).toBe('api-key: [REDACTED]');
    expect(redactSecrets('client_secret=zzzz1234')).toBe('client_secret=[REDACTED]');
  });
  it('still leaves code and prose alone', () => {
    for (const text of ['const token = parse(x)', 'password = input()', 'the secret: nobody knows', 'max_tokens: 4096', 'tokenizer: gpt2']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});
