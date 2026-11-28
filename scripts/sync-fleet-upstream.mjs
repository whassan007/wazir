#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const targetRoot = path.join(repoRoot, 'apps/wazir-fleet');
const remoteRepoUrl = 'https://github.com/whassan007/Fleet.git';

const SYNC_ENTRIES = ['Package.swift', 'Sources', 'Tests', 'Resources', 'docs', 'scripts'];
const PRESERVED_RELATIVE_PATHS = new Set([
  'Sources/FleetCore/WazirControlPlaneBridge.swift',
  'Tests/FleetCoreTests/WazirControlPlaneBridgeTests.swift',
  'LICENSE.md',
  'UPSTREAM_SYNC.json',
]);

function resolveUpstreamDir(options = {}) {
  const candidates = [
    options.upstreamDir,
    process.env.WAZIR_FLEET_UPSTREAM_DIR,
    '/Users/wael/Code/Fleet',
    path.resolve(repoRoot, '../Fleet'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'Package.swift')) && fs.existsSync(path.join(dir, 'Sources'))) {
      return dir;
    }
  }
  return null;
}

function copyTreeFiltered(src, dest, relBase = '') {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const baseName = path.basename(src);
    if (baseName === '.git' || baseName === '.build' || baseName === 'build') return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const nextRel = relBase ? `${relBase}/${entry}` : entry;
      copyTreeFiltered(path.join(src, entry), path.join(dest, entry), nextRel);
    }
    return;
  }

  if (path.basename(src) === 'HANDOFF.md' || PRESERVED_RELATIVE_PATHS.has(relBase)) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function transformReadmeToAgpl(readmePath) {
  if (!fs.existsSync(readmePath)) return;
  let content = fs.readFileSync(readmePath, 'utf8');
  content = content
    .replace(/^# Fleet\b/m, '# Wazir Fleet')
    .replace(
      /\[!\[License: PolyForm Noncommercial 1\.0\.0\]\(https:\/\/img\.shields\.io\/badge\/license-PolyForm%20Noncommercial-blue\)\]\(LICENSE\.md\)/g,
      '[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](../../LICENSE)',
    )
    .replace(
      /## License[\s\S]*$/m,
      `## License\n\nWazir Fleet is part of Wazir AI OS and is licensed under the **GNU Affero General Public License v3.0 (\`AGPL-3.0-only\`)** ([\`../../LICENSE\`](../../LICENSE)).\nA separate commercial license is available for proprietary or commercial deployments; see [\`../../LICENSE-COMMERCIAL.md\`](../../LICENSE-COMMERCIAL.md).\n`,
    );
  fs.writeFileSync(readmePath, content, 'utf8');
}

export function syncFleetUpstream(options = {}) {
  let upstreamDir = resolveUpstreamDir(options);
  let tempCloneDir = null;

  if (!upstreamDir && options.remote) {
    tempCloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-fleet-upstream-'));
    execFileSync('git', ['clone', '--depth', '1', remoteRepoUrl, tempCloneDir], {
      stdio: options.quiet ? 'ignore' : 'inherit',
    });
    upstreamDir = tempCloneDir;
  }

  try {
    if (!upstreamDir) {
      if (options.ifPresent) {
        return { synced: false, reason: 'upstream_not_found' };
      }
      throw new Error('Upstream Fleet repository not found. Set WAZIR_FLEET_UPSTREAM_DIR or pass --remote.');
    }

    for (const entry of SYNC_ENTRIES) {
      const src = path.join(upstreamDir, entry);
      if (!fs.existsSync(src)) continue;
      copyTreeFiltered(src, path.join(targetRoot, entry), entry);
    }

    const srcReadme = path.join(upstreamDir, 'README.md');
    const destReadme = path.join(targetRoot, 'README.md');
    if (fs.existsSync(srcReadme)) {
      fs.copyFileSync(srcReadme, destReadme);
      transformReadmeToAgpl(destReadme);
    }

    // Re-apply Wazir Fleet window title in FleetApp.swift if overwritten by upstream
    const fleetAppPath = path.join(targetRoot, 'Sources/Fleet/FleetApp.swift');
    if (fs.existsSync(fleetAppPath)) {
      const appSrc = fs.readFileSync(fleetAppPath, 'utf8');
      const updatedAppSrc = appSrc.replace(/Window\("Fleet",\s*id:\s*"main"\)/g, 'Window("Wazir Fleet", id: "main")');
      if (updatedAppSrc !== appSrc) {
        fs.writeFileSync(fleetAppPath, updatedAppSrc, 'utf8');
      }
    }

    const gitInfo = (args) => {
      try {
        return execFileSync('git', args, { cwd: upstreamDir, encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    };

    const metadata = {
      upstreamPath: options.remote && tempCloneDir ? remoteRepoUrl : upstreamDir,
      branch: gitInfo(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
      commit: gitInfo(['rev-parse', 'HEAD']) || 'unknown',
      commitShort: gitInfo(['rev-parse', '--short', 'HEAD']) || 'unknown',
      commitSubject: gitInfo(['log', '-1', '--format=%s']) || 'unknown',
      commitDate: gitInfo(['log', '-1', '--format=%cI']) || new Date().toISOString(),
      dirtyWorkingTree: Boolean(gitInfo(['status', '--porcelain'])),
      syncedAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(targetRoot, 'UPSTREAM_SYNC.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    if (!options.quiet) {
      console.log(`✓ Synced Wazir Fleet from ${metadata.upstreamPath} (${metadata.branch}@${metadata.commitShort}: ${metadata.commitSubject})`);
    }

    if (options.build && process.platform === 'darwin') {
      const bundleArgs = [];
      if (options.open) bundleArgs.push('--open');
      const res = spawnSync('bash', [path.join(targetRoot, 'scripts/bundle.sh'), ...bundleArgs], {
        cwd: targetRoot,
        stdio: 'inherit',
      });
      if (res.status !== 0) {
        throw new Error(`Wazir Fleet bundle failed with exit code ${res.status ?? 1}`);
      }
    }

    return { synced: true, metadata };
  } finally {
    if (tempCloneDir) {
      fs.rmSync(tempCloneDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const result = syncFleetUpstream({
    ifPresent: args.has('--if-present'),
    quiet: args.has('--quiet'),
    remote: args.has('--remote'),
    build: args.has('--build'),
    open: args.has('--open'),
  });
  if (args.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  }
}
