#!/usr/bin/env node
/**
 * Fails when any workspace's compiled `dist/` is older than its `src/`.
 *
 * The CLI (`wa`) and the API resolve sibling packages through their `dist`
 * output, so a stale build silently runs an older PolicyEngine than the one
 * the tests (which run against TypeScript source) just verified — the
 * operator believes a hardening change is active when it is not (security
 * review F-16). Run after `npm run build` in CI and before packaging.
 *
 *   node scripts/check-dist-fresh.mjs          # exit 1 on drift
 *   node scripts/check-dist-fresh.mjs --quiet
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const quiet = process.argv.includes('--quiet');

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

function workspaces() {
  const out = [];
  for (const group of ['packages', 'packages/runtimes', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src')) && existsSync(join(dir, 'tsconfig.json'))) {
        out.push(dir);
      }
    }
  }
  return out;
}

let stale = 0;
for (const dir of workspaces()) {
  const src = join(dir, 'src');
  const dist = join(dir, 'dist');
  const label = dir.slice(root.length + 1);
  if (!existsSync(dist)) {
    stale += 1;
    console.error(`STALE  ${label}: dist/ missing (run npm run build)`);
    continue;
  }
  const srcTime = newestMtime(src);
  const distTime = newestMtime(dist);
  if (distTime < srcTime) {
    stale += 1;
    console.error(`STALE  ${label}: src newer than dist by ${Math.round((srcTime - distTime) / 1000)}s`);
  } else if (!quiet) {
    console.log(`fresh  ${label}`);
  }
}

if (stale > 0) {
  console.error(`\n${stale} workspace(s) have a stale dist/. Run \`npm run build\`.`);
  process.exit(1);
}
