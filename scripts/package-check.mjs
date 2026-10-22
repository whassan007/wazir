#!/usr/bin/env node
// npm run package:check — validates the npm package the way a user receives it.
//
//  1. builds (optionally from a clean clone of HEAD: --clean-clone)
//  2. packs the publishable tarball (scripts/pack-npm.mjs)
//  3. inspects its contents against an allowlist and size budget
//  4. scans every packaged file for secrets and developer paths
//  5. installs it globally into an isolated prefix, a local project, and a local project
//     without optional (native) dependencies
//  6. runs `wa` from a directory outside the repository with an isolated WAZIR_HOME
//  7. smoke-tests the CLI and checks which optional runtime modules resolved
//  8. upgrades in place (reinstall over existing state) and checks user state is untouched
//  9. uninstalls and checks the command is gone and user state is still there
// 10. writes dist/package-check.json (machine-readable) and exits non-zero on any FAIL
//
//   node scripts/package-check.mjs [--clean-clone] [--skip-build] [--tarball <file>] [--previous <file>]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? path.resolve(args[i + 1]) : undefined; };
const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';
const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const started = Date.now();
const report = { version, platform: process.platform, arch: process.arch, node: process.versions.node, npm: undefined, commit: undefined, checks: [] };
const record = (name, status, detail = {}) => {
  report.checks.push({ name, status, ...detail });
  console.log(`${status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '-'} ${name}${detail.note ? ` — ${detail.note}` : ''}`);
};
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', shell: win && /\.cmd$/.test(cmd), maxBuffer: 64 * 1024 * 1024, ...opts });
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

try { report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
report.npm = run(npm, ['--version']).stdout?.trim();
const work = mkdtempSync(path.join(os.tmpdir(), 'wazir-pkgcheck-'));

// ---- 1-2. build and pack ------------------------------------------------------------------
let tarball = opt('--tarball');
if (!tarball) {
  let src = repo;
  if (flag('--clean-clone')) {
    src = path.join(work, 'clone');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', repo, src], { stdio: 'inherit' });
    execFileSync('git', ['checkout', '--quiet', report.commit], { cwd: src, stdio: 'inherit' });
    // An isolated HOME: building must not read or write the developer's ~/.wazir or shell profiles.
    const fakeHome = path.join(work, 'build-home');
    mkdirSync(fakeHome);
    const cache = run(npm, ['config', 'get', 'cache']).stdout.trim();
    const buildEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, WAZIR_HOME: path.join(fakeHome, '.wazir'), npm_config_cache: cache };
    const ci = run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: src, stdio: 'inherit', env: buildEnv });
    if (ci.status !== 0) throw new Error('npm ci failed in clean clone');
  }
  if (!flag('--skip-build') && (!existsSync(path.join(src, 'bin/wa.js')) || flag('--clean-clone') || flag('--build'))) {
    const b = run(npm, ['run', 'build'], { cwd: src, stdio: 'inherit' });
    record('build', b.status === 0 ? 'PASS' : 'FAIL', { note: flag('--clean-clone') ? 'clean clone of HEAD' : 'working tree' });
    if (b.status !== 0) finish();
  }
  const p = run(process.execPath, [path.join(src, 'scripts/pack-npm.mjs'), '--skip-bundle'], { cwd: src });
  if (p.status !== 0) { record('pack', 'FAIL', { note: p.stderr.slice(-500) }); finish(); }
  tarball = p.stdout.trim().split('\n').at(-1);
  if (src !== repo) { mkdirSync(path.join(repo, 'dist/npm'), { recursive: true }); const dest = path.join(repo, 'dist/npm', path.basename(tarball)); writeFileSync(dest, readFileSync(tarball)); tarball = dest; }
}
report.tarball = { file: path.basename(tarball), bytes: statSync(tarball).size, sha256: sha(tarball) };
record('pack', 'PASS', { note: `${report.tarball.file} ${(report.tarball.bytes / 1e6).toFixed(1)} MB` });

