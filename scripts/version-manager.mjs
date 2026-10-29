#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

export function getCanonicalVersion() {
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return rootPkg.version;
}

export function getAllManifestDeclarations(repo = repoRoot) {
  const declarations = [];

  // 1. root package.json
  const rootPkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  declarations.push({
    file: 'package.json',
    format: 'json',
    declaredVersion: rootPkg.version,
    field: 'version',
  });

  // 2. workspace package.jsons
  for (const group of ['packages', 'apps', 'packages/runtimes']) {
    const dir = path.join(repo, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkgPath = path.join(dir, name, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        declarations.push({
          file: path.relative(repo, pkgPath),
          format: 'json',
          declaredVersion: pkg.version,
          field: 'version',
        });
      }
    }
  }

  // 3. Debian control
  const debPath = path.join(repo, 'packaging/deb/debian/control');
  if (existsSync(debPath)) {
    const content = readFileSync(debPath, 'utf8');
    const m = content.match(/^Version:\s*([^\s]+)/m);
    declarations.push({
      file: 'packaging/deb/debian/control',
      format: 'debian-control',
      declaredVersion: m ? m[1] : null,
      field: 'Version',
    });
  }

  // 4. RPM spec
  const rpmPath = path.join(repo, 'packaging/rpm/wazir.spec');
  if (existsSync(rpmPath)) {
    const content = readFileSync(rpmPath, 'utf8');
    const m = content.match(/^Version:\s*([^\s]+)/m);
    declarations.push({
      file: 'packaging/rpm/wazir.spec',
      format: 'rpm-spec',
      declaredVersion: m ? m[1] : null,
      field: 'Version',
    });
  }

  // 5. Homebrew formulas
  for (const hbRel of ['Formula/wazir.rb', 'packaging/homebrew/Formula/wazir.rb']) {
    const hbPath = path.join(repo, hbRel);
    if (existsSync(hbPath)) {
      const content = readFileSync(hbPath, 'utf8');
      const m = content.match(/version\s*"([^"]+)"/);
      declarations.push({
        file: hbRel,
        format: 'homebrew-formula',
        declaredVersion: m ? m[1] : null,
        field: 'version',
      });
    }
  }

  // 6. Scoop manifests
  for (const scoopRel of ['bucket/wazir.json', 'packaging/scoop/wazir.json']) {
    const scoopPath = path.join(repo, scoopRel);
    if (existsSync(scoopPath)) {
      const scoop = JSON.parse(readFileSync(scoopPath, 'utf8'));
      declarations.push({
        file: scoopRel,
        format: 'scoop-manifest',
        declaredVersion: scoop.version,
        field: 'version',
      });
    }
  }

  // 7. package-manager-version.txt
  const pmPath = path.join(repo, 'packaging/package-manager-version.txt');
  if (existsSync(pmPath)) {
    const ver = readFileSync(pmPath, 'utf8').trim();
    declarations.push({
      file: 'packaging/package-manager-version.txt',
      format: 'plain-text',
      declaredVersion: ver,
      field: 'content',
    });
  }

  // 8. Desktop Tauri Cargo.toml
  const cargoPath = path.join(repo, 'apps/desktop/src-tauri/Cargo.toml');
  if (existsSync(cargoPath)) {
    const content = readFileSync(cargoPath, 'utf8');
    const m = content.match(/^version\s*=\s*"([^"]+)"/m);
    declarations.push({
      file: 'apps/desktop/src-tauri/Cargo.toml',
      format: 'toml',
      declaredVersion: m ? m[1] : null,
      field: 'version',
    });
  }

  // 9. Desktop tauri.conf.json
  const tauriPath = path.join(repo, 'apps/desktop/src-tauri/tauri.conf.json');
  if (existsSync(tauriPath)) {
    const tauri = JSON.parse(readFileSync(tauriPath, 'utf8'));
    declarations.push({
      file: 'apps/desktop/src-tauri/tauri.conf.json',
      format: 'json',
      declaredVersion: tauri.version,
      field: 'version',
    });
  }

  return declarations;
}

export function checkVersionParity(repo = repoRoot) {
  const canonical = getCanonicalVersion();
  const declarations = getAllManifestDeclarations(repo);
  const mismatches = [];

  for (const dec of declarations) {
    if (dec.declaredVersion !== canonical) {
      mismatches.push({
        file: dec.file,
        format: dec.format,
        declaredVersion: dec.declaredVersion,
        expectedVersion: canonical,
      });
    }
  }

  return { canonical, declarations, mismatches, isParity: mismatches.length === 0 };
}

