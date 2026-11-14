#!/usr/bin/env node
// Loader for the vendored formal-assurance skills (see README.md, manifest.json).
// Resolves a tool, task type, alias or skill name to its SKILL.md and reference
// files, and assembles them into a text block a Wazir worker can put in context.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(SKILLS_ROOT, 'manifest.json');

let cached;

export function loadManifest() {
  cached ??= JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return cached;
}

const normalize = (key) => String(key).trim().toLowerCase().replace(/[\s_]+/g, '-');

// Every key (tool id, frontmatter name, alias, task type) must map to exactly one skill.
function buildIndex(manifest) {
  const index = new Map();
  for (const [id, entry] of Object.entries(manifest.skills)) {
    for (const key of [id, entry.name, entry.dir, ...entry.aliases, ...entry.taskTypes]) {
      const k = normalize(key);
      const owner = index.get(k);
      if (owner && owner !== id) throw new Error(`skills/formal/manifest.json: key "${k}" maps to both ${owner} and ${id}`);
      index.set(k, id);
    }
  }
  return index;
}

export function listSkills() {
  return Object.entries(loadManifest().skills).map(([id, entry]) => ({ id, ...entry }));
}

/** Resolve a tool id, task type, alias or frontmatter name. Returns undefined if unknown. */
export function resolveSkill(key) {
  const manifest = loadManifest();
  const id = buildIndex(manifest).get(normalize(key));
  return id && { id, ...manifest.skills[id] };
}

function requireSkill(key) {
  const skill = resolveSkill(key);
  if (!skill) {
    const known = Object.keys(loadManifest().skills).join(', ');
    throw new Error(`Unknown formal skill or task type "${key}" (tools: ${known})`);
  }
  return skill;
}

/** Absolute paths for a skill: SKILL.md first, then references in load order. */
export function getSkillPaths(key) {
  const skill = requireSkill(key);
  const abs = (p) => path.join(SKILLS_ROOT, p);
  return {
    id: skill.id,
    name: skill.name,
    dir: abs(skill.dir),
    skill: abs(skill.skill),
    references: skill.references.map(abs),
    examples: skill.examples.map(abs),
    scripts: skill.scripts.map(abs),
    evidenceSchema: abs(loadManifest().evidenceSchema),
  };
}

/**
 * Read a skill for worker context.
 * @param {string} key tool id, task type, alias or skill name
 * @param {{ references?: boolean, examples?: boolean }} [options]
 * @returns {{ id: string, name: string, files: { path: string, content: string }[], text: string }}
 */
export function loadSkillContext(key, { references = true, examples = false } = {}) {
  const paths = getSkillPaths(key);
  const selected = [paths.skill, ...(references ? paths.references : []), ...(examples ? paths.examples : [])];
  const files = selected.map((file) => ({
    path: path.relative(SKILLS_ROOT, file),
    content: fs.readFileSync(file, 'utf8'),
  }));
  const text = files
    .map(({ path: rel, content }) => `<!-- skills/formal/${rel} -->\n${content.trimEnd()}\n`)
    .join('\n');
  return { id: paths.id, name: paths.name, files, text };
}

/** Check that the manifest is unambiguous and matches the files on disk. Returns a list of problems. */
export function verifyManifest() {
  const manifest = loadManifest();
  const problems = [];
  try {
    buildIndex(manifest);
  } catch (error) {
    problems.push(error.message);
  }
  const exists = (p) => fs.existsSync(path.join(SKILLS_ROOT, p));
  if (!exists(manifest.evidenceSchema)) problems.push(`missing ${manifest.evidenceSchema}`);
  for (const [id, entry] of Object.entries(manifest.skills)) {
    for (const p of [entry.skill, ...entry.references, ...entry.examples, ...entry.scripts, ...entry.evals]) {
      if (!exists(p)) problems.push(`${id}: missing ${p}`);
    }
    const skillText = exists(entry.skill) ? fs.readFileSync(path.join(SKILLS_ROOT, entry.skill), 'utf8') : '';
    const name = /^name:\s*(\S+)/m.exec(skillText)?.[1];
    if (name !== entry.name) problems.push(`${id}: SKILL.md frontmatter name is ${name}, manifest says ${entry.name}`);
    const refDir = path.join(SKILLS_ROOT, entry.dir, 'references');
    if (fs.existsSync(refDir)) {
      for (const file of fs.readdirSync(refDir).filter((f) => f.endsWith('.md'))) {
        const rel = `${entry.dir}/references/${file}`;
        if (!entry.references.includes(rel)) problems.push(`${id}: ${rel} is not listed in references`);
      }
    }
  }
  return problems;
}

function main(argv) {
  const [first, ...rest] = argv;
  if (!first || first === '--help') {
    console.log('Usage: node skills/formal/index.mjs --list | --check | --paths <key> | <key> [--no-references] [--examples]');
    return first ? 0 : 2;
  }
  if (first === '--list') {
    for (const s of listSkills()) console.log(`${s.id.padEnd(8)} ${s.name.padEnd(34)} ${s.taskTypes.join(', ')}`);
    return 0;
  }
  if (first === '--check') {
    const problems = verifyManifest();
    for (const problem of problems) console.error(`FAIL ${problem}`);
    if (!problems.length) console.log(`OK manifest (${listSkills().length} skills)`);
    return problems.length ? 1 : 0;
  }
  if (first === '--paths') {
    console.log(JSON.stringify(getSkillPaths(rest[0]), null, 2));
    return 0;
  }
  const context = loadSkillContext(first, {
    references: !rest.includes('--no-references'),
    examples: rest.includes('--examples'),
  });
  process.stdout.write(context.text);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
