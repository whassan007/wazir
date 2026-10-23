import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { DEFAULT_CHILD_ENV_ALLOW } from '@wazir/shared';
import {
  isExecutableOnPath,
  resolveExecutable,
  type TaskType,
} from '@wazir/core';
import type { AcpPermissionMode } from './acpAgentAdapter.js';

export const HARNESS_CONTRACT_SCHEMA_VERSION = 1 as const;

export type ExternalHarnessProtocol = 'acp' | 'stdio-cli';

export type ExternalHarnessKind = 'acp' | 'external-cli';

export type ExternalHarnessCapability =
  | 'coding'
  | 'chat'
  | 'step-execution'
  | 'streaming'
  | 'tool-Forwarding'
  | 'checkpoint-resume'
  | 'cancellation'
  | 'mcp'
  | 'workspace-isolation';

export interface ExternalHarnessDescriptor {
  harnessId: string;
  name: string;
  version: string;
  kind: ExternalHarnessKind;
  capabilities: ExternalHarnessCapability[];
  supportedTaskTypes: TaskType[];
  supportedProtocols: Array<'native' | 'acp' | 'stdio-cli'>;
  requiresBinary?: string;
  allowsModelSelection: boolean;
  defaultPermissionMode?: AcpPermissionMode;
}

export interface ExternalHarnessSpec {
  harnessId: string;
  name: string;
  version?: string;
  description?: string;
  kind: ExternalHarnessKind;
  protocol: ExternalHarnessProtocol;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Explicit environment keys allowed to pass through from host process.env */
  allowedEnvKeys?: string[];
  capabilities?: ExternalHarnessCapability[];
  supportedTaskTypes?: TaskType[];
  allowsModelSelection?: boolean;
  permissionMode?: AcpPermissionMode;
  maxWallClockMs?: number;
  initTimeoutMs?: number;
  cancelGraceMs?: number;
  maxOutputChars?: number;
  expectedAcpProtocolVersion?: number;
  defaultModelId?: string;
  defaultRuntimeId?: string;
}

export interface HarnessCapabilityDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override binary resolution for deterministic unit tests */
  resolveBinary?: (command: string, envPath?: string) => string | undefined;
  /** Reported or probed ACP protocol version from the external agent */
  reportedAcpProtocolVersion?: number;
  /** Required ACP protocol version (defaults to SDK PROTOCOL_VERSION) */
  expectedAcpProtocolVersion?: number;
  /** Requested permission mode override */
  requestedPermissionMode?: AcpPermissionMode | string;
  /** Maximum allowed permission mode ceiling enforced by host policy */
  maxPermissionMode?: AcpPermissionMode;
}

export interface DiscoveredHarnessCapabilities {
  harnessId: string;
  descriptor: ExternalHarnessDescriptor;
  available: boolean;
  binaryFound: boolean;
  resolvedBinaryPath?: string;
  protocolCompatible: boolean;
  expectedAcpProtocolVersion?: number;
  reportedAcpProtocolVersion?: number;
  effectivePermissionMode: AcpPermissionMode;
  permissionModeClamped: boolean;
  sanitizedEnv: Record<string, string>;
  strippedEnvKeys: string[];
  failureClassification?:
    | 'BINARY_NOT_FOUND'
    | 'ACP_PROTOCOL_INCOMPATIBLE'
    | 'ENVIRONMENT_BLOCKED'
    | 'PERMISSION_MODE_INVALID';
  diagnostics: string[];
}

/**
 * Safe baseline environment variable keys permitted for external harnesses.
 * Never includes cloud/API secrets (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, etc.)
 * unless explicitly allowlisted by the harness spec.
 */
export const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
  ...DEFAULT_CHILD_ENV_ALLOW,
  'COLORTERM',
  'TERM_PROGRAM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
]);

/**
 * Pattern matching sensitive credential/secret environment variable names that must
 * never leak into child harness processes unless explicitly allowlisted in the spec.
 */
const SENSITIVE_ENV_NAME_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|AUTH|CREDENTIAL|ACCESS_KEY|SESSION_KEY|COOKIE|BEARER)/i;

const PERMISSION_MODE_RANK: Record<AcpPermissionMode, number> = {
  read: 0,
  edit: 1,
  full: 2,
};

/**
 * Preset external harness specifications for Qwen Code, Codex, Claude Code, and OpenCode.
 */
