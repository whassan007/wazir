import { assert, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_ROOT, getSkillPaths, listSkills, loadSkillContext, resolveSkill, verifyManifest } from './index.mjs';

test('manifest matches the files on disk', () => {
  assert.deepStrictEqual(verifyManifest(), []);
});

test('every tool id resolves to its own SKILL.md', () => {
  const tools = ['alloy', 'z3', 'dafny', 'scenic', 'verifai', 'gam'];
  assert.deepStrictEqual(listSkills().map((s) => s.id).sort(), [...tools].sort());
  for (const tool of tools) {
    const paths = getSkillPaths(tool);
    assert.strictEqual(paths.skill, path.join(SKILLS_ROOT, tool, 'SKILL.md'));
    assert.ok(fs.existsSync(paths.skill));
  }
});

test('task types, aliases and frontmatter names resolve case-insensitively', () => {
  assert.strictEqual(resolveSkill('braking-envelope').id, 'z3');
  assert.strictEqual(resolveSkill('Right of Way').id, 'alloy');
  assert.strictEqual(resolveSkill('wazir-verifai-falsification').id, 'verifai');
  assert.strictEqual(resolveSkill('alloy-formal-modeling').id, 'alloy');
  assert.strictEqual(resolveSkill('gal_json').id, 'gam');
  assert.strictEqual(resolveSkill('no-such-task'), undefined);
  assert.throws(() => getSkillPaths('no-such-task'), /Unknown formal skill/);
});

test('loadSkillContext puts SKILL.md first, then references', () => {
  const context = loadSkillContext('alloy');
  assert.strictEqual(context.name, 'alloy-formal-modeling');
  assert.strictEqual(context.files[0].path, 'alloy/SKILL.md');
  assert.strictEqual(context.files.length, 6);
  assert.match(context.text, /^<!-- skills\/formal\/alloy\/SKILL\.md -->\n---\nname: alloy-formal-modeling/);

  const bare = loadSkillContext('gam', { references: false });
  assert.deepStrictEqual(bare.files.map((f) => f.path), ['gam/SKILL.md']);

  const withExamples = loadSkillContext('dafny', { examples: true });
  assert.deepStrictEqual(withExamples.files.map((f) => f.path), ['dafny/SKILL.md', 'evidence.schema.json', 'dafny/examples/stop_command.dfy']);
});

test('upstream bundle layouts resolve to the same files', () => {
  for (const [compat, real] of [
    ['alloy-formal-modeling/SKILL.md', 'alloy/SKILL.md'],
    ['wazir-formal-assurance-skills/skills/z3/SKILL.md', 'z3/SKILL.md'],
    ['wazir-formal-assurance-skills/evidence.schema.json', 'evidence.schema.json'],
    ['wazir-formal-assurance-skills/scripts/validate_skills.py', 'scripts/validate_skills.py'],
  ]) {
    assert.strictEqual(fs.realpathSync(path.join(SKILLS_ROOT, compat)), fs.realpathSync(path.join(SKILLS_ROOT, real)));
  }
});
