/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

export const MAX_SUMMARY_CHARS = 240;
export const MAX_DETAIL_CHARS = 4096;

/** Strip ANSI control codes and terminal escape sequences */
export function stripControlSequences(value: string): string {
  // Common ANSI escape sequence regex
  return value
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\].*?\x07/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function tailSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  return '...' + text.slice(text.length - (max - 3));
}

export function sanitizeTitleLine(value: string): string {
  const line = stripControlSequences(value).split(/[\r\n]+/)[0]?.trim() ?? '';
  return line.length > MAX_SUMMARY_CHARS
    ? line.slice(0, MAX_SUMMARY_CHARS - 3) + '...'
    : line;
}

/** Redacts sensitive credentials, tokens, and keys from permission strings */
export function redactPermissionText(text: string): string {
  return text
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]{12,}/gi, '$1[REDACTED]')
    .replace(/(api[_\-]?key\s*[:=]\s*['"]?)[a-zA-Z0-9_\-\.]{12,}/gi, '$1[REDACTED]')
    .replace(/(ghp_[a-zA-Z0-9]{20,})/g, '[REDACTED_GH_TOKEN]')
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, '[REDACTED_OPENAI_KEY]')
    .replace(/(AIza[0-9A-Za-z\-_]{35})/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/(AKIA[0-9A-Z]{16})/g, '[REDACTED_AWS_KEY]');
}

export type PermissionOptionKind = 'proceed' | 'reject';
export type PermissionEscalation = 'once' | 'always';

export interface PermissionOption {
  optionId: string;
  kind: PermissionOptionKind;
  escalation: PermissionEscalation;
  description?: string;
}

export function classifyOption(raw: Record<string, unknown>): PermissionOption {
  const optionId = String(raw.id ?? raw.optionId ?? '');
  const name = String(raw.name ?? raw.title ?? '').toLowerCase();
  // ACP options carry a typed kind (allow_once | allow_always | reject_once | reject_always);
  // the label is only a fallback, since "No" or "Skip" would otherwise read as proceed.
  const specKind = typeof raw.kind === 'string' ? raw.kind : '';
  const kind: PermissionOptionKind = /^(allow|reject)_(once|always)$/.test(specKind)
    ? (specKind.startsWith('reject') ? 'reject' : 'proceed')
    : name.includes('deny') || name.includes('reject') || name.includes('cancel')
      ? 'reject'
      : 'proceed';
  const escalation: PermissionEscalation = /^(allow|reject)_(once|always)$/.test(specKind)
    ? (specKind.endsWith('always') ? 'always' : 'once')
    : name.includes('always') || name.includes('permanent') || name.includes('remember')
      ? 'always'
      : 'once';
  return { optionId, kind, escalation, description: String(raw.description ?? raw.name ?? '') };
}

/** Selects the least escalating permission option offered by the backend */
export function pickLeastEscalating(
  options: readonly PermissionOption[],
  wanted: PermissionOptionKind,
): PermissionOption | undefined {
  const matching = options.filter((o) => o.kind === wanted);
  if (matching.length === 0) return undefined;
  // Prefer 'once' over 'always'
  const once = matching.find((o) => o.escalation === 'once');
  return once ?? matching[0];
}

/** Picks a persistent grant ('always') if available */
export function pickPersistentGrant(
  options: readonly PermissionOption[],
  wanted: PermissionOptionKind,
): PermissionOption | undefined {
  return options.find((o) => o.kind === wanted && o.escalation === 'always');
}
