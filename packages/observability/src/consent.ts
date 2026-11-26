import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DIAGNOSTIC_NOTICE_VERSION = '2026-11-20.1';

export interface ConsentRecord {
  noticeVersion: string;
  accepted: boolean;
  declined: boolean;
  richAnalytics: boolean;
  installationId: string;
  updatedAt: string;
}

export function resolveWazirHome(wazirHome?: string): string {
  if (wazirHome && wazirHome.trim()) return wazirHome.trim();
  if (process.env.WAZIR_HOME && process.env.WAZIR_HOME.trim()) {
    return process.env.WAZIR_HOME.trim();
  }
  return path.join(os.homedir(), '.wazir');
}

export function consentFilePath(wazirHome?: string): string {
  return path.join(resolveWazirHome(wazirHome), 'consent.json');
}

export function readConsentRecord(wazirHome?: string): ConsentRecord | null {
  const file = consentFilePath(wazirHome);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ConsentRecord>;
    if (
      typeof parsed.accepted !== 'boolean' ||
      typeof parsed.noticeVersion !== 'string' ||
      typeof parsed.installationId !== 'string'
    ) {
      return null;
    }
    return {
      noticeVersion: parsed.noticeVersion,
      accepted: parsed.accepted,
      declined: Boolean(parsed.declined),
      richAnalytics: Boolean(parsed.richAnalytics),
      installationId: parsed.installationId,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function hasAcceptedDiagnostics(wazirHome?: string): boolean {
  const rec = readConsentRecord(wazirHome);
  return Boolean(rec && rec.accepted && !rec.declined && rec.noticeVersion === DIAGNOSTIC_NOTICE_VERSION);
}

export function hasAcceptedRichAnalytics(wazirHome?: string): boolean {
  const rec = readConsentRecord(wazirHome);
  return Boolean(rec && rec.accepted && !rec.declined && rec.richAnalytics && rec.noticeVersion === DIAGNOSTIC_NOTICE_VERSION);
}

function writeConsentRecord(record: ConsentRecord, wazirHome?: string): ConsentRecord {
  const dir = resolveWazirHome(wazirHome);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = consentFilePath(wazirHome);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

export function recordConsentAcceptance(
  options: { richAnalytics?: boolean; wazirHome?: string } = {},
): ConsentRecord {
  const existing = readConsentRecord(options.wazirHome);
  return writeConsentRecord(
    {
      noticeVersion: DIAGNOSTIC_NOTICE_VERSION,
      accepted: true,
      declined: false,
      richAnalytics: Boolean(options.richAnalytics),
      installationId: existing?.installationId || crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    },
    options.wazirHome,
  );
}

export function recordConsentDecline(wazirHome?: string): ConsentRecord {
  const existing = readConsentRecord(wazirHome);
  return writeConsentRecord(
    {
      noticeVersion: DIAGNOSTIC_NOTICE_VERSION,
      accepted: false,
      declined: true,
      richAnalytics: false,
      installationId: existing?.installationId || crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    },
    wazirHome,
  );
}

export function getFirstLaunchDisclosureText(): string {
  return [
    `Wazir AI OS — First-Launch Terms & Diagnostic Notice (${DIAGNOSTIC_NOTICE_VERSION})`,
    '',
    '1. Licensing: Wazir is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).',
    '   Includes selective Apache-2.0 components adapted from QwenLM/qwen-code.',
    '2. Minimum Diagnostic Data: Only after your affirmative acceptance, Wazir may record',
    '   application/build version, OS family & architecture, error code, failure category,',
    '   component ID, sanitized exception category, task phase, worker capability category,',
    '   safe model/provider category, timestamp, and a random pseudonymous installation ID.',
    '3. What is NEVER collected by default: Raw shell history, source files, prompts,',
    '   environment variables, API keys, access tokens, private paths, or personal identifiers.',
    '4. Retention & Rights: Diagnostic events are retained up to 30 days and may be deleted',
    '   via `wa diagnostics purge` or the Diagnostics API. Rich analytics require separate opt-in.',
    '5. Declining: If you decline, Wazir diagnostic telemetry remains disabled (zero events sent)',
    '   and your native OS shell is never blocked or altered.',
  ].join('\n');
}
