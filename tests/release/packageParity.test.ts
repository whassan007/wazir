import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function discoverWorkspacePackagePaths(): string[] {
  const workspaceGroups = ['apps', 'packages', 'packages/runtimes'];
  const paths: string[] = [];

  for (const group of workspaceGroups) {
    const groupDir = path.join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(groupDir, entry.name, 'package.json');
      if (existsSync(pkgPath)) {
        paths.push(path.relative(rootDir, pkgPath).split(path.sep).join('/'));
      }
    }
  }

  return paths.sort();
}

describe('Release Package Parity & Lineage Guardrails', () => {
  const rootPkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const authoritativeVersion: string = rootPkg.version;
  const authoritativeLicense = 'AGPL-3.0-only';
  const authoritativeNodeEngine = '>=22.13.0';

  it('synchronizes version, AGPL-3.0-only license, and engines.node >=22.13.0 across root and all workspace package.json files', () => {
    expect(authoritativeVersion).toBe('0.2.13');
    expect(rootPkg.license).toBe(authoritativeLicense);
    expect(rootPkg.engines?.node).toBe(authoritativeNodeEngine);
    expect(rootPkg.scripts?.['build:cli']).toBe('node scripts/build-cli.mjs');
    expect(rootPkg.scripts?.['test:updater']).toBe('vitest run apps/cli/tests/updater.test.ts');

    const workspacePaths = discoverWorkspacePackagePaths();
    expect(workspacePaths.length).toBeGreaterThanOrEqual(24);

    for (const relPath of workspacePaths) {
      const pkg = JSON.parse(readFileSync(path.join(rootDir, relPath), 'utf8'));
      expect(pkg.version, `${relPath} version`).toBe(authoritativeVersion);
      expect(pkg.license, `${relPath} license`).toBe(authoritativeLicense);
      expect(pkg.engines?.node, `${relPath} engines.node`).toBe(authoritativeNodeEngine);
    }

    const desktopPkg = JSON.parse(readFileSync(path.join(rootDir, 'apps/desktop/package.json'), 'utf8'));
    expect(desktopPkg.scripts?.['build:desktop']).toBe('tauri build --no-bundle');
    expect(desktopPkg.wazir?.excludeFromCliBuild).toBe(true);
  });

  it('aligns DEB, RPM, Homebrew, Scoop, Tauri, and package-manager-version.txt metadata with root package.json', () => {
    const debControl = readFileSync(path.join(rootDir, 'packaging/deb/debian/control'), 'utf8');
    expect(debControl).toContain(`Version: ${authoritativeVersion}`);
    expect(debControl).toContain('Depends: nodejs (>= 22.13.0) | nodejs-legacy (>= 22.13.0)');

    const rpmSpec = readFileSync(path.join(rootDir, 'packaging/rpm/wazir.spec'), 'utf8');
    expect(rpmSpec).toContain(`Version:        ${authoritativeVersion}`);
    expect(rpmSpec).toContain(`License:        ${authoritativeLicense}`);
    expect(rpmSpec).toContain('Requires:       nodejs >= 22.13.0');
    expect(rpmSpec).toContain(`${authoritativeVersion}-1`);

    for (const formulaRel of ['Formula/wazir.rb', 'packaging/homebrew/Formula/wazir.rb']) {
      const formula = readFileSync(path.join(rootDir, formulaRel), 'utf8');
      expect(formula, `${formulaRel} version`).toContain(`version "${authoritativeVersion}"`);
      expect(formula, `${formulaRel} license`).toContain(`license "${authoritativeLicense}"`);
      expect(formula, `${formulaRel} download url`).toContain(`/releases/download/v${authoritativeVersion}/`);
    }

    for (const scoopRel of ['bucket/wazir.json', 'packaging/scoop/wazir.json']) {
      const scoop = JSON.parse(readFileSync(path.join(rootDir, scoopRel), 'utf8'));
      expect(scoop.version, `${scoopRel} version`).toBe(authoritativeVersion);
      expect(scoop.license, `${scoopRel} license`).toBe(authoritativeLicense);
      expect(scoop.architecture?.['64bit']?.url, `${scoopRel} x64 url`).toContain(`/v${authoritativeVersion}/`);
      expect(scoop.architecture?.arm64?.url, `${scoopRel} arm64 url`).toContain(`/v${authoritativeVersion}/`);
    }

    const pmVersion = readFileSync(path.join(rootDir, 'packaging/package-manager-version.txt'), 'utf8').trim();
    expect(pmVersion).toBe(authoritativeVersion);

    const cargoToml = readFileSync(path.join(rootDir, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
    expect(cargoToml).toContain(`version = "${authoritativeVersion}"`);

    const tauriConf = JSON.parse(readFileSync(path.join(rootDir, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
    expect(tauriConf.version).toBe(authoritativeVersion);

    const updateManagersScript = readFileSync(path.join(rootDir, 'scripts/update-package-managers.mjs'), 'utf8');
    expect(updateManagersScript).not.toContain('AGPL-3.0-or-later');
    expect(updateManagersScript).toContain('AGPL-3.0-only');
  });

  it('ensures DEB/RPM systemd unit builders use valid wa CLI subcommands and build-binary.mjs does not mutate dotfiles by default', () => {
    for (const scriptRel of ['scripts/build-deb.mjs', 'scripts/build-rpm.mjs']) {
      const scriptContent = readFileSync(path.join(rootDir, scriptRel), 'utf8');
      expect(scriptContent, `${scriptRel} must not use nonexistent wa worker start`).not.toContain('/usr/bin/wa worker start');
      expect(scriptContent, `${scriptRel} must not use nonexistent wa api start`).not.toContain('/usr/bin/wa api start');
      expect(scriptContent, `${scriptRel} worker ExecStart`).toContain('/usr/bin/wa improve start --foreground --continuous');
      expect(scriptContent, `${scriptRel} api ExecStart`).toContain('/usr/bin/wa dashboard --no-open --host 0.0.0.0 --port 4800');
    }

    const buildBinaryScript = readFileSync(path.join(rootDir, 'scripts/build-binary.mjs'), 'utf8');
    expect(buildBinaryScript).toContain("process.env.WAZIR_SETUP_ENV === '1' || process.argv.includes('--setup-env')");
  });

  it('guards required release features from reconciled branches against silent loss', () => {
    const requiredFeaturePaths = [
      'packages/runtimes/nvidia/src/index.ts',
      'apps/cli/src/tui/fleetTui.ts',
      'packages/core/src/subagents/ledger.ts',
      'apps/cli/src/fleetRunner.ts',
      'apps/cli/src/updater/service.ts',
      'apps/api/src/mobile.ts',
      'packages/agents/src/verificationScope.ts',
      'packages/core/src/services/repoIntegrityGuard.ts',
    ];

    for (const relPath of requiredFeaturePaths) {
      const fullPath = path.join(rootDir, relPath);
      expect(existsSync(fullPath), `Required release feature missing: ${relPath}`).toBe(true);
    }
  });
});
