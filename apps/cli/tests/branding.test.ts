import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WAZIR_BRAND,
  detectTerminalCapabilities,
  selectTerminalLogo,
  renderUnicodeWideLogo,
  renderUnicodeMediumLogo,
  renderPlainAsciiLogo,
  renderCompactLogo,
  renderStartupBanner,
  stripAnsi,
  BannerSessionGuard,
} from '../src/brand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readPngDimensions(filePath: string): { width: number; height: number; colorType: number } {
  const buf = fs.readFileSync(filePath);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf.readUInt8(25);
  return { width, height, colorType };
}

describe('Wazir Unified Brand Identity & Asset Pipeline', () => {
  it('maintains authoritative CVI tokens synchronized between brand.json and CLI brand.ts', () => {
    const brandJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'assets/brand/brand.json'), 'utf8')
    );
    expect(brandJson.name).toBe('Wazir');
    expect(brandJson.subtitle).toBe('A Local AI Fleet Counselor');
    expect(brandJson.colors.primary.darkAbyss.hex).toBe('#0f131a');
    expect(brandJson.colors.primary.electricBlue.hex).toBe('#38bdf8');
    expect(brandJson.colors.primary.metallicSilver.hex).toBe('#94a3b8');
    expect(brandJson.colors.primary.dataGreen.hex).toBe('#22c55e');

    expect(WAZIR_BRAND.colors.darkAbyss.hex).toBe(brandJson.colors.primary.darkAbyss.hex);
    expect(WAZIR_BRAND.colors.electricBlue.hex).toBe(brandJson.colors.primary.electricBlue.hex);
    expect(WAZIR_BRAND.colors.metallicSilver.hex).toBe(brandJson.colors.primary.metallicSilver.hex);
    expect(WAZIR_BRAND.colors.dataGreen.hex).toBe(brandJson.colors.primary.dataGreen.hex);
    expect(WAZIR_BRAND.minimumDigitalEmblemSizePx).toBe(96);
  });

  it('generates valid master transparent PNG and SVG brand assets from assets/brand/logo.jpeg', () => {
    const emblemPng = path.join(ROOT, 'assets/brand/generated/emblem-transparent.png');
    const lockupPng = path.join(ROOT, 'assets/brand/generated/lockup-transparent.png');
    expect(readPngDimensions(emblemPng)).toEqual({ width: 1024, height: 1024, colorType: 6 });
    expect(readPngDimensions(lockupPng)).toEqual({ width: 1200, height: 1200, colorType: 6 });

    for (const svgName of ['logo-emblem.svg', 'logo-lockup.svg', 'logo-monochrome.svg']) {
      const svgContent = fs.readFileSync(path.join(ROOT, 'assets/brand/generated', svgName), 'utf8');
      expect(svgContent).toContain('<svg');
      expect(svgContent).toContain('viewBox=');
      expect(svgContent).toContain('</svg>');
    }
  });

  it('generates all Web favicons, Apple Touch icon, PWA icons, manifest, and Open Graph image with exact dimensions', () => {
    const webDir = path.join(ROOT, 'apps/web/public');
    const expectedPngs: Array<[string, number, number]> = [
      ['favicon-16x16.png', 16, 16],
      ['favicon-32x32.png', 32, 32],
      ['apple-touch-icon.png', 180, 180],
      ['icon-192.png', 192, 192],
      ['icon-512.png', 512, 512],
      ['icon-maskable-512.png', 512, 512],
      ['logo-emblem.png', 256, 256],
      ['og-image.png', 1200, 630],
    ];

    for (const [file, w, h] of expectedPngs) {
      const dims = readPngDimensions(path.join(webDir, file));
      expect(dims.width, file).toBe(w);
      expect(dims.height, file).toBe(h);
    }

    const icoBuf = fs.readFileSync(path.join(webDir, 'favicon.ico'));
    expect(icoBuf.subarray(0, 4).toString('hex')).toBe('00000100');

    const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'site.webmanifest'), 'utf8'));
    expect(manifest.short_name).toBe('Wazir');
    expect(manifest.background_color).toBe('#0f131a');
    expect(manifest.theme_color).toBe('#0f131a');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4);

    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest" href="/site.webmanifest"');
    expect(html).toContain('property="og:image" content="/og-image.png"');
    expect(html).toContain('#0f131a');
    expect(html).toContain('#38bdf8');
    expect(html).toContain('A Local AI Fleet Counselor');
    expect(html).toContain('[data-theme="light"]');
  });

  it('generates all Desktop (Tauri, macOS ICNS, Windows ICO, Linux .desktop, system tray) icons', () => {
    const tauriIcons = path.join(ROOT, 'apps/desktop/src-tauri/icons');
    const expectedDesktopPngs: Array<[string, number, number]> = [
      ['32x32.png', 32, 32],
      ['64x64.png', 64, 64],
      ['128x128.png', 128, 128],
      ['128x128@2x.png', 256, 256],
      ['icon.png', 512, 512],
      ['tray-icon.png', 22, 22],
      ['tray-icon@2x.png', 44, 44],
    ];

    for (const [file, w, h] of expectedDesktopPngs) {
      const dims = readPngDimensions(path.join(tauriIcons, file));
      expect(dims.width, file).toBe(w);
      expect(dims.height, file).toBe(h);
    }

    const icoBuf = fs.readFileSync(path.join(tauriIcons, 'icon.ico'));
    expect(icoBuf.subarray(0, 4).toString('hex')).toBe('00000100');

    for (const icnsPath of [
      path.join(tauriIcons, 'icon.icns'),
      path.join(ROOT, 'scripts/AppIcon.icns'),
    ]) {
      const icnsBuf = fs.readFileSync(icnsPath);
      expect(icnsBuf.subarray(0, 4).toString('ascii')).toBe('icns');
      expect(icnsBuf.length).toBeGreaterThan(10_000);
    }

    const desktopEntry = fs.readFileSync(path.join(ROOT, 'packaging/linux/wazir.desktop'), 'utf8');
    expect(desktopEntry).toContain('Name=Wazir');
    expect(desktopEntry).toContain('GenericName=Local AI Fleet Counselor');
  });

  it('generates Android adaptive icons, monochrome icon, notification icon, raster mipmaps, and iOS AppIcon catalog', () => {
    const androidRes = path.join(ROOT, 'apps/android/app/src/main/res');
    for (const xmlRel of [
      'drawable/ic_wazir_logo.xml',
      'drawable/ic_launcher_background.xml',
      'drawable/ic_launcher_foreground.xml',
      'drawable/ic_launcher_monochrome.xml',
      'drawable/ic_stat_wazir.xml',
      'mipmap-anydpi-v26/ic_launcher.xml',
      'mipmap-anydpi-v26/ic_launcher_round.xml',
    ]) {
      const xml = fs.readFileSync(path.join(androidRes, xmlRel), 'utf8');
      expect(xml.length, xmlRel).toBeGreaterThan(100);
    }

    const mipmapSizes: Array<[string, number]> = [
      ['mipmap-mdpi', 48],
      ['mipmap-hdpi', 72],
      ['mipmap-xhdpi', 96],
      ['mipmap-xxhdpi', 144],
      ['mipmap-xxxhdpi', 192],
    ];
    for (const [folder, px] of mipmapSizes) {
      const launcherDims = readPngDimensions(path.join(androidRes, folder, 'ic_launcher.png'));
      expect(launcherDims.width, `${folder}/ic_launcher.png`).toBe(px);
      expect(launcherDims.height, `${folder}/ic_launcher.png`).toBe(px);
    }

    const iosCatalog = path.join(ROOT, 'assets/brand/ios/AppIcon.appiconset');
    const contents = JSON.parse(fs.readFileSync(path.join(iosCatalog, 'Contents.json'), 'utf8'));
    expect(contents.images.length).toBe(11);
    const marketingDims = readPngDimensions(path.join(iosCatalog, 'Icon-App-1024x1024@1x.png'));
    expect(marketingDims.width).toBe(1024);
    expect(marketingDims.height).toBe(1024);
    // iOS marketing icon must be RGB (colorType 2, no alpha channel)
    expect(marketingDims.colorType).toBe(2);
  });
});

