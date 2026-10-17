import fs from 'node:fs';
import path from 'node:path';

declare const __WAZIR_VERSION__: string | undefined;

let cached: string | undefined;

/**
 * The single Wazir release version reported by the API.
 *
 * Bundled builds get it from the `__WAZIR_VERSION__` define injected by
 * scripts/bundle.mjs (the same source the CLI uses). Source/dist runs read the
 * root `package.json` (name `wazir`), which is the canonical version. Never a
 * hardcoded literal, so `/health` and `/api/v1/overview` cannot drift from the
 * released version again.
 */
export function wazirVersion(): string {
  if (cached) return cached;
  if (typeof __WAZIR_VERSION__ === 'string' && __WAZIR_VERSION__) {
    cached = __WAZIR_VERSION__;
    return cached;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if (manifest.name === 'wazir' && typeof manifest.version === 'string') {
        cached = manifest.version;
        return cached;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = 'unknown';
  return cached;
}