// ---- 3. contents --------------------------------------------------------------------------
const extract = path.join(work, 'extract');
mkdirSync(extract);
  // Windows GNU tar may interpret an absolute drive path as a remote host.
  // Extract by basename from the archive's directory to keep the path local.
  execFileSync('tar', ['-xzf', path.basename(tarball), '-C', extract], { cwd: path.dirname(tarball) });
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(path.relative(path.join(extract, 'package'), f).split(path.sep).join('/')); } };
walk(path.join(extract, 'package'));
const allowed = ['LICENSE', 'README.md', 'bin/wa.js', 'package.json'];
const unexpected = files.filter((f) => !allowed.includes(f));
const missing = allowed.filter((f) => !files.includes(f));
const manifest = JSON.parse(readFileSync(path.join(extract, 'package/package.json'), 'utf8'));
const lifecycle = Object.keys(manifest.scripts ?? {}).filter((s) => /install|prepare|prepublish/.test(s));
const problems = [
  ...unexpected.map((f) => `unexpected file ${f}`), ...missing.map((f) => `missing ${f}`),
  ...(manifest.version !== version ? [`version ${manifest.version} != ${version}`] : []),
  ...(manifest.private ? ['package is private'] : []),
  ...(manifest.license !== 'AGPL-3.0-only' || !/GNU AFFERO GENERAL PUBLIC LICENSE/.test(readFileSync(path.join(extract, 'package/LICENSE'), 'utf8')) ? [`license ${manifest.license} does not match LICENSE (AGPL-3.0-only)`] : []),
  ...(manifest.engines?.node !== '>=22.13.0' ? [`engines.node ${manifest.engines?.node} != >=22.13.0`] : []),
  ...(lifecycle.length ? [`install lifecycle scripts present: ${lifecycle.join(', ')}`] : []),
  ...(manifest.dependencies && Object.keys(manifest.dependencies).length ? [`unexpected hard dependencies: ${Object.keys(manifest.dependencies).join(', ')}`] : []),
  ...(report.tarball.bytes > 15e6 ? [`tarball ${report.tarball.bytes} bytes exceeds 15 MB budget`] : []),
];
record('contents', problems.length ? 'FAIL' : 'PASS', { files, optionalDependencies: manifest.optionalDependencies, note: problems.join('; ') || `${files.length} files, no lifecycle scripts` });

// ---- 3b. packaging parity & systemd commands -----------------------------------------------
const parityProblems = [];
const debControl = readFileSync(path.join(repo, 'packaging/deb/debian/control'), 'utf8');
if (!debControl.includes(`Version: ${version}`)) parityProblems.push(`deb control Version != ${version}`);
if (!debControl.includes('Depends: nodejs (>= 22.13.0) | nodejs-legacy (>= 22.13.0)')) parityProblems.push('deb control missing nodejs (>= 22.13.0)');

const rpmSpec = readFileSync(path.join(repo, 'packaging/rpm/wazir.spec'), 'utf8');
if (!new RegExp(`^Version:\\s+${version.replace(/\./g, '\\.')}$`, 'm').test(rpmSpec)) parityProblems.push(`rpm spec Version != ${version}`);
if (!rpmSpec.includes('License:        AGPL-3.0-only')) parityProblems.push('rpm spec License != AGPL-3.0-only');
if (!rpmSpec.includes('Requires:       nodejs >= 22.13.0')) parityProblems.push('rpm spec Requires != nodejs >= 22.13.0');

for (const hbRel of ['Formula/wazir.rb', 'packaging/homebrew/Formula/wazir.rb']) {
  const hb = readFileSync(path.join(repo, hbRel), 'utf8');
  if (!hb.includes(`version "${version}"`)) parityProblems.push(`${hbRel} version != ${version}`);
  if (!hb.includes('license "AGPL-3.0-only"')) parityProblems.push(`${hbRel} license != AGPL-3.0-only`);
}

for (const scoopRel of ['bucket/wazir.json', 'packaging/scoop/wazir.json']) {
  const scoop = JSON.parse(readFileSync(path.join(repo, scoopRel), 'utf8'));
  if (scoop.version !== version) parityProblems.push(`${scoopRel} version ${scoop.version} != ${version}`);
  if (scoop.license !== 'AGPL-3.0-only') parityProblems.push(`${scoopRel} license ${scoop.license} != AGPL-3.0-only`);
}

const pmVer = readFileSync(path.join(repo, 'packaging/package-manager-version.txt'), 'utf8').trim();
if (pmVer !== version) parityProblems.push(`package-manager-version.txt ${pmVer} != ${version}`);

