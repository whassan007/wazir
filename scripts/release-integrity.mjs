/** Release metadata, artifact, and publication checks.  No network is used unless --latest is requested. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const args = process.argv.slice(2);
const get = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const fail = (message) => { console.error(`release-integrity: ${message}`); process.exitCode = 1; };

export function validateVersion(version, { requireStable = false } = {}) {
  if (!semver.test(version) || (requireStable && !stable.test(version))) throw new Error(`invalid ${requireStable ? 'stable ' : ''}semantic version: ${version}`);
  return version;
}
export function verifyChecksums(dir, manifest = 'SHA256SUMS.txt') {
  const file = path.join(dir, manifest);
  if (!existsSync(file)) throw new Error(`missing checksum manifest: ${file}`);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const match = /^(\S+)\s+[* ](.+)$/.exec(line);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    const target = path.join(dir, match[2]);
    if (!existsSync(target)) throw new Error(`checksum target is missing: ${match[2]}`);
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== match[1]) throw new Error(`checksum mismatch for ${match[2]} (expected ${match[1]}, got ${actual})`);
  }
  return true;
}
export function assertUniqueArtifacts(files) {
  const names = new Set();
  for (const file of files) { const name = path.basename(file); if (names.has(name)) throw new Error(`duplicate artifact name: ${name}`); names.add(name); }
  return true;
}
export function tagMatchesCommit(tag, expectedCommit) {
  const commit = execFileSync('git', ['rev-list', '-n', '1', tag], { cwd: root, encoding: 'utf8' }).trim();
  if (commit !== expectedCommit) throw new Error(`tag ${tag} resolves to ${commit}, expected ${expectedCommit}`);
  return true;
}

async function verifyLatest(tag) {
  const url = process.env.GITHUB_API_URL ? `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/releases/latest` : 'https://api.github.com/repos/whassan007/wazir/releases/latest';
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'wazir-release-integrity' };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`latest release API returned HTTP ${response.status}`);
  const latest = await response.json();
  if (latest.prerelease || latest.draft || latest.tag_name !== tag) throw new Error(`latest release is ${latest.tag_name ?? '<none>'} (draft=${latest.draft}, prerelease=${latest.prerelease}); expected qualified ${tag}`);
  console.log(`latest release verified: ${latest.tag_name}`);
}

async function main() {
  const version = get('--version') ?? pkg.version;
  validateVersion(version, { requireStable: args.includes('--stable') });
  const tag = get('--tag') ?? `v${version}`;
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match package version ${version}`);
  if (get('--commit')) tagMatchesCommit(tag, get('--commit'));
  if (get('--artifacts')) {
    const dir = path.resolve(get('--artifacts'));
    const files = readdirSync(dir).filter((f) => !f.endsWith('.sha256') && f !== 'SHA256SUMS.txt').map((f) => path.join(dir, f));
    assertUniqueArtifacts(files);
    verifyChecksums(dir);
    console.log(`artifacts verified: ${files.length}`);
  }
  if (args.includes('--latest')) await verifyLatest(tag);
  console.log(`release metadata verified: ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => fail(error.message));
