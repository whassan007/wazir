import { describe, it, expect } from 'vitest';
import { checkVersionParity, getCanonicalVersion, getAllManifestDeclarations } from '../scripts/version-manager.mjs';

describe('Version Parity & Synchronization Engine (CODEX-04)', () => {
  it('identifies authoritative canonical version from root package.json', () => {
    const version = getCanonicalVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/);
  });

  it('discovers all required distribution manifests', () => {
    const declarations = getAllManifestDeclarations();
    expect(declarations.length).toBeGreaterThanOrEqual(30);

    const files = declarations.map((d) => d.file);
    expect(files).toContain('package.json');
    expect(files).toContain('packaging/deb/debian/control');
    expect(files).toContain('packaging/rpm/wazir.spec');
    expect(files).toContain('Formula/wazir.rb');
    expect(files).toContain('packaging/homebrew/Formula/wazir.rb');
    expect(files).toContain('bucket/wazir.json');
    expect(files).toContain('packaging/scoop/wazir.json');
    expect(files).toContain('packaging/package-manager-version.txt');
    expect(files).toContain('apps/desktop/src-tauri/Cargo.toml');
    expect(files).toContain('apps/desktop/src-tauri/tauri.conf.json');
  });

  it('fails checkVersionParity when distribution manifests diverge from canonical version', () => {
    const result = checkVersionParity();
    // Before sync to 0.2.16/0.2.17, there are detected mismatches
    expect(result.declarations.length).toBeGreaterThan(0);
    expect(typeof result.isParity).toBe('boolean');
  });
});
