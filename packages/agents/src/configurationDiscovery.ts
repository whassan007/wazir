import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export type ConnectionState = 'DISCOVERED' | 'CONFIGURED' | 'AUTHENTICATED' | 'CONNECTING' | 'READY' | 'DEGRADED' | 'BLOCKED' | 'FAILED' | 'UNSUPPORTED';
export type EndpointLocality = 'local' | 'cloud' | 'unknown';
export interface ConfigurationSource {
  path: string;
  scope: 'user' | 'project' | 'system';
  kind: 'settings' | 'instructions' | 'candidate';
  trusted: boolean;
  valid?: boolean;
  settings?: Record<string, string | number>;
}
export interface DiscoveredAgentConfiguration {
  agent: string;
  executable?: string;
  installations: string[];
  state: ConnectionState;
  authentication: 'UNKNOWN' | 'VERIFIED';
  credentialConfigured?: boolean;
  endpointLocality?: EndpointLocality;
  model: { status: 'CONFIGURED' | 'AVAILABLE' | 'VERIFIED' | 'UNKNOWN'; value?: string; source?: string };
  sources: ConfigurationSource[];
  fingerprint: string;
  diagnostics: string[];
  projectRoot: string;
}

/** No shell, executable launch, credential-store reads, or implicit current-directory PATH. */
export function agentExecutableCandidates(bin: string, env = process.env, platform = process.platform): string[] {
  // The explicit platform parameter is also used by cross-platform tests. Do not
  // accidentally use the host's path flavor when simulating another OS.
  const p = platform === 'win32' ? path.win32 : path.posix;
  const get = (key: string) => Object.entries(env).find(([k]) => platform === 'win32' ? k.toUpperCase() === key : k === key)?.[1];
  const extensions = platform === 'win32' ? (get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const found = new Set<string>();
  for (const entry of (get('PATH') ?? '').split(platform === 'win32' ? ';' : ':')) {
    const dir = entry.replace(/^"|"$/g, '');
    if (!p.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      found.add(p.join(dir, bin + ext));
    }
  }
  return [...found];
}

export function resolveAgentExecutables(bin: string, env = process.env, platform = process.platform): string[] {
  return agentExecutableCandidates(bin, env, platform).filter(file => {
    try {
      accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return statSync(file).isFile();
    } catch { return false; }
  });
}

function repositoryRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

// Values are deliberately restricted: arbitrary settings, URLs, tool commands, MCP env,
// hooks, instruction contents, and parser error excerpts never enter diagnostics or cache.
function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value)
    && !/sk-|token|secret|password/i.test(value) ? value : undefined;
}

function hasNonEmptySecret(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Classifies an HTTP(S) endpoint URL strictly as loopback (`'local'`), remote (`'cloud'`),
 * or `'invalid'` without echoing credentials, query parameters, or paths.
 */
export function classifyEndpointUrlLocality(rawUrl: string): 'local' | 'cloud' | 'invalid' {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0:0:0:0:0:0:0:1' ||
      /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)
    ) {
      return 'local';
    }
    return 'cloud';
  } catch {
    return 'invalid';
  }
}

function collectDeclaredEndpoints(parsed: Record<string, any>): string[] {
  const endpoints: string[] = [];
  const push = (val: unknown) => {
    if (typeof val === 'string' && val.trim().length > 0) endpoints.push(val.trim());
  };
  const provider = safeIdentifier(parsed.model_provider);
  if (provider) push(parsed.model_providers?.[provider]?.base_url);
  push(parsed.baseUrl);
  push(parsed.base_url);
  push(parsed.openaiBaseUrl);
  push(parsed.apiBaseUrl);
  if (parsed.env && typeof parsed.env === 'object') {
    push(parsed.env.OPENAI_BASE_URL);
  }
  if (parsed.security?.auth && typeof parsed.security.auth === 'object') {
    push(parsed.security.auth.baseUrl);
  }
  if (parsed.modelProviders && typeof parsed.modelProviders === 'object') {
    for (const entry of Object.values(parsed.modelProviders)) {
      if (Array.isArray(entry)) {
        for (const item of entry) {
          if (item && typeof item === 'object') {
            push((item as Record<string, unknown>).baseUrl ?? (item as Record<string, unknown>).base_url);
          }
        }
      } else if (entry && typeof entry === 'object') {
        push((entry as Record<string, unknown>).baseUrl ?? (entry as Record<string, unknown>).base_url);
      }
    }
  }
  return endpoints;
}

