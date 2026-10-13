#!/usr/bin/env node
/**
 * Cross-platform smoke test for Wazir CLI launcher.
 * Verifies wa commands outside repository directory and with spaces in paths.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

console.log('==> Wazir CLI Smoke Test Suite');
console.log(`    Platform: ${process.platform} (${os.arch()})`);
console.log(`    Node: ${process.version}`);

// Resolve wa command
function resolveWaCommand() {
  // 1. Check custom WAZIR_BIN_DIR or default install dirs
  const candidateDirs = [];
  if (process.env.WAZIR_BIN_DIR) {
    candidateDirs.push(process.env.WAZIR_BIN_DIR);
  }
  if (isWin) {
    candidateDirs.push(path.join(os.homedir(), '.wazir', 'bin'));
  } else {
    candidateDirs.push(path.join(os.homedir(), '.local', 'bin'));
  }

  for (const dir of candidateDirs) {
    if (isWin) {
      const cmdPath = path.join(dir, 'wa.cmd');
      if (existsSync(cmdPath)) return { cmd: cmdPath, args: [] };
      const exePath = path.join(dir, 'wa.exe');
      if (existsSync(exePath)) return { cmd: exePath, args: [] };
    } else {
      const binPath = path.join(dir, 'wa');
      if (existsSync(binPath)) return { cmd: binPath, args: [] };
    }
  }

  // 2. Check system PATH
  const whichCmd = isWin ? 'where.exe' : 'which';
  const check = spawnSync(whichCmd, ['wa'], { encoding: 'utf8' });
  if (check.status === 0 && check.stdout.trim()) {
    const firstLine = check.stdout.trim().split(/\r?\n/)[0];
    return { cmd: firstLine, args: [] };
  }

  // 3. Fallback to repository bundle
  const repoBundle = path.join(repoRoot, 'bin', 'wa.js');
  if (existsSync(repoBundle)) {
    console.log(`    Note: wa not found on PATH or install dirs; testing repository bundle: ${repoBundle}`);
    return { cmd: process.execPath, args: [repoBundle] };
  }

  throw new Error('Could not find wa launcher or bin/wa.js bundle.');
}

const launcher = resolveWaCommand();
console.log(`    Launcher: ${launcher.cmd} ${launcher.args.join(' ')}`);

// Setup test directories outside repo and with spaces
const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'wazir-smoke-'));
const normalDir = path.join(tmpBase, 'outside-repo');
const spaceDir = path.join(tmpBase, 'path with spaces and unicode 🚀');

mkdirSync(normalDir, { recursive: true });
mkdirSync(spaceDir, { recursive: true });

const testCases = [
  {
    name: 'wa --help',
    args: ['--help'],
    check: (out) => out.includes('Usage: wa') && out.includes('Commands:'),
    allowExitCodes: [0],
  },
  {
    name: 'wa doctor',
    args: ['doctor'],
    check: (out) => out.includes('Wazir Doctor') && out.includes('Summary:'),
    // Exit code 0 (all pass) or 1 (warnings on fresh system without local LLM running)
    allowExitCodes: [0, 1],
  },
  {
    name: 'wa status',
    args: ['status'],
    check: (out) => out.includes('Control Plane') || out.includes('System is operational'),
    allowExitCodes: [0],
  },
  {
    name: 'wa agents list',
    args: ['agents', 'list'],
    check: (out) => out.includes('wazir-coding') || out.includes('name'),
    allowExitCodes: [0],
  },
  {
    name: 'wa models list',
    args: ['models', 'list'],
    check: (out) => out.includes('WAZIR MODELS') || out.includes('MODEL') || out.includes('Fleet Capacity'),
    allowExitCodes: [0],
  },
  {
    name: 'wa resources',
    args: ['resources'],
    check: (out) => out.includes('Wazir resources') || out.includes('Accounts'),
    allowExitCodes: [0],
  },
];

let failed = 0;

for (const testDir of [normalDir, spaceDir]) {
  const isSpaces = testDir === spaceDir;
  console.log(`\n==> Testing from ${isSpaces ? 'directory with spaces' : 'standard directory outside repo'}:`);
  console.log(`    CWD: "${testDir}"`);

  for (const tc of testCases) {
    const fullArgs = [...launcher.args, ...tc.args];
    const proc = spawnSync(launcher.cmd, fullArgs, {
      cwd: testDir,
      encoding: 'utf8',
      shell: isWin,
      env: {
        ...process.env,
        // Ensure WAZIR_BIN_DIR is present for detection if needed
        PATH: process.env.PATH,
      },
    });

    const output = (proc.stdout || '') + (proc.stderr || '');
    const exitCode = proc.status ?? -1;
    const okCode = tc.allowExitCodes.includes(exitCode);
    const okOutput = tc.check(output);

    if (okCode && okOutput) {
      console.log(`  ✓ ${tc.name} (exit ${exitCode})`);
    } else {
      failed++;
      console.error(`  ✗ ${tc.name} FAILED (exit ${exitCode})`);
      if (!okCode) {
        console.error(`    Unexpected exit code: expected [${tc.allowExitCodes.join(', ')}], got ${exitCode}`);
      }
      if (!okOutput) {
        console.error('    Output check failed. Raw output preview:');
        console.error(output.slice(0, 500));
      }
    }
  }
}

// Cleanup
try {
  rmSync(tmpBase, { recursive: true, force: true });
} catch {}

if (failed > 0) {
  console.error(`\nSmoke test finished with ${failed} failure(s).`);
  process.exit(1);
}

console.log('\n✓ All CLI smoke tests passed successfully!');
process.exit(0);