export const EXTERNAL_HARNESS_PRESETS: Readonly<Record<string, ExternalHarnessSpec>> = {
  'qwen-code': {
    harnessId: 'qwen-code',
    name: 'Qwen Code (ACP)',
    version: 'acp',
    description: 'Qwen Code external harness speaking Agent Client Protocol over stdio',
    kind: 'acp',
    protocol: 'acp',
    command: 'qwen',
    args: ['--acp'],
    allowedEnvKeys: ['QWEN_CODE_HOME', 'QWEN_API_KEY', 'OPENAI_BASE_URL', 'DASHSCOPE_API_KEY'],
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'cancellation',
      'mcp',
      'workspace-isolation',
    ],
    supportedTaskTypes: [],
    allowsModelSelection: false,
    permissionMode: 'edit',
    defaultModelId: 'qwen-code-external',
    defaultRuntimeId: 'acp:qwen-code',
  },
  codex: {
    harnessId: 'codex',
    name: 'OpenAI Codex (ACP)',
    version: 'acp',
    description: 'OpenAI Codex external harness over ACP bridge',
    kind: 'acp',
    protocol: 'acp',
    command: 'codex',
    args: ['--acp'],
    allowedEnvKeys: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'cancellation',
      'workspace-isolation',
    ],
    supportedTaskTypes: [],
    allowsModelSelection: false,
    permissionMode: 'edit',
    defaultModelId: 'codex-external',
    defaultRuntimeId: 'acp:codex',
  },
  'claude-code': {
    harnessId: 'claude-code',
    name: 'Claude Code (ACP)',
    version: 'acp',
    description: 'Anthropic Claude Code external harness over ACP',
    kind: 'acp',
    protocol: 'acp',
    command: 'claude',
    args: ['--acp'],
    allowedEnvKeys: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'tool-Forwarding',
      'cancellation',
      'mcp',
      'workspace-isolation',
    ],
    supportedTaskTypes: [],
    allowsModelSelection: true,
    permissionMode: 'edit',
    defaultModelId: 'claude-code-external',
    defaultRuntimeId: 'acp:claude-code',
  },
  opencode: {
    harnessId: 'opencode',
    name: 'OpenCode (CLI)',
    version: 'external-cli',
    description: 'OpenCode external subprocess CLI harness',
    kind: 'external-cli',
    protocol: 'stdio-cli',
    command: 'opencode',
    args: ['run'],
    allowedEnvKeys: ['OPENCODE_CONFIG_DIR'],
    capabilities: [
      'coding',
      'step-execution',
      'cancellation',
      'workspace-isolation',
    ],
    supportedTaskTypes: [],
    allowsModelSelection: false,
    permissionMode: 'edit',
    defaultModelId: 'opencode-external',
    defaultRuntimeId: 'cli:opencode',
  },
};

export function getExternalHarnessPreset(
  presetId: string,
  overrides: Partial<ExternalHarnessSpec> = {},
): ExternalHarnessSpec {
  const key = presetId.trim().toLowerCase();
  const base = EXTERNAL_HARNESS_PRESETS[key];
  if (!base) {
    return {
      harnessId: overrides.harnessId ?? presetId,
      name: overrides.name ?? presetId,
      version: overrides.version ?? 'external',
      description: overrides.description ?? `External harness '${presetId}'`,
      kind: overrides.kind ?? 'acp',
      protocol: overrides.protocol ?? 'acp',
      command: overrides.command ?? presetId,
      args: overrides.args ?? [],
      env: overrides.env,
      allowedEnvKeys: overrides.allowedEnvKeys ?? [],
      capabilities: overrides.capabilities ?? ['coding', 'cancellation'],
      supportedTaskTypes: overrides.supportedTaskTypes ?? [],
      allowsModelSelection: overrides.allowsModelSelection ?? false,
      permissionMode: overrides.permissionMode ?? 'edit',
      maxWallClockMs: overrides.maxWallClockMs,
      initTimeoutMs: overrides.initTimeoutMs,
      cancelGraceMs: overrides.cancelGraceMs,
      maxOutputChars: overrides.maxOutputChars,
      expectedAcpProtocolVersion: overrides.expectedAcpProtocolVersion,
      defaultModelId: overrides.defaultModelId ?? `${presetId}-external`,
      defaultRuntimeId: overrides.defaultRuntimeId ?? `${overrides.protocol ?? 'acp'}:${presetId}`,
    };
  }
  return {
    ...base,
    ...overrides,
    args: overrides.args ?? [...(base.args ?? [])],
    capabilities: overrides.capabilities ?? [...(base.capabilities ?? [])],
    supportedTaskTypes: overrides.supportedTaskTypes ?? [...(base.supportedTaskTypes ?? [])],
    allowedEnvKeys: overrides.allowedEnvKeys ?? [...(base.allowedEnvKeys ?? [])],
  };
}

