import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Wazir OS Native Plasma 6 / KWin / Image Configuration', () => {
  it('configures persistent top menu bar and centered floating dock in Plasma Look-and-Feel', () => {
    const metadata = JSON.parse(
      readRepoFile('os/wazir-os/plasma/look-and-feel/org.wazir.os.desktop/metadata.json'),
    );
    expect(metadata.KPlugin.Id).toBe('org.wazir.os.desktop');
    expect(metadata.KPlugin.License).toBe('AGPL-3.0-only');

    const layout = readRepoFile(
      'os/wazir-os/plasma/look-and-feel/org.wazir.os.desktop/contents/layouts/org.kde.plasma.desktop-layout.js',
    );
    expect(layout).toContain('topBar.location = "top"');
    expect(layout).toContain('org.kde.plasma.appmenu');
    expect(layout).toContain('org.wazir.fleet');
    expect(layout).toContain('dock.location = "bottom"');
    expect(layout).toContain('dock.floating = true');
    expect(layout).toContain('dock.alignment = "center"');
    expect(layout).toContain('org.kde.plasma.icontasks');
  });

  it('configures left-side macOS window controls, Overview, virtual desktops, and Super+Space Spotlight', () => {
    const kwinrc = readRepoFile('os/wazir-os/skel/.config/kwinrc');
    expect(kwinrc).toContain('ButtonsOnLeft=XIA');
    expect(kwinrc).toContain('Number=4');
    expect(kwinrc).toContain('overviewEnabled=true');

    const shortcuts = readRepoFile('os/wazir-os/skel/.config/kglobalshortcutsrc');
    expect(shortcuts).toContain('Meta+Space');
    expect(shortcuts).toContain('Overview=Meta+Up');
    expect(shortcuts).toContain('Window Close=Meta+Q');
    expect(shortcuts).toContain('Walk Through Windows=Meta+Tab');

    const dolphinrc = readRepoFile('os/wazir-os/skel/.config/dolphinrc');
    expect(dolphinrc).toContain('FilterBar=true');
    expect(dolphinrc).toContain('RememberOpenedTabs=true');
  });

  it('ships valid desktop launchers for all developer-native Wazir surfaces', () => {
    const launchers = [
      'os/wazir-os/apps/wazir-terminal.desktop',
      'os/wazir-os/apps/wazir-mission-control.desktop',
      'os/wazir-os/apps/wazir-fleet.desktop',
      'os/wazir-os/apps/wazir-approvals.desktop',
      'os/wazir-os/apps/wazir-settings.desktop',
      'os/wazir-os/apps/wazir-agent-monitor.desktop',
    ];
    for (const file of launchers) {
      const content = readRepoFile(file);
      expect(content).toContain('[Desktop Entry]');
      expect(content).toContain('Type=Application');
      expect(content).toContain('Exec=');
    }
  });

  it('has syntactically valid Python KRunner D-Bus daemon and bootc Containerfile', () => {
    const pyCheck = spawnSync(
      'python3',
      ['-m', 'py_compile', path.join(repoRoot, 'os/wazir-os/spotlight/wazir-spotlight-dbus.py')],
      { encoding: 'utf8' },
    );
    expect(pyCheck.status).toBe(0);

    const containerfile = readRepoFile('os/wazir-os/image/Containerfile');
    expect(containerfile).toContain('FROM ${BASE_IMAGE}');
    expect(containerfile).toContain('containers.bootc="1"');
    expect(containerfile).toContain('org.wazir.os.desktop');
    expect(containerfile).toContain('10-wazir.conf');
    expect(containerfile).toContain('bootc container lint');

    const sddmQml = readRepoFile('os/wazir-os/theme/sddm/Main.qml');
    expect(sddmQml).toContain('import SddmComponents');
    expect(sddmQml).toContain('sddm.login');

    const kdeglobals = readRepoFile('os/wazir-os/skel/.config/kdeglobals');
    expect(kdeglobals).toContain('LookAndFeelPackage=org.wazir.os.desktop');

    const tauriMain = readRepoFile('apps/desktop/src-tauri/src/main.rs');
    expect(tauriMain).toContain('surface_mission_control');
    expect(tauriMain).toContain('surface_approvals');
    expect(tauriMain).toContain('surface_settings');
  });
});
