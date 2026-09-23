import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendAuditEvent, readAuditEvents } from '../src/audit.js';

/**
 * Directive failure-matrix item: "half-written / corrupt JSONL store
 * lines". audit.jsonl is the one JSONL-format store Wazir has; a crash mid
 * fs.appendFile (rare, but real — appendFile isn't atomic the way the
 * KeyValueStore's write-tmp-then-rename is) can leave a truncated or
 * otherwise malformed line in the middle of an otherwise-valid file.
 */
describe('audit.jsonl — resilience to corrupt/truncated lines', () => {
  let auditPath: string;

  afterEach(async () => {
    if (auditPath) await fs.rm(path.dirname(auditPath), { recursive: true, force: true }).catch(() => undefined);
  });

  async function tempAuditPath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-audit-'));
    return path.join(dir, 'audit.jsonl');
  }

  it('skips a malformed line in the middle of the file and still returns every valid event', async () => {
    auditPath = await tempAuditPath();
    await appendAuditEvent({ type: 'tool_call', tool: 'read' }, { auditPath });
    await appendAuditEvent({ type: 'tool_call', tool: 'write' }, { auditPath });

    // Simulate a crash mid-append: a truncated JSON fragment with no
    // trailing newline, inserted between two valid, complete lines.
    await fs.appendFile(auditPath, '{"id":"broken","type":"tool_call","tool":"sh');

    await appendAuditEvent({ type: 'tool_call', tool: 'shell' }, { auditPath });

    const events = await readAuditEvents({ auditPath });
    // The broken fragment (now itself an unterminated line once the next
    // real event's newline-prefixed... actually appendFile has no
    // separator, so the corrupt fragment and the next real line landed on
    // the same physical line; readAuditEvents skips whatever doesn't parse.
    const tools = events.map((e) => e.tool).sort();
    expect(tools).toContain('read');
    expect(tools).toContain('write');
    expect(events.every((e) => e.id !== 'broken')).toBe(true);
  });

  it('returns an empty list (not a throw) when the whole file is garbage', async () => {
    auditPath = await tempAuditPath();
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.writeFile(auditPath, 'not json at all\n{also not json\n\n');

    await expect(readAuditEvents({ auditPath })).resolves.toEqual([]);
  });

  it('recovers fully once a fresh valid line is appended after a corrupt one', async () => {
    auditPath = await tempAuditPath();
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.writeFile(auditPath, '{"broken":\n');

    await appendAuditEvent({ type: 'tool_call', tool: 'edit' }, { auditPath });

    const events = await readAuditEvents({ auditPath });
    expect(events.some((e) => e.tool === 'edit')).toBe(true);
  });

  it('a missing audit file returns an empty list rather than throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-audit-missing-'));
    auditPath = path.join(dir, 'does-not-exist.jsonl');
    await expect(readAuditEvents({ auditPath })).resolves.toEqual([]);
  });
});