export function buildExternalHarnessDescriptor(spec: ExternalHarnessSpec): ExternalHarnessDescriptor {
  return {
    harnessId: spec.harnessId,
    name: spec.name,
    version: spec.version ?? (spec.kind === 'acp' ? 'acp' : 'external-cli'),
    kind: spec.kind,
    capabilities: spec.capabilities ?? ['coding', 'cancellation'],
    supportedTaskTypes: spec.supportedTaskTypes ?? [],
    supportedProtocols: [spec.protocol],
    requiresBinary: spec.command,
    allowsModelSelection: spec.allowsModelSelection ?? false,
    defaultPermissionMode: spec.permissionMode ?? 'edit',
  };
}

export function resolveEffectivePermissionMode(
  requested: AcpPermissionMode | string | undefined,
  specDefault: AcpPermissionMode = 'edit',
  maxMode?: AcpPermissionMode,
): { mode: AcpPermissionMode; clamped: boolean; valid: boolean } {
  const raw = requested ?? specDefault;
  const valid = raw === 'read' || raw === 'edit' || raw === 'full';
  const normalized: AcpPermissionMode = raw === 'read' || raw === 'full' ? raw : 'edit';
  if (!maxMode) {
    return { mode: normalized, clamped: false, valid };
  }
  if (PERMISSION_MODE_RANK[normalized] > PERMISSION_MODE_RANK[maxMode]) {
    return { mode: maxMode, clamped: true, valid };
  }
  return { mode: normalized, clamped: false, valid };
}

/**
 * Sanitizes the environment for an external harness process.
 * Only keys in `ALLOWED_ENV_KEYS`, `LC_*`/`XDG_*` prefixes, or `spec.allowedEnvKeys`
 * are inherited from `baseEnv`, and any secret-matching key not explicitly allowlisted
 * by the spec is stripped even if passed in `spec.env` unless `spec.allowedEnvKeys`
 * or `spec.env` explicitly declares it.
 */
export function sanitizeHarnessEnvironment(
  spec: Pick<ExternalHarnessSpec, 'env' | 'allowedEnvKeys'>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { sanitizedEnv: Record<string, string>; strippedEnvKeys: string[] } {
  const explicitAllow = new Set((spec.allowedEnvKeys ?? []).map((k) => k.toUpperCase()));
  const baseAllow = new Set([...ALLOWED_ENV_KEYS].map((k) => k.toUpperCase()));
  const sanitizedEnv: Record<string, string> = {};
  const strippedEnvKeys: string[] = [];

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    const hasAllowedPrefix = upper.startsWith('LC_') || upper.startsWith('XDG_');
    const isBaseAllowed = baseAllow.has(upper) || hasAllowedPrefix;
    const isExplicitlyAllowed = explicitAllow.has(upper);

    if (isExplicitlyAllowed) {
      sanitizedEnv[key] = value;
      continue;
    }

    if (SENSITIVE_ENV_NAME_PATTERN.test(key)) {
      strippedEnvKeys.push(key);
      continue;
    }

    if (isBaseAllowed) {
      sanitizedEnv[key] = value;
    } else {
      strippedEnvKeys.push(key);
    }
  }

  // Merge explicit spec.env overrides: allow if in explicitAllow, baseAllow, or non-sensitive;
  // if sensitive and not in allowedEnvKeys, only allow if explicitly provided in spec.env?
  // Wait: if spec.env provides a key, check if it's sensitive and not in allowedEnvKeys.
  // Actually, test fixtures pass env like FAKE_ACP_MODE in spec.env. Those are non-sensitive!
  // What if someone puts AWS_SECRET_ACCESS_KEY in baseEnv vs spec.env? If it's in baseEnv, it's stripped above.
  // If someone passes an unauthorized secret in spec.env without listing it in allowedEnvKeys, strip it too!
  if (spec.env) {
    for (const [key, value] of Object.entries(spec.env)) {
      if (value === undefined) continue;
      const upper = key.toUpperCase();
      if (SENSITIVE_ENV_NAME_PATTERN.test(key) && !explicitAllow.has(upper)) {
        strippedEnvKeys.push(key);
        continue;
      }
      sanitizedEnv[key] = value;
    }
  }

  return { sanitizedEnv, strippedEnvKeys };
}

