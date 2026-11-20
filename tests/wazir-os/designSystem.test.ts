import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRAND_AUTHORITY,
  THEME_PALETTES,
  contrastRatio,
  generateCssTokens,
  generateKdeColorScheme,
  generateKonsoleColorScheme,
} from '../../packages/design-tokens/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

describe('Wazir Design System & Brand Compliance', () => {
  it('matches authoritative assets/brand/brand.json without modifying it', () => {
    const brandJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'assets/brand/brand.json'), 'utf8'),
    );
    expect(BRAND_AUTHORITY.name).toBe(brandJson.name);
    expect(BRAND_AUTHORITY.subtitle).toBe(brandJson.subtitle);
    expect(BRAND_AUTHORITY.minimumDigitalEmblemSizePx).toBe(
      brandJson.usageRules.minimumDigitalEmblemSizePx,
    );
    expect(BRAND_AUTHORITY.colors.darkAbyss).toBe(brandJson.colors.primary.darkAbyss.hex);
    expect(BRAND_AUTHORITY.colors.electricBlue).toBe(brandJson.colors.primary.electricBlue.hex);
    expect(BRAND_AUTHORITY.colors.metallicSilver).toBe(brandJson.colors.primary.metallicSilver.hex);
    expect(BRAND_AUTHORITY.colors.dataGreen).toBe(brandJson.colors.primary.dataGreen.hex);
    expect(BRAND_AUTHORITY.colors.iceWhite).toBe(brandJson.colors.extended.iceWhite.hex);
    expect(BRAND_AUTHORITY.colors.cyanCoreGlow).toBe(brandJson.colors.extended.cyanCoreGlow.hex);
  });

  it('meets WCAG AA contrast for standard themes and WCAG AAA for high-contrast themes', () => {
    expect(contrastRatio(THEME_PALETTES.dark.textPrimary, THEME_PALETTES.dark.bgCanvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(THEME_PALETTES.dark.textPrimary, THEME_PALETTES.dark.bgSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(THEME_PALETTES.light.textPrimary, THEME_PALETTES.light.bgCanvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(THEME_PALETTES.light.textPrimary, THEME_PALETTES.light.bgSurface)).toBeGreaterThanOrEqual(4.5);

    expect(contrastRatio(THEME_PALETTES['dark-hc'].textPrimary, THEME_PALETTES['dark-hc'].bgCanvas)).toBeGreaterThanOrEqual(7.0);
    expect(contrastRatio(THEME_PALETTES['light-hc'].textPrimary, THEME_PALETTES['light-hc'].bgCanvas)).toBeGreaterThanOrEqual(7.0);
  });

  it('generates deterministic CSS, KDE color schemes, and Konsole themes with reduced-motion support', () => {
    const webCssPath = path.join(repoRoot, 'apps/web/public/wazir-tokens.css');
    expect(fs.existsSync(webCssPath)).toBe(true);
    const webCss = fs.readFileSync(webCssPath, 'utf8');
    expect(webCss).toBe(generateCssTokens());
    expect(webCss).toContain('prefers-reduced-motion: reduce');
    expect(webCss).toContain('prefers-contrast: more');
    expect(webCss).toContain('[data-theme="light"]');
    expect(webCss).toContain('[data-theme="dark-hc"]');

    const kdeDark = fs.readFileSync(
      path.join(repoRoot, 'os/wazir-os/theme/color-schemes/WazirDark.colors'),
      'utf8',
    );
    expect(kdeDark).toBe(generateKdeColorScheme('dark'));

    const kdeLight = fs.readFileSync(
      path.join(repoRoot, 'os/wazir-os/theme/color-schemes/WazirLight.colors'),
      'utf8',
    );
    expect(kdeLight).toBe(generateKdeColorScheme('light'));

    const konsoleDark = fs.readFileSync(
      path.join(repoRoot, 'os/wazir-os/theme/konsole/WazirDark.colorscheme'),
      'utf8',
    );
    expect(konsoleDark).toBe(generateKonsoleColorScheme('dark'));
  });
});
