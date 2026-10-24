#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: scripts/check-skills.sh [--json] [--smoke]\nChecks formal skills and any installed Claude copies. Smoke dependencies are optional.');
  process.exit(0);
}
if (args.some(a => !['--json', '--smoke'].includes(a))) {
  console.error('Unknown option. Use --help.');
  process.exit(2);
}
const definitions = [
  ['alloy', 'alloy-formal-modeling', 'alloy-formal-modeling', ['README.md', 'evals/challenges.md', ...['access-control', 'filesystem-tree', 'mutex-temporal', 'self-approval-counterexample', 'self-approval-fixed'].map(n => `examples/${n}.als`), ...['language', 'pitfalls', 'sources', 'temporal', 'workflow'].map(n => `references/${n}.md`), 'scripts/run-examples.sh']],
  ['z3', 'wazir-z3-constraint-verification', 'wazir-z3', ['examples/check_stopping_rule.py']],
  ['dafny', 'wazir-dafny-program-verification', 'wazir-dafny', ['examples/stop_command.dfy']],
  ['scenic', 'wazir-scenic-scenario-generation', 'wazir-scenic', ['examples/approach_scene.scenic', 'examples/sample_scenes.py']],
  ['verifai', 'wazir-verifai-falsification', 'wazir-verifai', ['examples/falsify_with_scenic.py']],
  ['gam', 'gam', 'gam', ['references/gal-json.md']],
];
const exists = p => fs.existsSync(path.join(root, p));
function checkSkill(base, name, files) {
  const details = [];
  for (const file of ['SKILL.md', ...files]) {
    try {
      if (!fs.statSync(path.join(root, base, file)).isFile()) details.push(`${file}: not a regular file`);
    } catch { details.push(`${file}: missing`); }
  }
  try {
    const body = fs.readFileSync(path.join(root, base, 'SKILL.md'), 'utf8');
    const fm = body.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!fm) details.push('SKILL.md: missing YAML frontmatter');
    else {
      const value = key => fm[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1].trim();
      if (value('name')?.replace(/^['"]|['"]$/g, '') !== name) details.push(`frontmatter name must be ${name}`);
      const desc = value('description');
      if (!desc || ['""', "''", 'null', '~'].includes(desc) || (/^[>|][-+\d]*$/.test(desc) && !/\n[ \t]+\S/.test(fm[1]))) details.push('frontmatter description must be nonempty');
    }
  } catch (e) { if (!details.some(d => d.startsWith('SKILL.md:'))) details.push(`SKILL.md: ${e.message}`); }
  return { name, path: base, status: details.length ? 'MISSING' : 'INSTALLED', details };
}
function checkJson(file, optional = false) {
  if (optional && !exists(file)) return { path: file, status: 'NOT_PRESENT', details: [] };
  try { JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); return { path: file, status: 'INSTALLED', details: [] }; }
  catch (e) { return { path: file, status: 'MISSING', details: [e.message] }; }
}
const skills = definitions.map(([short, name, , files]) => checkSkill(`skills/formal/${short}`, name, files));
const claude = definitions.filter(([, , folder]) => exists(`.claude/skills/${folder}`)).map(([, name, folder, files]) => checkSkill(`.claude/skills/${folder}`, name, files));
const assets = [checkJson('skills/formal/evidence.schema.json'), checkJson('skills/formal/manifest.json', true)];
if (claude.length) assets.push(checkJson('.claude/skills/evidence.schema.json'));
const smoke = [];
function run(command, argv, cwd = root, timeout = 120000) {
  return spawnSync(command, argv, { cwd, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
}
if (args.includes('--smoke')) {
  const python = process.env.PYTHON || (run('python3', ['--version']).status === 0 ? 'python3' : 'python');
  function test(name, required, available, command, argv, cwd) {
    const missing = required.filter(p => !exists(p));
    if (missing.length || !available()) {
      smoke.push({ name, status: 'NOT_RUN', details: missing.length ? `Missing: ${missing.join(', ')}` : 'Required tool or Python module unavailable' });
      return;
    }
    const result = run(command, argv, cwd);
    smoke.push({ name, status: result.status === 0 ? 'PASS' : 'FAIL', exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '', details: result.error?.message || '' });
  }
  const moduleAvailable = name => () => run(python, ['-c', `import ${name}`]).status === 0;
  for (const candidate of ['buggy', 'guarded']) test(`z3-${candidate}`, ['skills/formal/z3/examples/check_stopping_rule.py'], moduleAvailable('z3'), python, [path.join(root, 'skills/formal/z3/examples/check_stopping_rule.py'), '--candidate', candidate]);
  test('alloy', ['skills/formal/alloy/scripts/run-examples.sh', 'tools/alloy/org.alloytools.alloy.dist.jar'], () => run('java', ['-version']).status === 0, 'bash', [path.join(root, 'skills/formal/alloy/scripts/run-examples.sh'), path.join(root, 'tools/alloy/org.alloytools.alloy.dist.jar')]);
  test('dafny', ['skills/formal/dafny/examples/stop_command.dfy'], () => run('dafny', ['--version']).status === 0, 'dafny', ['verify', 'stop_command.dfy'], path.join(root, 'skills/formal/dafny/examples'));
  for (const [name, script] of [['scenic', 'sample_scenes.py'], ['verifai', 'falsify_with_scenic.py']]) test(name, [`skills/formal/${name}/examples/${script}`], moduleAvailable(name), python, [script], path.join(root, `skills/formal/${name}/examples`));
}
const ok = [...skills, ...claude, ...assets].every(s => s.status !== 'MISSING') && smoke.every(s => s.status !== 'FAIL');
const report = { version: 1, ok, skills, claude, assets, smoke };
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const item of [...skills, ...claude, ...assets, ...smoke]) {
    console.log(`${item.status} ${item.path || item.name}`);
    for (const detail of Array.isArray(item.details) ? item.details : [item.details]) if (detail) console.log(`  ${detail}`);
    if (item.status === 'FAIL') console.log(`  ${(item.stderr || item.stdout).trim()}`);
  }
  console.log(`Overall: ${ok ? 'PASS' : 'FAIL'}`);
}
process.exitCode = ok ? 0 : 1;