/**
 * Discovers binary availability, ACP protocol compatibility, sanitized environment,
 * and constrained permission mode for an external harness specification.
 */
export function discoverExternalHarnessCapabilities(
  specOrPresetId: ExternalHarnessSpec | string,
  options: HarnessCapabilityDiscoveryOptions = {},
): DiscoveredHarnessCapabilities {
  const spec =
    typeof specOrPresetId === 'string'
      ? getExternalHarnessPreset(specOrPresetId)
      : specOrPresetId;
  const descriptor = buildExternalHarnessDescriptor(spec);
  const diagnostics: string[] = [];
  const baseEnv = options.env ?? process.env;
  const envPath = baseEnv.PATH ?? baseEnv.Path ?? process.env.PATH;

  const { sanitizedEnv, strippedEnvKeys } = sanitizeHarnessEnvironment(spec, baseEnv);

  // Check environment blockers (e.g. nested Claude Code session)
  if (spec.harnessId === 'claude-code' && baseEnv.CLAUDECODE) {
    diagnostics.push(
      'Claude Code cannot be launched inside an existing CLAUDECODE session.',
    );
    const perm = resolveEffectivePermissionMode(
      options.requestedPermissionMode,
      spec.permissionMode ?? 'edit',
      options.maxPermissionMode,
    );
    return {
      harnessId: spec.harnessId,
      descriptor,
      available: false,
      binaryFound: false,
      protocolCompatible: true,
      effectivePermissionMode: perm.mode,
      permissionModeClamped: perm.clamped,
      sanitizedEnv,
      strippedEnvKeys,
      failureClassification: 'ENVIRONMENT_BLOCKED',
      diagnostics,
    };
  }

  const resolveBin = options.resolveBinary ?? ((cmd: string, p?: string) => resolveExecutable(cmd, p));
  const resolvedBinaryPath = resolveBin(spec.command, envPath);
  const binaryFound = Boolean(resolvedBinaryPath || isExecutableOnPath(spec.command, envPath));

  if (!binaryFound) {
    diagnostics.push(`Required binary '${spec.command}' for harness '${spec.harnessId}' was not found on PATH.`);
  }

  const expectedAcpVersion =
    options.expectedAcpProtocolVersion ?? spec.expectedAcpProtocolVersion ?? PROTOCOL_VERSION;
  const reportedAcpVersion = options.reportedAcpProtocolVersion;

  let protocolCompatible = true;
  if (spec.protocol === 'acp' && reportedAcpVersion !== undefined) {
    protocolCompatible = reportedAcpVersion === expectedAcpVersion;
    if (!protocolCompatible) {
      diagnostics.push(
        `ACP protocol version mismatch for '${spec.harnessId}': expected ${expectedAcpVersion}, agent reported ${reportedAcpVersion}.`,
      );
    }
  }

  const perm = resolveEffectivePermissionMode(
    options.requestedPermissionMode,
    spec.permissionMode ?? 'edit',
    options.maxPermissionMode,
  );
  if (!perm.valid) {
    diagnostics.push(
      `Invalid permission mode '${String(options.requestedPermissionMode)}' requested; defaulted to '${perm.mode}'.`,
    );
  }
  if (perm.clamped) {
    diagnostics.push(
      `Requested permission mode exceeded policy ceiling '${options.maxPermissionMode}'; clamped to '${perm.mode}'.`,
    );
  }

  let failureClassification: DiscoveredHarnessCapabilities['failureClassification'];
  if (!binaryFound) {
    failureClassification = 'BINARY_NOT_FOUND';
  } else if (!protocolCompatible) {
    failureClassification = 'ACP_PROTOCOL_INCOMPATIBLE';
  }

  return {
    harnessId: spec.harnessId,
    descriptor,
    available: binaryFound && protocolCompatible,
    binaryFound,
    resolvedBinaryPath,
    protocolCompatible,
    expectedAcpProtocolVersion: spec.protocol === 'acp' ? expectedAcpVersion : undefined,
    reportedAcpProtocolVersion: reportedAcpVersion,
    effectivePermissionMode: perm.mode,
    permissionModeClamped: perm.clamped,
    sanitizedEnv,
    strippedEnvKeys,
    failureClassification,
    diagnostics,
  };
}
