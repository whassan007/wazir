import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateDir } from './storage.js';
import type { GitHubRelease, ReleaseAsset, UpdateChannel } from './types.js';

const RELEASES_API = 'https://api.github.com/repos/whassan007/wazir/releases';
const MAX_RELEASE_BYTES = 512 * 1024 * 1024;

export function parseSemver(value: string): [number, number, number, string] | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : undefined;
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a), right = parseSemver(b);
  if (!left || !right) throw new Error(`Invalid semantic version: ${!left ? a : b}`);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  if (left[3] === right[3]) return 0;
  if (!left[3]) return 1;
  if (!right[3]) return -1;
  const l = left[3].split('.'), r = right[3].split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined) return -1;
    if (r[i] === undefined) return 1;
    if (l[i] === r[i]) continue;
    const ln = /^\d+$/.test(l[i]!), rn = /^\d+$/.test(r[i]!);
    if (ln && rn) return Number(l[i]) < Number(r[i]) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l[i]! < r[i]! ? -1 : 1;
  }
  return 0;
}

export function platformArtifactNames(platform = process.platform, arch = process.arch, version?: string): string[] {
  const osName = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
  const archName = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!osName || !archName) return [];
  const v = version ? `v${version.replace(/^v/, '')}` : 'v*';
  return platform === 'win32' ? [`wazir-${v}-${osName}-${archName}.zip`] : [`wazir-${v}-${osName}-${archName}.tar.gz`];
}

export function chooseRelease(releases: GitHubRelease[], channel: UpdateChannel): GitHubRelease | undefined {
  const eligible = releases.filter((release) => !release.draft && (channel === 'stable' ? !release.prerelease : release.prerelease));
  eligible.sort((a, b) => compareSemver(b.tag_name, a.tag_name));
  return eligible[0];
}

function trustedReleasePage(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && /^\/whassan007\/wazir\/releases\/(?:tag|expanded_assets)\//.test(parsed.pathname); }
  catch { return false; }
}

function trustedReleaseAsset(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && /^\/whassan007\/wazir\/releases\/download\//.test(parsed.pathname); }
  catch { return false; }
}

function trustedDownloadResponseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (
      (parsed.hostname === 'github.com' && /^\/whassan007\/wazir\/releases\/download\//.test(parsed.pathname)) ||
      parsed.hostname === 'objects.githubusercontent.com' || parsed.hostname === 'release-assets.githubusercontent.com'
    );
  }
  catch { return false; }
}

export async function fetchReleases(channel: UpdateChannel, fetcher: typeof fetch = fetch): Promise<GitHubRelease[]> {
  const response = await fetcher(`${RELEASES_API}?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Wazir-Updater' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Official Wazir release lookup failed (HTTP ${response.status})`);
  const releases = await response.json() as GitHubRelease[];
  return releases.filter((release) => !release.draft && (channel === 'stable' ? !release.prerelease : release.prerelease));
}