const cargoToml = readFileSync(path.join(repo, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
if (!cargoToml.includes(`version = "${version}"`)) parityProblems.push(`Cargo.toml version != ${version}`);

const tauriConf = JSON.parse(readFileSync(path.join(repo, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
if (tauriConf.version !== version) parityProblems.push(`tauri.conf.json version ${tauriConf.version} != ${version}`);

for (const buildScriptRel of ['scripts/build-deb.mjs', 'scripts/build-rpm.mjs']) {
  const bs = readFileSync(path.join(repo, buildScriptRel), 'utf8');
  if (bs.includes('/usr/bin/wa worker start') || bs.includes('/usr/bin/wa api start')) {
    parityProblems.push(`${buildScriptRel} contains broken systemd ExecStart (wa worker/api start)`);
  }
  if (!bs.includes('/usr/bin/wa improve start --foreground --continuous') || !bs.includes('/usr/bin/wa dashboard --no-open')) {
    parityProblems.push(`${buildScriptRel} missing valid systemd ExecStart CLI commands`);
  }
}

record('packaging-parity', parityProblems.length ? 'FAIL' : 'PASS', {
  problems: parityProblems,
  note: parityProblems.join('; ') || `DEB, RPM, Homebrew, Scoop, Tauri, and systemd units aligned at v${version} (Node >=22.13.0, AGPL-3.0-only)`,
});

// ---- 4. secrets and private paths ----------------------------------------------------------
const SECRET_PATTERNS = [
  // Requires key material after the header (Wazir's own redactor contains a bare header).
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{64,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['developer home path', new RegExp(`${os.homedir().replace(/[\\/.]/g, (c) => `\\${c}`)}`)],
];
const hits = [];
for (const f of files) {
  const text = readFileSync(path.join(extract, 'package', f), 'utf8');
  for (const [label, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ file: f, kind: label, sample: `${m[0].slice(0, 12)}…` });
  }
}
record('secrets-scan', hits.length ? 'FAIL' : 'PASS', { hits, note: hits.length ? hits.map((h) => `${h.kind} in ${h.file}`).join('; ') : `${SECRET_PATTERNS.length} patterns, ${files.length} files` });

// ---- 5-7. install and smoke ----------------------------------------------------------------
const outside = path.join(work, 'outside'); // never inside the repository
mkdirSync(outside);
const home = path.join(work, 'wazir-home');
mkdirSync(home);
const env = { ...process.env, WAZIR_HOME: home, NO_COLOR: '1', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
delete env.WAZIR_IN_MEMORY;

function smoke(label, waCmd) {
  const wa = (...a) => run(waCmd, a, { cwd: outside, env, timeout: 180_000 });
  const results = {};
  const v = wa('--version');
  results.version = v.status === 0 && v.stdout.trim() === version ? 'PASS' : 'FAIL';
  const h = wa('--help');
  results.help = h.status === 0 && /Usage: wa/.test(h.stdout) ? 'PASS' : 'FAIL';
  const d = wa('doctor', '--json');
  let doctorOk = false;
  try { doctorOk = !!JSON.parse(d.stdout); } catch { /* not JSON */ }
  results.doctor = doctorOk ? 'PASS' : 'FAIL'; // exit 1 is expected when checks fail on a bare host
  const r = wa('resources', 'validate', '--json');
  let resOk = false;
  try { resOk = Array.isArray(JSON.parse(r.stdout).findings); } catch { /* not JSON */ }
  results.resources = resOk ? 'PASS' : 'FAIL';
  const failed = Object.entries(results).filter(([, s]) => s !== 'PASS').map(([k]) => k);
  record(`smoke:${label}`, failed.length ? 'FAIL' : 'PASS', { results, note: failed.length ? `failed: ${failed.join(', ')}; stderr: ${(v.stderr + h.stderr + d.stderr + r.stderr).slice(-600)}` : 'version, help, doctor --json, resources validate --json' });
  return !failed.length;
}

function optionalModules(label, nodeModules) {
  const out = {};
  for (const m of Object.keys(manifest.optionalDependencies ?? {})) {
    const probe = run(process.execPath, ['-e', `try{require(${JSON.stringify(m)});console.log('loaded')}catch(e){console.log('unavailable: '+e.message.split('\\n')[0])}`], { cwd: nodeModules, env });
    out[m] = probe.stdout.trim();
  }
  // Informational: optional modules may legitimately be unavailable (no prebuild, no compiler).
  record(`optional-modules:${label}`, 'PASS', { modules: out, note: Object.entries(out).map(([k, v]) => `${k}: ${v}`).join('; ') });
}

// global install into an isolated prefix
const prefix = path.join(work, 'prefix');
const g = run(npm, ['install', '-g', '--prefix', prefix, tarball], { env, cwd: outside });
const globalBin = win ? path.join(prefix, 'wa.cmd') : path.join(prefix, 'bin', 'wa');
const globalPkgDir = win ? path.join(prefix, 'node_modules', manifest.name) : path.join(prefix, 'lib', 'node_modules', manifest.name);
record('install:global', g.status === 0 && existsSync(globalBin) ? 'PASS' : 'FAIL', { note: g.status === 0 ? globalBin : g.stderr.slice(-800) });
if (g.status === 0) { smoke('global', globalBin); optionalModules('global', path.join(globalPkgDir, 'bin')); }

// local (non-global) project install, run through npx
const proj = path.join(work, 'project');
mkdirSync(proj);
writeFileSync(path.join(proj, 'package.json'), '{"name":"consumer","version":"1.0.0","private":true}');
const l = run(npm, ['install', tarball], { env, cwd: proj });
record('install:local', l.status === 0 ? 'PASS' : 'FAIL', { note: l.status === 0 ? 'npm install <tarball> in a project' : l.stderr.slice(-800) });
if (l.status === 0) smoke('local-npx', path.join(proj, 'node_modules', '.bin', win ? 'wa.cmd' : 'wa'));

// without optional native modules: the CLI must still work
const bare = path.join(work, 'bare');
mkdirSync(bare);
writeFileSync(path.join(bare, 'package.json'), '{"name":"bare","version":"1.0.0","private":true}');
const o = run(npm, ['install', '--omit=optional', tarball], { env, cwd: bare });
record('install:omit-optional', o.status === 0 ? 'PASS' : 'FAIL', { note: o.status === 0 ? 'npm install --omit=optional' : o.stderr.slice(-800) });
if (o.status === 0) {
  smoke('without-optional', path.join(bare, 'node_modules', '.bin', win ? 'wa.cmd' : 'wa'));
  optionalModules('without-optional', path.join(bare, 'node_modules', manifest.name, 'bin'));
}

// ---- 8. upgrade preserves user state -------------------------------------------------------
// User state written by the CLI itself plus files a user would have configured.
writeFileSync(path.join(home, 'resources.json'), JSON.stringify({ version: 1, policy: { enforce: true }, accounts: [] }));
writeFileSync(path.join(home, 'config.json'), JSON.stringify({ models: { startup: 'lazy' } }));
writeFileSync(path.join(home, 'agent-preflight.json'), JSON.stringify({ version: 1, results: { sentinel: { agent: 'sentinel', status: 'READY', detail: 'x', durationMs: 0, checkedAt: '2026-01-01T00:00:00Z' } } }));
const snapshot = () => Object.fromEntries(readdirSync(home).filter((f) => !/-(wal|shm)$/.test(f)).sort().map((f) => [f, statSync(path.join(home, f)).isFile() ? sha(path.join(home, f)) : 'dir']));
const before = snapshot();
const previous = opt('--previous');
if (previous) run(npm, ['install', '-g', '--prefix', prefix, previous], { env, cwd: outside });
const up = run(npm, ['install', '-g', '--prefix', prefix, tarball], { env, cwd: outside });
const afterUpgrade = snapshot();
const changed = Object.keys(before).filter((k) => before[k] !== afterUpgrade[k]);
record('upgrade:preserves-state', up.status === 0 && changed.length === 0 ? 'PASS' : 'FAIL', {
  note: up.status !== 0 ? up.stderr.slice(-500) : changed.length ? `changed: ${changed.join(', ')}` : `${Object.keys(before).length} files in WAZIR_HOME unchanged${previous ? ` (from ${path.basename(previous)})` : ' (reinstall over existing install)'}`,
});
if (up.status === 0) smoke('after-upgrade', globalBin);

// ---- 9. uninstall --------------------------------------------------------------------------
const stateBeforeUninstall = snapshot();
const un = run(npm, ['uninstall', '-g', '--prefix', prefix, manifest.name], { env, cwd: outside });
const leftover = existsSync(globalBin) || existsSync(globalPkgDir);
const stateAfter = snapshot();
const lost = Object.keys(stateBeforeUninstall).filter((k) => stateBeforeUninstall[k] !== stateAfter[k]);
record('uninstall', un.status === 0 && !leftover && lost.length === 0 ? 'PASS' : 'FAIL', {
  note: un.status !== 0 ? un.stderr.slice(-500) : leftover ? 'package files left behind' : lost.length ? `user state changed: ${lost.join(', ')}` : 'command and package removed; WAZIR_HOME untouched',
});

finish();

function finish() {
  report.durationMs = Date.now() - started;
  report.result = report.checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS';
  mkdirSync(path.join(repo, 'dist'), { recursive: true });
  const out = path.join(repo, 'dist', `package-check-${process.platform}-${process.arch}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n${report.result}: ${report.checks.filter((c) => c.status === 'PASS').length}/${report.checks.length} checks passed — ${out}`);
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
  process.exit(report.result === 'PASS' ? 0 : 1);
}

