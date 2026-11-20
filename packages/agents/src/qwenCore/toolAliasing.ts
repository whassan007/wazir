export type ModelFamilyProfile = 'codex' | 'claude' | 'gemini' | 'qwen' | 'generic';

export interface ToolAliasRule {
  canonicalName: string;
  aliasName: string;
}

const MODEL_PROFILE_ALIASES: Record<ModelFamilyProfile, ToolAliasRule[]> = {
  codex: [
    { canonicalName: 'edit', aliasName: 'apply_patch' },
    { canonicalName: 'multi_edit', aliasName: 'apply_patch' },
    { canonicalName: 'run_shell', aliasName: 'shell_command' },
  ],
  claude: [
    { canonicalName: 'run_shell', aliasName: 'bash' },
  ],
  gemini: [],
  qwen: [],
  generic: [],
};

/**
 * Infers a model-family tool profile from a model identifier string.
 */
export function detectModelFamilyProfile(modelId: string): ModelFamilyProfile {
  const lower = modelId.toLowerCase();
  if (lower.includes('codex') || lower.includes('gpt-5') || lower.includes('o3') || lower.includes('o4')) return 'codex';
  if (lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku')) return 'claude';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('qwen')) return 'qwen';
  return 'generic';
}

/**
 * Maps a canonical Wazir tool name to the preferred alias for `profile`.
 */
export function toModelToolAlias(canonicalName: string, profile: ModelFamilyProfile): string {
  const rules = MODEL_PROFILE_ALIASES[profile] ?? [];
  const match = rules.find((r) => r.canonicalName === canonicalName);
  return match ? match.aliasName : canonicalName;
}

/**
 * Normalizes a model-emitted tool name (e.g., `apply_patch`, `shell_command`)
 * back to its canonical Wazir tool name.
 */
export function fromModelToolAlias(emittedName: string, profile: ModelFamilyProfile): string {
  const rules = MODEL_PROFILE_ALIASES[profile] ?? [];
  const match = rules.find((r) => r.aliasName === emittedName);
  return match ? match.canonicalName : emittedName;
}
