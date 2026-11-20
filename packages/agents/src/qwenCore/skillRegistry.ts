import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface SkillPack {
  name: string;
  description: string;
  skillPath: string;
  body: string;
  tags: string[];
}

export interface ProgressiveDocsMap {
  agentsSummary: string;
  linkedDocs: Array<{ relPath: string; content: string }>;
}

/**
 * Parses an AAIF `SKILL.md` file (YAML frontmatter `name`, `description` + markdown body).
 */
export function parseSkillMarkdown(raw: string, skillPath: string): SkillPack | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;

  const frontmatter = match[1];
  const body = match[2].trim();
  let name = '';
  let description = '';
  let tags: string[] = [];

  for (const line of frontmatter.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'name') name = val;
    else if (key === 'description') description = val;
    else if (key === 'tags') {
      tags = val.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  if (!name || !description) return undefined;
  return { name, description, skillPath, body, tags };
}

/**
 * Discovers `SKILL.md` packs under `.agents/skills`, `skills`, or `.wazir/skills`
 * and performs curated top-K retrieval per task (preventing raw-dump interference).
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillPack>();

  discoverFromRoots(roots: string[]): SkillPack[] {
    const loaded: SkillPack[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const dir = path.join(root, entry);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const skillFile = path.join(dir, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        try {
          const parsed = parseSkillMarkdown(readFileSync(skillFile, 'utf8'), skillFile);
          if (parsed) {
            this.skills.set(parsed.name, parsed);
            loaded.push(parsed);
          }
        } catch {
          // Ignore unreadable skill files.
        }
      }
    }
    return loaded;
  }

  register(skill: SkillPack): void {
    this.skills.set(skill.name, skill);
  }

  list(): SkillPack[] {
    return [...this.skills.values()];
  }

  /**
   * Curated lexical retrieval returning at most `topK` relevant skills for `query`
   * (Raven/SkillsBench pattern: curated index beats dumping all skills into context).
   */
  retrieveRelevant(query: string, topK = 3): SkillPack[] {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];

    const scored: Array<{ skill: SkillPack; score: number }> = [];
    for (const skill of this.skills.values()) {
      const hay = `${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (skill.name.toLowerCase().includes(tok)) score += 3;
        if (hay.includes(tok)) score += 1;
      }
      if (score > 0) scored.push({ skill, score });
    }

    scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
    return scored.slice(0, topK).map((s) => s.skill);
  }
}

/**
 * Progressive-disclosure loader for OpenAI-style ~100-line `AGENTS.md` maps:
 * keeps `AGENTS.md` concise and resolves referenced `docs/*.md` files on demand.
 */
export function loadProgressiveAgentsDocs(projectRoot: string, maxMapLines = 120): ProgressiveDocsMap | undefined {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (!existsSync(agentsPath)) return undefined;
  const raw = readFileSync(agentsPath, 'utf8');
  const lines = raw.split(/\r?\n/).slice(0, maxMapLines);
  const agentsSummary = lines.join('\n');

  const docRefs = new Set<string>();
  const linkRe = /(?:docs\/[a-zA-Z0-9_./-]+\.md)/g;
  for (const m of agentsSummary.matchAll(linkRe)) {
    docRefs.add(m[0]);
  }

  const linkedDocs: Array<{ relPath: string; content: string }> = [];
  for (const rel of docRefs) {
    const full = path.resolve(projectRoot, rel);
    if (!full.startsWith(path.resolve(projectRoot) + path.sep)) continue;
    if (!existsSync(full)) continue;
    try {
      linkedDocs.push({ relPath: rel, content: readFileSync(full, 'utf8') });
    } catch {
      // Ignore unreadable linked doc.
    }
  }

  return { agentsSummary, linkedDocs };
}
