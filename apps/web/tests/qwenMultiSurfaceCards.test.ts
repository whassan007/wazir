import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { DASHBOARD_HTML_BASE64 } from '../../cli/src/dashboardHtml.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const INDEX_HTML_PATH = join(REPO_ROOT, 'apps', 'web', 'public', 'index.html');

describe('Qwen Multi-Surface Web Dashboard Cards (A073)', () => {
  const expectedHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
  const decodedHtml = Buffer.from(DASHBOARD_HTML_BASE64, 'base64').toString('utf8');

  it('keeps DASHBOARD_HTML_BASE64 synchronized byte-for-byte with apps/web/public/index.html', () => {
    expect(decodedHtml).toBe(expectedHtml);
  });

  it('parses the embedded inline dashboard JavaScript cleanly without syntax errors', () => {
    const scriptMatches = [...expectedHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scriptMatches.length).toBeGreaterThanOrEqual(1);
    for (const [, jsSource] of scriptMatches) {
      expect(() => new vm.Script(jsSource)).not.toThrow();
    }
  });

  it('includes structured timeline card renderers for tool.batch_*, agent.thinking, search.composed, and multi_edit', () => {
    expect(expectedHtml).toContain('data-testid="tool-batch-card"');
    expect(expectedHtml).toContain('data-testid="agent-thinking-card"');
    expect(expectedHtml).toContain('data-testid="compose-trajectory-card"');
    expect(expectedHtml).toContain('data-testid="multi-edit-badge"');
    expect(expectedHtml).toContain('top.tool === \'multi_edit\'');
    expect(expectedHtml).toContain('hunks]');
  });
});