export async function downloadAndVerifyAsset(release: GitHubRelease, artifactName: string, fetcher: typeof fetch = fetch): Promise<{ path: string; artifact: ReleaseAsset; sha256: string }> {
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name)) throw new Error('Release tag is not a valid Wazir semantic version');
  if (!trustedReleasePage(release.html_url)) throw new Error('Release origin is not the official Wazir GitHub release page');
  const artifact = release.assets.find((asset) => asset.name === artifactName && asset.size > 0 && asset.size <= MAX_RELEASE_BYTES);
  if (!artifact) throw new Error(`Release is missing expected artifact ${artifactName}`);
  const digestAsset = release.assets.find((asset) => asset.name === 'SHA256SUMS.txt');
  if (!digestAsset || !artifact.digest || !/^sha256:[a-f0-9]{64}$/i.test(artifact.digest)) throw new Error('Release is missing GitHub-authenticated SHA-256 integrity metadata');
  if (digestAsset.size <= 0 || digestAsset.size > 5 * 1024 * 1024) throw new Error('Release checksum manifest has an invalid size');
  if (!trustedReleaseAsset(artifact.browser_download_url) || !trustedReleaseAsset(digestAsset.browser_download_url)) throw new Error('Release artifact URL is outside the official Wazir GitHub release');

  const checksumResponse = await fetcher(digestAsset.browser_download_url, { signal: AbortSignal.timeout(20_000) });
  if (!checksumResponse.ok) throw new Error(`Release checksum download failed (HTTP ${checksumResponse.status})`);
  if (checksumResponse.url && !trustedDownloadResponseUrl(checksumResponse.url)) throw new Error('Release checksum download redirected outside the trusted GitHub origin');
  const sumsBytes = await readBoundedBody(checksumResponse, 5 * 1024 * 1024);
  if (sumsBytes.length > 5 * 1024 * 1024) throw new Error('Release checksum manifest exceeds the allowed size');
  if (digestAsset.digest) {
    if (!/^sha256:[a-f0-9]{64}$/i.test(digestAsset.digest)) throw new Error('Release checksum manifest has unsupported authenticated integrity metadata');
    const sumsHash = createHash('sha256').update(sumsBytes).digest('hex');
    if (sumsHash !== digestAsset.digest.slice('sha256:'.length).toLowerCase()) throw new Error('Release checksum manifest does not match GitHub asset digest');
  }
  const sums = sumsBytes.toString('utf8');
  const destination = path.join(updateDir(), `${release.tag_name}-${artifact.name}`);
  let actual: string | undefined;
  if (existsSync(destination) && statSync(destination).size === artifact.size) actual = createHash('sha256').update(readFileSync(destination)).digest('hex');
  if (!actual || actual !== artifact.digest!.slice('sha256:'.length).toLowerCase()) {
    if (existsSync(destination)) rmSync(destination, { force: true });
    const artifactResponse = await fetcher(artifact.browser_download_url, { signal: AbortSignal.timeout(180_000) });
    if (!artifactResponse.ok) throw new Error(`Release artifact download failed (HTTP ${artifactResponse.status})`);
    if (artifactResponse.url && !trustedDownloadResponseUrl(artifactResponse.url)) throw new Error('Release artifact download redirected outside the trusted GitHub origin');
    const bytes = await readBoundedBody(artifactResponse, MAX_RELEASE_BYTES, artifact.size);
    if (bytes.length !== artifact.size || bytes.length > MAX_RELEASE_BYTES) throw new Error('Downloaded release size does not match authenticated GitHub metadata');
    actual = createHash('sha256').update(bytes).digest('hex');
    const gitHubDigest = artifact.digest!.slice('sha256:'.length).toLowerCase();
    if (actual !== gitHubDigest) throw new Error('Downloaded release checksum does not match GitHub asset digest');
    mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o600 });
  }
  const gitHubDigest = artifact.digest!.slice('sha256:'.length).toLowerCase();
  if (actual !== gitHubDigest) throw new Error('Staged release checksum does not match GitHub asset digest');
  const match = sums.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())).find((row) => row?.[2] === artifact.name);
  if (!match || match[1]!.toLowerCase() !== actual) throw new Error('Downloaded release checksum does not match the official SHA256SUMS.txt asset');
  mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
  return { path: destination, artifact, sha256: actual! };
}

async function readBoundedBody(response: Response, limit: number, expected?: number): Promise<Buffer> {
  if (!response.body) throw new Error('Release response has no body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit || (expected !== undefined && size > expected)) {
        await reader.cancel();
        throw new Error('Release response exceeded its authenticated size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function downloadAndVerifyRelease(release: GitHubRelease, fetcher: typeof fetch = fetch): Promise<{ path: string; artifact: ReleaseAsset; sha256: string }> {
  const names = platformArtifactNames(process.platform, process.arch, release.tag_name);
  const artifact = release.assets.find((asset) => names.includes(asset.name));
  if (!artifact) throw new Error(`No standalone artifact is published for ${os.platform()}/${os.arch()}`);
  return downloadAndVerifyAsset(release, artifact.name, fetcher);
}