describe('Wazir Terminal Logo & Startup Banner Adaptation', () => {
  const sampleStatus = {
    version: '0.1.68',
    workspace: '/Users/wael/Code/Wazir',
    runtimeConnected: true,
    runtimeLabel: 'ollama',
    modelsAvailable: 3,
    mode: 'Autonomous',
  };

  it('selects high-fidelity Unicode wide logo on wide terminals (>= 66 cols) with CVI truecolor codes', () => {
    const { logo, capabilities } = selectTerminalLogo({
      isTTY: true,
      columns: 100,
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    });
    expect(capabilities.variant).toBe('unicode-wide');
    expect(capabilities.colorMode).toBe('truecolor');
    // Contains CVI Electric Blue (56;189;248) and Ice White (248;250;252)
    expect(logo).toContain('\x1b[38;2;56;189;248m');
    expect(logo).toContain('\x1b[38;2;248;250;252m');

    const plain = stripAnsi(logo);
    expect(plain).toContain('╱▲╲');
    expect(plain).toContain('◉');
    expect(plain).toContain('█   █ ▄▀█ ▀▀█ █ █▀█');
    expect(plain).toContain('▀▄▀▄▀ █▀█ █▄▄ █ █▀▄');
    expect(plain).toContain('A LOCAL AI FLEET COUNSELOR');
  });

  it('selects medium Unicode logo on medium-width terminals (46..65 cols) without overflowing width', () => {
    const { logo, capabilities } = selectTerminalLogo({
      isTTY: true,
      columns: 54,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
    });
    expect(capabilities.variant).toBe('unicode-medium');
    for (const line of stripAnsi(logo).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(54);
    }
    expect(stripAnsi(logo)).toContain('A LOCAL AI FLEET COUNSELOR');
  });

  it('selects compact logo on narrow terminals (< 46 cols)', () => {
    const { logo, capabilities } = selectTerminalLogo({
      isTTY: true,
      columns: 40,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
    });
    expect(capabilities.variant).toBe('compact');
    expect(stripAnsi(logo)).toContain('⟪◈⟫ WAZIR · AI Fleet Counselor');
    expect(stripAnsi(logo).length).toBeLessThanOrEqual(40);
  });

  it('falls back to pure 7-bit ASCII logo in ASCII-only locales or when --ascii is passed', () => {
    const { logo, capabilities } = selectTerminalLogo({
      isTTY: true,
      columns: 80,
      env: { LC_ALL: 'C', TERM: 'dumb' },
    });
    expect(capabilities.variant).toBe('ascii');
    expect(capabilities.unicode).toBe(false);
    expect(capabilities.colorMode).toBe('none');
    expect(logo).toContain('/\\     /^\\     /\\');
    expect(logo).toContain('(@)');
    expect(logo).toContain('A LOCAL AI FLEET COUNSELOR');
    // Strictly printable 7-bit ASCII + newline
    expect(/^[\x20-\x7e\n]+$/.test(logo)).toBe(true);
  });

  it('disables all ANSI escape sequences when NO_COLOR or --no-color is active', () => {
    const bannerNoColorEnv = renderStartupBanner(sampleStatus, {
      isTTY: true,
      columns: 90,
      env: { NO_COLOR: '1', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    });
    expect(bannerNoColorEnv).not.toContain('\x1b[');
    expect(bannerNoColorEnv).toContain('Wazir v0.1.68');
    expect(bannerNoColorEnv).toContain('Autonomous Agent Orchestration');
    expect(bannerNoColorEnv).toContain('Models     3 available');

    const bannerNoColorFlag = renderStartupBanner(sampleStatus, {
      isTTY: true,
      columns: 90,
      noColorFlag: true,
      env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    });
    expect(bannerNoColorFlag).not.toContain('\x1b[');
  });

  it('suppresses decorative startup banner in non-TTY, piped stdout, --no-banner, --json, and --quiet modes', () => {
    expect(
      renderStartupBanner(sampleStatus, { isTTY: false, columns: 80 })
    ).toBe('');
    expect(
      renderStartupBanner(sampleStatus, { isTTY: true, columns: 80, noBannerFlag: true })
    ).toBe('');
    expect(
      renderStartupBanner(sampleStatus, { isTTY: true, columns: 80, jsonFlag: true })
    ).toBe('');
    expect(
      renderStartupBanner(sampleStatus, { isTTY: true, columns: 80, quietFlag: true })
    ).toBe('');
  });

  it('prevents repeated banner printing during terminal resize events', () => {
    // Pin the environment: CI=true on a host would suppress the banner entirely.
    const guard = new BannerSessionGuard();
    expect(guard.shouldPrint({ isTTY: true, columns: 80, env: {} })).toBe(true);
    expect(guard.onResize()).toBe(false);
    expect(guard.shouldPrint({ isTTY: true, columns: 100, env: {} })).toBe(false);
  });
});