export function syncAllVersions(targetVersion, repo = repoRoot) {
  if (!targetVersion) {
    targetVersion = getCanonicalVersion();
  }

  const updatedFiles = [];

  // Helper to record update
  const recordUpdate = (relPath) => {
    if (!updatedFiles.includes(relPath)) updatedFiles.push(relPath);
  };

  // 1. Root & Workspace package.json files
  const pkgPaths = ['package.json'];
  for (const group of ['packages', 'apps', 'packages/runtimes']) {
    const dir = path.join(repo, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name, 'package.json');
      if (existsSync(p)) pkgPaths.push(path.relative(repo, p));
    }
  }

  for (const rel of pkgPaths) {
    const fullPath = path.join(repo, rel);
    const content = readFileSync(fullPath, 'utf8');
    const json = JSON.parse(content);
    if (json.version !== targetVersion) {
      json.version = targetVersion;
      writeFileSync(fullPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      recordUpdate(rel);
    }
  }

  // 2. Debian control
  const debPath = path.join(repo, 'packaging/deb/debian/control');
  if (existsSync(debPath)) {
    const content = readFileSync(debPath, 'utf8');
    const updated = content.replace(/^Version:\s*([^\s]+)/m, `Version: ${targetVersion}`);
    if (updated !== content) {
      writeFileSync(debPath, updated, 'utf8');
      recordUpdate('packaging/deb/debian/control');
    }
  }

  // 3. RPM spec
  const rpmPath = path.join(repo, 'packaging/rpm/wazir.spec');
  if (existsSync(rpmPath)) {
    const content = readFileSync(rpmPath, 'utf8');
    let updated = content.replace(/^Version:\s*([^\s]+)/m, `Version:        ${targetVersion}`);
    // Also update any release download tarball reference in comments/sources if present
    updated = updated.replace(/\/v[0-9\.]+\/wazir-v[0-9\.]+/g, `/v${targetVersion}/wazir-v${targetVersion}`);
    if (updated !== content) {
      writeFileSync(rpmPath, updated, 'utf8');
      recordUpdate('packaging/rpm/wazir.spec');
    }
  }

  // 4. Homebrew Formula
  for (const hbRel of ['Formula/wazir.rb', 'packaging/homebrew/Formula/wazir.rb']) {
    const fullPath = path.join(repo, hbRel);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf8');
      let updated = content.replace(/version\s*"[^"]+"/g, `version "${targetVersion}"`);
      updated = updated.replace(/\/v[0-9\.]+\/wazir-v[0-9\.]+/g, `/v${targetVersion}/wazir-v${targetVersion}`);
      if (updated !== content) {
        writeFileSync(fullPath, updated, 'utf8');
        recordUpdate(hbRel);
      }
    }
  }

  // 5. Scoop manifests
  for (const scoopRel of ['bucket/wazir.json', 'packaging/scoop/wazir.json']) {
    const fullPath = path.join(repo, scoopRel);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf8');
      const json = JSON.parse(content);
      let changed = false;
      if (json.version !== targetVersion) {
        json.version = targetVersion;
        changed = true;
      }
      // update architecture URLs
      if (json.architecture) {
        for (const arch of Object.keys(json.architecture)) {
          if (json.architecture[arch].url) {
            const oldUrl = json.architecture[arch].url;
            json.architecture[arch].url = oldUrl.replace(/\/v[0-9\.]+\/wazir-v[0-9\.]+/g, `/v${targetVersion}/wazir-v${targetVersion}`);
            if (json.architecture[arch].url !== oldUrl) changed = true;
          }
        }
      }
      if (changed) {
        writeFileSync(fullPath, JSON.stringify(json, null, 4) + '\n', 'utf8');
        recordUpdate(scoopRel);
      }
    }
  }

  // 6. packaging/package-manager-version.txt
  const pmPath = path.join(repo, 'packaging/package-manager-version.txt');
  if (existsSync(pmPath)) {
    const content = readFileSync(pmPath, 'utf8').trim();
    if (content !== targetVersion) {
      writeFileSync(pmPath, `${targetVersion}\n`, 'utf8');
      recordUpdate('packaging/package-manager-version.txt');
    }
  }

  // 7. apps/desktop/src-tauri/Cargo.toml
  const cargoPath = path.join(repo, 'apps/desktop/src-tauri/Cargo.toml');
  if (existsSync(cargoPath)) {
    const content = readFileSync(cargoPath, 'utf8');
    const updated = content.replace(/^version\s*=\s*"[^"]+"/m, `version = "${targetVersion}"`);
    if (updated !== content) {
      writeFileSync(cargoPath, updated, 'utf8');
      recordUpdate('apps/desktop/src-tauri/Cargo.toml');
    }
  }

  // 8. apps/desktop/src-tauri/tauri.conf.json
  const tauriPath = path.join(repo, 'apps/desktop/src-tauri/tauri.conf.json');
  if (existsSync(tauriPath)) {
    const content = readFileSync(tauriPath, 'utf8');
    const json = JSON.parse(content);
    if (json.version !== targetVersion) {
      json.version = targetVersion;
      writeFileSync(tauriPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      recordUpdate('apps/desktop/src-tauri/tauri.conf.json');
    }
  }

  return updatedFiles;
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || 'check';
  const arg = process.argv[3];

  if (cmd === 'check') {
    const result = checkVersionParity();
    console.log(`Authoritative Version: ${result.canonical}`);
    console.log(`Inspected ${result.declarations.length} version declarations.`);
    if (result.isParity) {
      console.log('✓ All version declarations match authoritative version.');
      process.exit(0);
    } else {
      console.error(`✗ Packaging parity failure: ${result.mismatches.length} mismatch(es) found:`);
      for (const m of result.mismatches) {
        console.error(`  - ${m.file} (${m.format}): declared ${m.declaredVersion}, expected ${m.expectedVersion}`);
      }
      process.exit(1);
    }
  } else if (cmd === 'sync') {
    const target = arg || getCanonicalVersion();
    console.log(`Synchronizing all distribution declarations to version ${target}...`);
    const updated = syncAllVersions(target);
    console.log(`Updated ${updated.length} files:`);
    for (const f of updated) {
      console.log(`  ✓ ${f}`);
    }
    const check = checkVersionParity();
    if (!check.isParity) {
      console.error('✗ Error: Version mismatch remains after sync!');
      process.exit(1);
    }
    console.log('✓ All manifests are synchronized.');
  } else {
    console.error(`Unknown command: ${cmd}. Available: check, sync`);
    process.exit(1);
  }
}
