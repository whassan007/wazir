import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentConfigurationDiscovery, agentExecutableCandidates, resolveAgentExecutables } from '../src/configurationDiscovery.js';

describe('passive native configuration discovery', () => {
  it('constructs Windows PATH/PATHEXT candidates with quoted spaces, Unicode and mixed-case environment names', () => {
    expect(agentExecutableCandidates('codex', { Path: '"C:\\Program Files\\工具";.;', Pathext: '.EXE;.CMD' }, 'win32')).toEqual(['C:\\Program Files\\工具\\codex.EXE', 'C:\\Program Files\\工具\\codex.CMD']);
    expect(agentExecutableCandidates('claude', { PATH: '/opt/homebrew/bin:/usr/local/bin' }, 'darwin')).toEqual(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
  });
  let dir: string;
  let home: string;
  let project: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-discovery-'));
    home = path.join(dir, 'user ü'); project = path.join(dir, 'project with spaces');
    for (const p of [home, project, path.join(home, '.codex'), path.join(project, '.codex'), path.join(project, '.git')]) mkdirSync(p, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const service = new AgentConfigurationDiscovery();
  const run = (trustedProject = false, env: NodeJS.ProcessEnv = { PATH: '' }) => service.discover({ home, cwd: project, trustedProject, env });

  it('withholds untrusted project contents and exposes declared model provenance after authorization', () => {
    writeFileSync(path.join(home, '.codex/config.toml'), 'model = "global-model"');
    writeFileSync(path.join(project, '.codex/config.toml'), 'model = "project-model"');
    expect(run()[0].model.value).toBe('global-model');
    expect(run()[0].sources.find(s => s.scope === 'project')?.settings).toBeUndefined();
    expect(run(true)[0].model).toMatchObject({ value: 'project-model', status: 'CONFIGURED', source: path.join(project, '.codex/config.toml') });
    expect(run(true)[0].diagnostics.join(' ')).toContain('differ');
  });

  it('does not expose secrets, instructions, hooks or malformed parser excerpts', () => {
    writeFileSync(path.join(home, '.codex/config.toml'), 'model="safe-model"\napi_key="SECRET_SENTINEL"\nnotify=["SECRET_SENTINEL"]');
    writeFileSync(path.join(home, '.codex/AGENTS.md'), 'SECRET_SENTINEL');
    writeFileSync(path.join(home, '.codex/auth.json'), '{invalid SECRET_SENTINEL');
    expect(JSON.stringify(run())).not.toContain('SECRET_SENTINEL');
    writeFileSync(path.join(home, '.codex/config.toml'), 'model = SECRET_SENTINEL');
    const result = run();
    expect(result[0].sources.find(s => s.kind === 'settings')?.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');
  });

  it('reports only the origin of a declared provider endpoint', () => {
    writeFileSync(path.join(home, '.codex/config.toml'), 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://user:SECRET_SENTINEL@example.com/SECRET_SENTINEL?key=SECRET_SENTINEL#SECRET_SENTINEL"');
    const result = run();
    expect(result[0].sources.find(s => s.kind === 'settings')?.settings?.providerEndpointOrigin).toBe('https://example.com');
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');
  });

  it('fingerprints configuration edits, environment and project identity', () => {
    const first = run()[0].fingerprint;
    writeFileSync(path.join(home, '.codex/config.toml'), 'model="one"');
    const second = run()[0].fingerprint;
    expect(second).not.toBe(first);
    expect(run(false, { PATH: '', CODEX_HOME: path.join(dir, 'other') })[0].fingerprint).not.toBe(second);
    expect(run(false, { PATH: '', OPENAI_API_KEY: 'private-value' })[0].fingerprint).not.toBe(second);
    expect(JSON.stringify(run(false, { OPENAI_API_KEY: 'private-value' }))).not.toContain('private-value');
  });

  it('rejects project symlinks escaping the repository', () => {
    writeFileSync(path.join(home, 'config.toml'), 'model="outside"');
    symlinkSync(path.join(home, 'config.toml'), path.join(project, '.codex/config.toml'));
    expect(run(true)[0].model.status).toBe('UNKNOWN');
    expect(run(true)[0].diagnostics.join(' ')).toContain('escapes');
  });

  it('does not infer authentication or read an unsupported Antigravity candidate schema', () => {
    mkdirSync(path.join(home, '.gemini/antigravity-cli'), { recursive: true });
    writeFileSync(path.join(home, '.gemini/antigravity-cli/settings.json'), '{"model":"not-confirmed","token":"SECRET"}');
    expect(run()[2].model.status).toBe('UNKNOWN');
    expect(run()[2].authentication).toBe('UNKNOWN');
    expect(JSON.stringify(run())).not.toContain('SECRET');
  });

  it('resolves executable paths with spaces without executing them or accepting relative PATH entries', () => {
    const bin = path.join(dir, 'bin ü'); mkdirSync(bin);
    const executable = path.join(bin, 'codex'); writeFileSync(executable, 'not a program'); chmodSync(executable, 0o755);
    expect(resolveAgentExecutables('codex', { PATH: bin }, 'linux')).toEqual([executable]);
    expect(resolveAgentExecutables('codex', { PATH: '.:' }, 'linux')).toEqual([]);
  });
});
