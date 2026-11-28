export type FleetModelVerb = 'add' | 'remove' | 'update' | 'reload';
export type FleetRuntimeKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'mlx' | 'vllm' | 'openaiCompatible';
export type FleetExecutionModeOverride = 'dryRun' | 'live';

export type FleetHostTarget =
  | { kind: 'all' }
  | { kind: 'hosts'; hosts: string[] };

export interface FleetModelCommand {
  verb: FleetModelVerb;
  models: string[];
  target: FleetHostTarget;
  runtime?: FleetRuntimeKind;
  mode?: FleetExecutionModeOverride;
}

export type ParsedFleetCommand =
  | { type: 'model'; command: FleetModelCommand }
  | { type: 'refresh'; target: FleetHostTarget }
  | { type: 'list'; target: FleetHostTarget }
  | { type: 'help' };

export class FleetParseError extends Error {
  constructor(
    public readonly code:
      | 'EMPTY'
      | 'UNKNOWN_VERB'
      | 'MISSING_MODEL'
      | 'MISSING_HOST'
      | 'INVALID_MODEL_NAME'
      | 'INVALID_HOST_NAME'
      | 'UNKNOWN_RUNTIME'
      | 'MISSING_VALUE'
      | 'CONFLICTING_RUNTIMES'
      | 'CONFLICTING_MODES'
      | 'UNEXPECTED',
    message: string,
  ) {
    super(message);
    this.name = 'FleetParseError';
  }
}

const VERB_MAP: Record<string, { type: 'model'; verb: FleetModelVerb } | { type: 'refreshish' | 'list' | 'help' }> = {
  add: { type: 'model', verb: 'add' },
  pull: { type: 'model', verb: 'add' },
  download: { type: 'model', verb: 'add' },
  install: { type: 'model', verb: 'add' },
  get: { type: 'model', verb: 'add' },
  fetch: { type: 'model', verb: 'add' },
  deploy: { type: 'model', verb: 'add' },
  remove: { type: 'model', verb: 'remove' },
  delete: { type: 'model', verb: 'remove' },
  rm: { type: 'model', verb: 'remove' },
  uninstall: { type: 'model', verb: 'remove' },
  drop: { type: 'model', verb: 'remove' },
  purge: { type: 'model', verb: 'remove' },
  del: { type: 'model', verb: 'remove' },
  erase: { type: 'model', verb: 'remove' },
  update: { type: 'model', verb: 'update' },
  upgrade: { type: 'model', verb: 'update' },
  repull: { type: 'model', verb: 'update' },
  're-pull': { type: 'model', verb: 'update' },
  redownload: { type: 'model', verb: 'update' },
  reload: { type: 'model', verb: 'reload' },
  restart: { type: 'model', verb: 'reload' },
  load: { type: 'model', verb: 'reload' },
  warm: { type: 'model', verb: 'reload' },
  warmup: { type: 'model', verb: 'reload' },
  preload: { type: 'model', verb: 'reload' },
  refresh: { type: 'refreshish' },
  rescan: { type: 'refreshish' },
  sync: { type: 'refreshish' },
  poll: { type: 'refreshish' },
  scan: { type: 'refreshish' },
  list: { type: 'list' },
  ls: { type: 'list' },
  show: { type: 'list' },
  status: { type: 'list' },
  inventory: { type: 'list' },
  help: { type: 'help' },
  '?': { type: 'help' },
  commands: { type: 'help' },
};

const FILLERS = new Set([
  'model', 'models', 'the', 'a', 'an', 'please', 'machine', 'machines', 'host', 'hosts',
  'node', 'nodes', 'server', 'box', 'runtime', 'engine', 'and', 'now', 'my', 'named',
  'called', 'computer',
]);
const HOST_PREPOSITIONS = new Set(['on', 'to', 'from', 'at', 'onto', 'for', 'off']);
const RUNTIME_PREPOSITIONS = new Set(['via', 'using', 'with', 'through', 'thru']);
const ALL_WORDS = new Set(['all', 'everywhere', 'fleet', '*', 'every', 'everything']);

