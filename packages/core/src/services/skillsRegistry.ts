import * as fs from 'node:fs/promises';
import { parse } from 'node:path';
import type { AgentDescriptor, TaskType } from '../types/index.js';

export interface SkillFrontmatter {
  name: string;
  description?: string;
  version?: string;
  capabilities?: string[];
  taskTypes?: string[];
}

export interface Skill {
  id: string;
  path: string;
  frontmatter: SkillFrontmatter;
  content: string;
}

export interface SkillsRegistryOptions {
  basePath?: string;
  watch?: boolean;
}

const DEFAULT_BASE_PATH = '.wazir/skills';

export class SkillsRegistry {
  private readonly basePath: string;
  private readonly skills = new Map<string, Skill>();

  constructor(options: SkillsRegistryOptions = {}) {
    this.basePath = options.basePath ?? DEFAULT_BASE_PATH;
  }

  async discover(): Promise<Skill[]> {
    const skillFiles = await this.findSkillFiles(this.basePath);
    const loadedSkills: Skill[] = [];

    for (const file of skillFiles) {
      try {
        const skill = await this.loadSkill(file);
        if (skill) {
          loadedSkills.push(skill);
          this.skills.set(skill.frontmatter.name, skill);
        }
      } catch {
        // Skip malformed skills
      }
    }

    return loadedSkills;
  }

  async reload(): Promise<Skill[]> {
    this.skills.clear();
    return this.discover();
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values()).sort((a, b) =>
      a.frontmatter.name.localeCompare(b.frontmatter.name),
    );
  }

  toAgentDescriptors(): AgentDescriptor[] {
    return this.list().map((skill) => ({
      name: skill.frontmatter.name,
      version: skill.frontmatter.version ?? '1.0.0',
      description: skill.frontmatter.description ?? '',
      capabilities: skill.frontmatter.capabilities ?? [],
      requiredTools: [],
      optionalTools: [],
      modelRequirements: {
        minimumContextTokens: 4096,
        minimumGPUMemoryGB: undefined,
        reasoning: false,
        toolCalling: false,
        vision: false,
      },
      permissions: [],
      taskTypes: (skill.frontmatter.taskTypes ?? ['chat']) as TaskType[],
      strategy: 'default',
    }));
  }

  async findSkillFiles(path: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subfiles = await this.findSkillFiles(`${path}/${entry.name}`);
          files.push(...subfiles);
        } else if (this.isSkillFile(entry.name)) {
          files.push(`${path}/${entry.name}`);
        }
      }

      return files;
    } catch {
      return [];
    }
  }

  private isSkillFile(filename: string): boolean {
    const ext = parse(filename).ext.toLowerCase();
    return ext === '.md' || ext === '.markdown';
  }

  private async loadSkill(path: string): Promise<Skill | null> {
    try {
      const content = await fs.readFile(path, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);

      if (!frontmatter.name) {
        return null;
      }

      return {
        id: path,
        path,
        frontmatter,
        content: body,
      };
    } catch {
      return null;
    }
  }

  private parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
    const lines = content.split('\n');
    let inFrontmatter = false;
    let frontmatterLines: string[] = [];
    let bodyLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (i === 0 && line.trim() === '---') {
        inFrontmatter = true;
        continue;
      }

      if (inFrontmatter) {
        if (line.trim() === '---') {
          inFrontmatter = false;
        } else {
          frontmatterLines.push(line);
        }
      } else {
        bodyLines.push(line);
      }
    }

    const frontmatter = this.parseYAML(frontmatterLines.join('\n'));
    const body = bodyLines.join('\n');

    return { frontmatter, body };
  }

  private parseYAML(yaml: string): SkillFrontmatter {
    const result: Partial<SkillFrontmatter> = {};

    for (const line of yaml.split('\n')) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) {
        const key = match[1];
        let value = match[2].trim();

        // Parse arrays
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1);
          result[key as keyof SkillFrontmatter] = value.split(',').map((v) => v.trim()) as any;
        } else {
          result[key as keyof SkillFrontmatter] = value as any;
        }
      }
    }

    return result as SkillFrontmatter;
  }
}

export function createSkillsRegistry(options: SkillsRegistryOptions = {}): SkillsRegistry {
  return new SkillsRegistry(options);
}
