import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface UserCustomCommandDefinition {
  name: string;
  description: string;
  command: string;
  tier?: 0 | 1 | 2 | 3;
  mode?: 'shell' | 'ai' | 'workflow';
  cwd?: string;
  confirm?: boolean;
  aliases?: string[];
  source?: 'manifest' | 'bin';
  filePath?: string;
}

const VALID_CUSTOM_COMMAND_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function resolveUserCommandsDir(
  wazirHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = wazirHome || env.WAZIR_HOME || path.join(os.homedir(), '.wazir');
  return path.join(home, 'commands');
}

export function resolveUserBinDir(
  wazirHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = wazirHome || env.WAZIR_HOME || path.join(os.homedir(), '.wazir');
  return path.join(home, 'bin');
}

export function validateCustomCommandName(name: string): string {
  const trimmed = name.trim();
  if (!VALID_CUSTOM_COMMAND_NAME.test(trimmed) || trimmed.includes('..')) {
    throw new Error(
      `Invalid custom command name '${name}'. Use 1-64 alphanumeric, '.', '_', or '-' characters.`,
    );
  }
  return trimmed;
}

export function listUserCustomCommands(options: {
  wazirHome?: string;
  env?: NodeJS.ProcessEnv;
} = {}): UserCustomCommandDefinition[] {
  const commandsDir = resolveUserCommandsDir(options.wazirHome, options.env);
  const binDir = resolveUserBinDir(options.wazirHome, options.env);
  const byName = new Map<string, UserCustomCommandDefinition>();

  if (fs.existsSync(commandsDir)) {
    try {
      const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const fullPath = path.join(commandsDir, entry.name);
        try {
          const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as Partial<UserCustomCommandDefinition>;
          const fallbackName = entry.name.slice(0, -5);
          const name = validateCustomCommandName(raw.name || fallbackName);
          if (typeof raw.command !== 'string' || !raw.command.trim()) continue;
          byName.set(name, {
            name,
            description: typeof raw.description === 'string' && raw.description.trim()
              ? raw.description.trim()
              : `Custom command: ${raw.command.trim()}`,
            command: raw.command.trim(),
            tier: raw.tier ?? 0,
            mode: raw.mode === 'ai' || raw.mode === 'workflow' ? raw.mode : 'shell',
            ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
            ...(typeof raw.confirm === 'boolean' ? { confirm: raw.confirm } : {}),
            ...(Array.isArray(raw.aliases)
              ? { aliases: raw.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0) }
              : {}),
            source: 'manifest',
            filePath: fullPath,
          });
        } catch {
          // Ignore malformed user command manifests
        }
      }
    } catch {
      // Ignore unreadable directory
    }
  }

  if (fs.existsSync(binDir)) {
    try {
      const entries = fs.readdirSync(binDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const fullPath = path.join(binDir, entry.name);
        try {
          const name = validateCustomCommandName(entry.name);
          if (byName.has(name)) continue;
          const st = fs.statSync(fullPath);
          const isExecutable = process.platform === 'win32' || (st.mode & 0o111) !== 0;
          if (!isExecutable) continue;
          byName.set(name, {
            name,
            description: `Executable script in ~/.wazir/bin/${entry.name}`,
            command: `"${fullPath}"`,
            tier: 0,
            mode: 'shell',
            source: 'bin',
            filePath: fullPath,
          });
        } catch {
          // Ignore invalid bin entries
        }
      }
    } catch {
      // Ignore unreadable bin directory
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getUserCustomCommand(
  nameOrAlias: string,
  options: { wazirHome?: string; env?: NodeJS.ProcessEnv } = {},
): UserCustomCommandDefinition | null {
  const needle = nameOrAlias.trim();
  if (!needle) return null;
  const commands = listUserCustomCommands(options);
  for (const cmd of commands) {
    if (cmd.name === needle || cmd.aliases?.includes(needle)) {
      return cmd;
    }
  }
  return null;
}

export function saveUserCustomCommand(
  input: Omit<UserCustomCommandDefinition, 'source' | 'filePath'>,
  options: { wazirHome?: string; env?: NodeJS.ProcessEnv } = {},
): UserCustomCommandDefinition {
  const name = validateCustomCommandName(input.name);
  const commandText = input.command.trim();
  if (!commandText) {
    throw new Error('Custom command text cannot be empty.');
  }
  const commandsDir = resolveUserCommandsDir(options.wazirHome, options.env);
  fs.mkdirSync(commandsDir, { recursive: true });
  const filePath = path.join(commandsDir, `${name}.json`);
  const record: UserCustomCommandDefinition = {
    name,
    description: input.description?.trim() || `Custom command: ${commandText}`,
    command: commandText,
    tier: input.tier ?? 0,
    mode: input.mode ?? 'shell',
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return {
    ...record,
    source: 'manifest',
    filePath,
  };
}

export function removeUserCustomCommand(
  name: string,
  options: { wazirHome?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const safeName = validateCustomCommandName(name);
  const filePath = path.join(resolveUserCommandsDir(options.wazirHome, options.env), `${safeName}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function expandUserCustomCommand(
  def: UserCustomCommandDefinition,
  rawArgs: string,
): string {
  const trimmedArgs = rawArgs.trim();
  if (def.command.includes('{{args}}')) {
    return def.command.replaceAll('{{args}}', trimmedArgs).trim();
  }
  return trimmedArgs ? `${def.command} ${trimmedArgs}` : def.command;
}