export function parseRuntimeKeyword(raw: string): FleetRuntimeKind | undefined {
  const low = raw.trim().toLowerCase();
  if (low === 'ollama') return 'ollama';
  if (low === 'lmstudio' || low === 'lm-studio' || low === 'lms') return 'lmstudio';
  if (low === 'llamacpp' || low === 'llama.cpp' || low === 'llama-cpp') return 'llamacpp';
  if (low === 'mlx') return 'mlx';
  if (low === 'vllm') return 'vllm';
  if (low === 'openai' || low === 'openaicompatible' || low === 'openai-compatible') return 'openaiCompatible';
  return undefined;
}

export function isValidFleetModelName(name: string): boolean {
  if (!name || name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  return /^[A-Za-z0-9._:/@+-]+$/.test(name);
}

export function isValidFleetHostName(name: string): boolean {
  if (!name || name.startsWith('-')) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (ch === ',') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function parseFleetCommand(
  input: string,
  knownHosts: ReadonlySet<string> = new Set(),
): ParsedFleetCommand {
  const tokens = tokenize(input.trim());
  if (tokens.length === 0) {
    throw new FleetParseError('EMPTY', 'Type a command, e.g. `add model qwen2.5 on machine jetson`.');
  }

  const verbIdx = tokens.findIndex((t) => VERB_MAP[t.toLowerCase()] !== undefined);
  if (verbIdx < 0) {
    throw new FleetParseError('UNKNOWN_VERB', `Unknown action '${tokens[0]}'. Try add, remove, update, reload, refresh or list.`);
  }

  const action = VERB_MAP[tokens[verbIdx]!.toLowerCase()]!;
  const rest = tokens.slice(verbIdx + 1);
  if (action.type === 'help') return { type: 'help' };

  const models: string[] = [];
  const hosts: string[] = [];
  let all = false;
  let runtime: FleetRuntimeKind | undefined;
  let mode: FleetExecutionModeOverride | undefined;
  const bareTokens: string[] = [];

  const setRuntime = (word: string) => {
    const k = parseRuntimeKeyword(word);
    if (!k) throw new FleetParseError('UNKNOWN_RUNTIME', `Unknown runtime '${word}'.`);
    if (runtime && runtime !== k) {
      throw new FleetParseError('CONFLICTING_RUNTIMES', `Two runtimes given: ${runtime} and ${k}.`);
    }
    runtime = k;
  };

  const setMode = (m: FleetExecutionModeOverride) => {
    if (mode && mode !== m) {
      throw new FleetParseError('CONFLICTING_MODES', 'Both --dry-run and --live given.');
    }
    mode = m;
  };

  const addHost = (word: string) => {
    const low = word.toLowerCase();
    if (ALL_WORDS.has(low)) {
      all = true;
      return;
    }
    if (!isValidFleetHostName(word)) {
      throw new FleetParseError('INVALID_HOST_NAME', `'${word}' is not a valid host name.`);
    }
    if (!hosts.includes(low)) hosts.push(low);
  };

  let slot: 'model' | 'host' | 'runtime' = 'model';
  for (let i = 0; i < rest.length; i += 1) {
    const raw = rest[i]!;
    const low = raw.toLowerCase();

    if (['--dry-run', '--dryrun', '-n', 'dry-run', 'dryrun', '--plan', '--preview'].includes(low)) {
      setMode('dryRun');
      continue;
    }
    if (['--live', '--execute', '--exec', '--for-real', 'live', '--apply'].includes(low)) {
      setMode('live');
      continue;
    }
    if (low === '--yes' || low === '-y') continue;

    if (['--runtime', '-r', '--host', '--on', '-h', '--model', '-m'].includes(low)) {
      const val = rest[i + 1];
      if (!val) throw new FleetParseError('MISSING_VALUE', `'${raw}' needs a value.`);
      i += 1;
      if (low === '--runtime' || low === '-r') setRuntime(val);
      else if (low === '--host' || low === '--on' || low === '-h') addHost(val);
      else models.push(val);
      continue;
    }

    const eqIdx = raw.indexOf('=');
    if (eqIdx > 0) {
      const key = raw.slice(0, eqIdx).toLowerCase().replace(/^-+/, '');
      const val = raw.slice(eqIdx + 1);
      if (!val) throw new FleetParseError('MISSING_VALUE', `'${key}' needs a value.`);
      if (['runtime', 'rt', 'engine'].includes(key)) setRuntime(val);
      else if (['host', 'machine', 'on', 'node', 'target'].includes(key)) {
        for (const v of val.split(',').filter(Boolean)) addHost(v);
      } else if (['model', 'models'].includes(key)) {
        for (const v of val.split(',').filter(Boolean)) models.push(v);
      } else if (key === 'mode') {
        setMode(val.toLowerCase() === 'live' ? 'live' : 'dryRun');
      } else {
        throw new FleetParseError('UNEXPECTED', `Didn't understand '${raw}'.`);
      }
      continue;
    }

    if (raw.startsWith('@') && raw.length > 1) {
      addHost(raw.slice(1));
      slot = 'host';
      continue;
    }
    if (HOST_PREPOSITIONS.has(low)) {
      slot = 'host';
      continue;
    }
    if (RUNTIME_PREPOSITIONS.has(low)) {
      slot = 'runtime';
      continue;
    }
    if (low === 'in') {
      const next = rest[i + 1];
      slot = next && parseRuntimeKeyword(next) ? 'runtime' : 'host';
      continue;
    }
    if (low === 'lm' && rest[i + 1]?.toLowerCase() === 'studio') {
      i += 1;
      setRuntime('lmstudio');
      continue;
    }
    if (FILLERS.has(low)) continue;

    if (slot === 'runtime') {
      setRuntime(raw);
      slot = 'model';
    } else if (slot === 'host') {
      if (parseRuntimeKeyword(low)) setRuntime(low);
      else addHost(raw);
    } else {
      if (parseRuntimeKeyword(low)) setRuntime(low);
      else if (ALL_WORDS.has(low)) all = true;
      else bareTokens.push(raw);
    }
  }

  for (const t of bareTokens) {
    if (knownHosts.has(t.toLowerCase()) && (models.length > 0 || hosts.length > 0 || action.type === 'refreshish' || action.type === 'list')) {
      addHost(t);
    } else {
      models.push(t);
    }
  }

  for (const m of models) {
    if (!isValidFleetModelName(m)) {
      throw new FleetParseError('INVALID_MODEL_NAME', `'${m}' is not a valid model name.`);
    }
  }

  const target: FleetHostTarget = all ? { kind: 'all' } : { kind: 'hosts', hosts };

  if (action.type === 'list') {
    return { type: 'list', target: hosts.length === 0 ? { kind: 'all' } : target };
  }
  if (action.type === 'refreshish') {
    if (models.length === 0) {
      return { type: 'refresh', target: hosts.length === 0 ? { kind: 'all' } : target };
    }
    if (!all && hosts.length === 0) {
      throw new FleetParseError('MISSING_HOST', 'Update needs a target machine, e.g. `update qwen2.5 on jetson`.');
    }
    return {
      type: 'model',
      command: { verb: 'update', models, target, runtime, mode },
    };
  }

  if (action.type !== 'model') {
    throw new FleetParseError('UNKNOWN_VERB', 'Unexpected non-model action.');
  }

  if (models.length === 0) {
    throw new FleetParseError('MISSING_MODEL', `${action.verb} needs a model name.`);
  }
  if (!all && hosts.length === 0) {
    throw new FleetParseError('MISSING_HOST', `${action.verb} needs a target machine (or 'on all').`);
  }

  return {
    type: 'model',
    command: {
      verb: action.verb,
      models,
      target,
      runtime,
      mode,
    },
  };
}