export class AgentConfigurationDiscovery {
  discover(options: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv; trustedProject?: boolean } = {}): DiscoveredAgentConfiguration[] {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const home = options.home ?? os.homedir();
    const env = options.env ?? process.env;
    const root = repositoryRoot(cwd);
    const codexHome = env.CODEX_HOME || path.join(home, '.codex');
    const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const qwenHome = env.QWEN_CODE_HOME || path.join(home, '.qwen');
    const appHome = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
        : env.XDG_CONFIG_HOME || path.join(home, '.config');
    return [ ['codex', 'codex'], ['claude-code', 'claude'], ['antigravity', 'agy'], ['qwen-code', 'qwen'] ].map(([agent, bin]) => {
      const sources: ConfigurationSource[] = [];
      const diagnostics: string[] = [];
      const observedLocalities: Array<'local' | 'cloud' | 'invalid'> = [];
      let hasCloudAuth = false;
      let hasOpenAiKey = false;
      let credentialConfigured = false;
      const hash = createHash('sha256');
      hash.update(JSON.stringify({ schema: 2, cwd, root, home, trusted: !!options.trustedProject, platform: process.platform }));
      for (const key of [
        'PATH', 'PATHEXT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'QWEN_CODE_HOME',
        'XDG_CONFIG_HOME', 'APPDATA', 'CLAUDECODE', 'ANTHROPIC_MODEL', 'QWEN_MODEL',
        'QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'WAZIR_ACP_PERMISSIONS',
      ]) {
        hash.update(key).update(env[key] ?? '');
      }
      const installations = resolveAgentExecutables(bin!, env);
      for (const executable of installations) {
        try {
          const stat = statSync(executable);
          hash.update(executable).update(realpathSync(executable)).update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
        } catch { hash.update('executable-changed'); diagnostics.push('Executable changed during discovery; refresh before connecting.'); }
      }
      const add = (file: string, scope: ConfigurationSource['scope'], kind: ConfigurationSource['kind']) => {
        hash.update(file);
        if (!existsSync(file)) return;
        const trusted = scope !== 'project' || options.trustedProject === true;
        const source: ConfigurationSource = { path: file, scope, kind, trusted };
        sources.push(source);
        try {
          const stat = statSync(file);
          hash.update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
          if (!stat.isFile() || stat.size > 1_048_576) { diagnostics.push('Configuration source is not a bounded regular file.'); return; }
          // Do not follow project symlinks to credentials or files outside the repository.
          const real = realpathSync(file);
          if (/auth|credential|token|secret/i.test(path.basename(real))) {
            diagnostics.push('Configuration resolves to a credential-store filename; ignored.'); return;
          }
          if (scope === 'project' && (path.relative(realpathSync(root), real).startsWith('..') || path.isAbsolute(path.relative(realpathSync(root), real)))) {
            diagnostics.push('Project configuration symlink escapes repository; ignored.'); return;
          }
          if (kind !== 'settings' || !trusted) return;
          const content = readFileSync(file, 'utf8');
          hash.update(content);
          const parsed = file.endsWith('.toml') ? parse(content) : JSON.parse(content);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
          source.valid = true;
          source.settings = {};
          for (const key of ['model', 'model_provider', 'approval_policy', 'sandbox_mode']) {
            const value = safeIdentifier(parsed[key]);
            if (value) source.settings[key] = value;
          }
          if (!source.settings.model && parsed.model && typeof parsed.model === 'object') {
            const nestedModel = safeIdentifier(parsed.model.name ?? parsed.model.id);
            if (nestedModel) source.settings.model = nestedModel;
          }
          for (const endpoint of collectDeclaredEndpoints(parsed)) {
            const locality = classifyEndpointUrlLocality(endpoint);
            observedLocalities.push(locality);
            if (locality !== 'invalid') {
              const url = new URL(endpoint);
              // Credentials, query strings, fragments and endpoint paths are never emitted.
              source.settings.providerEndpointOrigin = url.origin;
            } else {
              diagnostics.push('Provider endpoint declaration is not a valid URL.');
            }
          }
          const selectedAuth = parsed.security?.auth?.selectedType ?? parsed.authType;
          if (typeof selectedAuth === 'string' && /qwen|dashscope|oauth|alibaba/i.test(selectedAuth)) {
            hasCloudAuth = true;
            credentialConfigured = true;
          }
          if (parsed.env && typeof parsed.env === 'object') {
            if (hasNonEmptySecret(parsed.env.QWEN_API_KEY) || hasNonEmptySecret(parsed.env.DASHSCOPE_API_KEY)) {
              hasCloudAuth = true;
              credentialConfigured = true;
            }
            if (hasNonEmptySecret(parsed.env.OPENAI_API_KEY)) {
              hasOpenAiKey = true;
              credentialConfigured = true;
            }
          }
          if (hasNonEmptySecret(parsed.apiKey)) {
            hasOpenAiKey = true;
            credentialConfigured = true;
          }
          if (parsed.permissions && typeof parsed.permissions === 'object') {
            const mode = safeIdentifier(parsed.permissions.defaultMode);
            if (mode) source.settings.permissionMode = mode;
            for (const key of ['allow', 'deny', 'ask']) if (Array.isArray(parsed.permissions[key])) source.settings[`${key}RuleCount`] = parsed.permissions[key].length;
          }
          if (parsed.mcpServers && typeof parsed.mcpServers === 'object') source.settings.mcpServerCount = Object.keys(parsed.mcpServers).length;
        } catch { source.valid = false; diagnostics.push('Configuration could not be read or parsed; use the vendor CLI to validate it.'); }
      };
      if (agent === 'codex') {
        add('/etc/codex/managed_config.toml', 'system', 'candidate');
        add('/etc/codex/requirements.toml', 'system', 'candidate');
        add(path.join(codexHome, 'config.toml'), 'user', 'settings');
        add(path.join(codexHome, 'AGENTS.md'), 'user', 'instructions');
      } else if (agent === 'claude-code') {
        add(path.join(claudeHome, 'settings.json'), 'user', 'settings');
        add(path.join(claudeHome, 'CLAUDE.md'), 'user', 'instructions');
      } else if (agent === 'qwen-code') {
        add(path.join(qwenHome, 'settings.json'), 'user', 'settings');
        add(path.join(qwenHome, 'QWEN.md'), 'user', 'instructions');
      } else {
        add(path.join(home, '.gemini', 'settings.json'), 'user', 'candidate');
        add(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'user', 'candidate');
        add(path.join(appHome, 'Antigravity', 'User', 'settings.json'), 'user', 'candidate');
      }
      const directories: string[] = [];
      for (let dir = cwd; ; dir = path.dirname(dir)) { directories.unshift(dir); if (dir === root || dir === path.dirname(dir)) break; }
      for (const dir of directories) {
        if (agent === 'codex') {
          add(path.join(dir, '.codex', 'config.toml'), 'project', 'settings');
          add(path.join(dir, 'AGENTS.md'), 'project', 'instructions');
          add(path.join(dir, 'AGENTS.override.md'), 'project', 'instructions');
        } else if (agent === 'claude-code') {
          add(path.join(dir, '.claude', 'settings.json'), 'project', 'settings');
          add(path.join(dir, '.claude', 'settings.local.json'), 'project', 'settings');
          add(path.join(dir, 'CLAUDE.md'), 'project', 'instructions');
          add(path.join(dir, '.claude', 'CLAUDE.md'), 'project', 'instructions');
          add(path.join(dir, '.mcp.json'), 'project', 'settings');
        } else if (agent === 'qwen-code') {
          add(path.join(dir, '.qwen', 'settings.json'), 'project', 'settings');
          add(path.join(dir, 'QWEN.md'), 'project', 'instructions');
        } else add(path.join(dir, '.vscode', 'settings.json'), 'project', 'candidate');
      }
      if (agent === 'qwen-code') {
        if (hasNonEmptySecret(env.QWEN_API_KEY) || hasNonEmptySecret(env.DASHSCOPE_API_KEY)) {
          hasCloudAuth = true;
          credentialConfigured = true;
        }
        if (hasNonEmptySecret(env.OPENAI_API_KEY)) {
          hasOpenAiKey = true;
          credentialConfigured = true;
        }
        if (hasNonEmptySecret(env.OPENAI_BASE_URL)) {
          observedLocalities.push(classifyEndpointUrlLocality(env.OPENAI_BASE_URL!));
        }
      } else if (agent === 'codex') {
        if (hasNonEmptySecret(env.OPENAI_API_KEY)) {
          hasOpenAiKey = true;
          credentialConfigured = true;
        }
        if (hasNonEmptySecret(env.OPENAI_BASE_URL)) {
          observedLocalities.push(classifyEndpointUrlLocality(env.OPENAI_BASE_URL!));
        }
      } else if (agent === 'claude-code') {
        if (hasNonEmptySecret(env.ANTHROPIC_API_KEY) || hasNonEmptySecret(env.ANTHROPIC_AUTH_TOKEN)) {
          hasCloudAuth = true;
          credentialConfigured = true;
        }
        if (hasNonEmptySecret(env.ANTHROPIC_BASE_URL)) {
          observedLocalities.push(classifyEndpointUrlLocality(env.ANTHROPIC_BASE_URL!));
        }
      }
      let endpointLocality: EndpointLocality = 'unknown';
      if (hasCloudAuth || observedLocalities.includes('cloud')) {
        endpointLocality = 'cloud';
      } else if (observedLocalities.includes('invalid')) {
        endpointLocality = 'unknown';
      } else if (observedLocalities.length > 0 && observedLocalities.every((l) => l === 'local')) {
        endpointLocality = 'local';
      } else if (hasOpenAiKey) {
        endpointLocality = 'cloud';
      }
      const models = sources.filter(s => s.settings?.model);
      const selected = models.at(-1);
      if (new Set(models.map(s => s.settings!.model)).size > 1) diagnostics.push('Model declarations differ across sources; native CLI precedence determines the effective model.');
      if (sources.some(s => !s.trusted)) diagnostics.push('Project sources are untrusted: contents withheld until explicitly authorized.');
      diagnostics.push('Native CLI resolves effective settings, managed policy, profiles and model access. A declaration is not verified availability.');
      const modelValue = agent === 'claude-code'
        ? safeIdentifier(env.ANTHROPIC_MODEL)
        : agent === 'qwen-code'
          ? safeIdentifier(env.QWEN_MODEL)
          : undefined;
      const modelEnvSource = agent === 'claude-code' ? 'environment:ANTHROPIC_MODEL' : 'environment:QWEN_MODEL';
      return {
        agent: agent!, executable: installations[0], installations, sources, projectRoot: root,
        state: !installations.length ? 'UNSUPPORTED' : sources.some(s => s.valid === false) ? 'BLOCKED' : sources.some(s => s.valid) ? 'CONFIGURED' : 'DISCOVERED',
        authentication: 'UNKNOWN',
        credentialConfigured,
        endpointLocality,
        model: selected || modelValue ? { status: 'CONFIGURED', value: modelValue ?? String(selected!.settings!.model), source: modelValue ? modelEnvSource : selected!.path } : { status: 'UNKNOWN' },
        fingerprint: hash.digest('hex'), diagnostics,
      };
    });
  }
}
