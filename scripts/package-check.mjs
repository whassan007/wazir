#!/usr/bin/env node
import { readFileSync, statSync, accessSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

console.log('==> Running package:check — validating npm package metadata and contents...');

const pkgPath = resolve(rootDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// 1. Validate required fields
const requiredFields = ['name', 'version', 'description', 'license', 'repository', 'homepage', 'bugs', 'engines', 'bin'];
const missing = requiredFields.filter(f => !pkg[f]);
if (missing.length > 0) {
  console.error(`✗ Missing required package.json fields: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`✓ Required package.json fields present (${requiredFields.join(', ')})`);

// 2. Validate SemVer
const semverRegex = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (!semverRegex.test(pkg.version)) {
  console.error(`✗ Invalid semver version: ${pkg.version}`);
  process.exit(1);
}
console.log(`✓ Canonical version is valid SemVer: ${pkg.version}`);

// 3. Validate engines
if (!pkg.engines?.node) {
  console.error('✗ Missing engines.node requirement');
  process.exit(1);
}
console.log(`✓ Node.js engine requirement declared: ${pkg.engines.node}`);

// 4. Validate CLI binary exists and is executable
const binRel = pkg.bin?.wa || pkg.bin;
if (!binRel) {
  console.error('✗ Missing bin.wa mapping');
  process.exit(1);
}
const binPath = resolve(rootDir, binRel);
try {
  accessSync(binPath, constants.R_OK);
  const head = readFileSync(binPath, 'utf8').slice(0, 100);
  if (!head.startsWith('#!/usr/bin/env node')) {
    console.error(`✗ ${binRel} is missing '#!/usr/bin/env node' shebang`);
    process.exit(1);
  }
} catch (err) {
  console.error(`✗ CLI binary ${binRel} not readable: ${err.message}`);
  process.exit(1);
}
console.log(`✓ CLI binary ${binRel} exists with valid node shebang`);

// 5. Inspect npm pack contents
let packJson;
try {
  const raw = execSync('npm pack --dry-run --json', { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  packJson = JSON.parse(raw);
} catch (err) {
  console.error(`✗ npm pack --dry-run failed: ${err.message}`);
  process.exit(1);
}

const files = packJson[0]?.files?.map(f => f.path) || [];
console.log(`✓ Pack contents (${files.length} files):`);
for (const f of files) {
  console.log(`    - ${f}`);
}

// Ensure no sensitive or unwanted files are packaged
const forbiddenPatterns = [
  /\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.db$/i,
  /\.sqlite/i,
  /^tests\//i,
  /\.test\.[tj]s$/i,
  /^docs\//i,
  /^\.github\//i,
  /\.map$/i, // Source maps omitted from minimal publish
];

const forbiddenFound = files.filter(path => forbiddenPatterns.some(p => p.test(path)));
if (forbiddenFound.length > 0) {
  console.error(`✗ Forbidden or private files found in package: ${forbiddenFound.join(', ')}`);
  process.exit(1);
}
console.log('✓ No private files, credentials, tests, or unnecessary artifacts found in package');

const totalBytes = packJson[0]?.size || 0;
console.log(`✓ Packed tarball size: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);

console.log('✓ package:check PASSED — npm package is clean, secure, and ready for distribution.');
