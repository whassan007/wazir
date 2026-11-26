import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateCssTokens,
  generateJsonTokens,
  generateKdeColorScheme,
  generateKonsoleColorScheme,
} from './generators.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function writeOutput(relPath: string, content: string): void {
  const fullPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

export function generateAllDesignAssets(): string[] {
  const outputs: Array<[string, string]> = [
    ['packages/design-tokens/dist/wazir-tokens.css', generateCssTokens()],
    ['packages/design-tokens/dist/wazir-tokens.json', generateJsonTokens()],
    ['apps/web/public/wazir-tokens.css', generateCssTokens()],
    ['os/wazir-os/theme/color-schemes/WazirDark.colors', generateKdeColorScheme('dark')],
    ['os/wazir-os/theme/color-schemes/WazirLight.colors', generateKdeColorScheme('light')],
    ['os/wazir-os/theme/color-schemes/WazirHighContrastDark.colors', generateKdeColorScheme('dark-hc')],
    ['os/wazir-os/theme/color-schemes/WazirHighContrastLight.colors', generateKdeColorScheme('light-hc')],
    ['os/wazir-os/theme/konsole/WazirDark.colorscheme', generateKonsoleColorScheme('dark')],
    ['os/wazir-os/theme/konsole/WazirLight.colorscheme', generateKonsoleColorScheme('light')],
  ];

  for (const [rel, content] of outputs) {
    writeOutput(rel, content);
  }
  return outputs.map(([rel]) => rel);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = generateAllDesignAssets();
  console.log(`Generated ${written.length} Wazir design system artifacts.`);
}
