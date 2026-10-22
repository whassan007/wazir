import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

function writeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-build-cli-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'wazir', workspaces: ['packages/*', 'apps/*'] }));
  const pkg = (dir, name, extra = {}) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name, scripts: { build: 'tsc --build' }, ...extra }));
  };
  pkg('packages/core', '@wazir/core');
  pkg('packages/cli-only-tool', '@wazir/cli-only-tool');
  pkg('apps/desktop', '@wazir/desktop', { wazir: { excludeFromCliBuild: true } });
  // A workspace with no `build` script (e.g. a static app) must be skipped silently.
  fs.mkdirSync(path.join(root, 'apps/web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web/package.json'), JSON.stringify({ name: '@wazir/web', scripts: {} }));
  return root;
}

test('cliWorkspaces excludes workspaces opted out of the CLI build', async () => {
  const { cliWorkspaces } = await import(path.join(directory, 'build-cli.mjs'));
  const root = writeFixtureRoot();
  try {
    const names = cliWorkspaces(root, {});
    assert.deepEqual(names.sort(), ['@wazir/cli-only-tool', '@wazir/core']);
    assert.ok(!names.includes('@wazir/desktop'), 'desktop must never be in the default CLI build set');
    assert.ok(!names.includes('@wazir/web'), 'a workspace with no build script must be skipped');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WAZIR_BUILD_DESKTOP=1 opts a workspace back into the CLI build', async () => {
  const { cliWorkspaces } = await import(path.join(directory, 'build-cli.mjs'));
  const root = writeFixtureRoot();
  try {
    const names = cliWorkspaces(root, { WAZIR_BUILD_DESKTOP: '1' });
    assert.ok(names.includes('@wazir/desktop'), 'explicit opt-in must include desktop');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the real repo excludes exactly @wazir/desktop from its CLI build set', async () => {
  const { cliWorkspaces } = await import(path.join(directory, 'build-cli.mjs'));
  const repoRoot = path.resolve(directory, '..');
  const names = cliWorkspaces(repoRoot, {});
  assert.ok(names.includes('@wazir/cli'), 'the CLI package itself must always be built');
  assert.ok(!names.includes('@wazir/desktop'), 'desktop (tauri build, requires Cargo/network) must stay excluded by default');
});
