import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DIAGNOSTIC_NOTICE_VERSION,
  hasAcceptedDiagnostics,
  readConsentRecord,
  resolveWazirHome,
} from './consent.js';

export const MAX_DIAGNOSTIC_PAYLOAD_BYTES = 8192;
export const MAX_QUEUE_EVENTS = 200;
export const DEFAULT_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type FailureCategory =
  | 'install'
  | 'crash'
  | 'compatibility'
  | 'command_routing'
  | 'model_failure'
  | 'worker_error'
  | 'network'
  | 'policy'
  | 'unknown';

export interface DiagnosticEvent {
  eventId: string;
  appVersion: string;
  osFamily: string;
  arch: string;
  errorCode: string;
  failureCategory: FailureCategory;
  component: string;
  exceptionCategory: string;
  taskPhase: string;
  workerCapability: string;
  modelCategory: string;
  timestamp: string;
  installationId: string;
  noticeVersion: string;
  fingerprint: string;
  sanitizedNote?: string;
}

export interface DiagnosticEventInput {
  appVersion?: string;
  errorCode: string;
  failureCategory: FailureCategory;
  component: string;
  exceptionCategory: string;
  taskPhase?: string;
  workerCapability?: string;
  modelCategory?: string;
  sanitizedNote?: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(ghp_[A-Za-z0-9]{10,})\b/g,
  /\b(Bearer\s+[A-Za-z0-9._-]{8,})\b/gi,
  /\b(nvapi-[A-Za-z0-9_-]{8,})\b/g,
  /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
  /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
  /(\/Users\/[^\s/"']+|\/home\/[^\s/"']+|[A-Za-z]:\\Users\\[^\s"']+)/g,
  /(password|secret|token|apikey|api_key)\s*[:=]\s*\S+/gi,
];

export function redactText(raw: string, maxLen = 240): string {
  let cleaned = String(raw ?? '');
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[REDACTED]');
  }
  cleaned = cleaned.replace(/[\r\n\t]+/g, ' ').trim();
  if (cleaned.length > maxLen) {
    cleaned = `${cleaned.slice(0, maxLen - 3)}...`;
  }
  return cleaned;
}

function sanitizeToken(raw: string | undefined, fallback: string, maxLen = 64): string {
  if (!raw) return fallback;
  const redacted = redactText(raw, maxLen);
  const safe = redacted.replace(/[^a-zA-Z0-9._:/-]/g, '_').slice(0, maxLen);
  return safe || fallback;
}

export function computeCrashFingerprint(parts: {
  component: string;
  failureCategory: string;
  errorCode: string;
  exceptionCategory: string;
}): string {
  const canonical = [
    parts.component,
    parts.failureCategory,
    parts.errorCode,
    parts.exceptionCategory,
  ]
    .map((v) => v.toLowerCase().trim())
    .join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function buildSanitizedDiagnosticEvent(
  input: DiagnosticEventInput,
  installationId: string,
  noticeVersion = DIAGNOSTIC_NOTICE_VERSION,
): DiagnosticEvent {
  const component = sanitizeToken(input.component, 'unknown');
  const errorCode = sanitizeToken(input.errorCode, 'ERR_UNKNOWN');
  const exceptionCategory = sanitizeToken(input.exceptionCategory, 'RuntimeError');
  const failureCategory = input.failureCategory || 'unknown';
  const fingerprint = computeCrashFingerprint({
    component,
    failureCategory,
    errorCode,
    exceptionCategory,
  });

  const event: DiagnosticEvent = {
    eventId: crypto.randomUUID(),
    appVersion: sanitizeToken(input.appVersion, '0.3.2', 32),
    osFamily: os.platform(),
    arch: os.arch(),
    errorCode,
    failureCategory,
    component,
    exceptionCategory,
    taskPhase: sanitizeToken(input.taskPhase, 'unknown', 48),
    workerCapability: sanitizeToken(input.workerCapability, 'local', 48),
    modelCategory: sanitizeToken(input.modelCategory, 'none', 48),
    timestamp: new Date().toISOString(),
    installationId: sanitizeToken(installationId, 'anon', 64),
    noticeVersion: sanitizeToken(noticeVersion, DIAGNOSTIC_NOTICE_VERSION, 32),
    fingerprint,
    ...(input.sanitizedNote ? { sanitizedNote: redactText(input.sanitizedNote, 200) } : {}),
  };

  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DIAGNOSTIC_PAYLOAD_BYTES) {
    delete event.sanitizedNote;
  }
  return event;
}

export function redactDiagnosticPayload(raw: Record<string, unknown>): DiagnosticEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const serialized = JSON.stringify(raw);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DIAGNOSTIC_PAYLOAD_BYTES * 4) {
    return null;
  }
  const allowedCategories = new Set<FailureCategory>([
    'install',
    'crash',
    'compatibility',
    'command_routing',
    'model_failure',
    'worker_error',
    'network',
    'policy',
    'unknown',
  ]);
  const rawCat = typeof raw.failureCategory === 'string' ? (raw.failureCategory as FailureCategory) : 'unknown';
  const failureCategory: FailureCategory = allowedCategories.has(rawCat) ? rawCat : 'unknown';

  return buildSanitizedDiagnosticEvent(
    {
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '0.3.2',
      errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : 'ERR_UNKNOWN',
      failureCategory,
      component: typeof raw.component === 'string' ? raw.component : 'unknown',
      exceptionCategory: typeof raw.exceptionCategory === 'string' ? raw.exceptionCategory : 'UnknownError',
      taskPhase: typeof raw.taskPhase === 'string' ? raw.taskPhase : 'unknown',
      workerCapability: typeof raw.workerCapability === 'string' ? raw.workerCapability : 'local',
      modelCategory: typeof raw.modelCategory === 'string' ? raw.modelCategory : 'none',
      sanitizedNote: typeof raw.sanitizedNote === 'string' ? raw.sanitizedNote : undefined,
    },
    typeof raw.installationId === 'string' ? raw.installationId : 'anon',
    typeof raw.noticeVersion === 'string' ? raw.noticeVersion : DIAGNOSTIC_NOTICE_VERSION,
  );
}

export class DiagnosticQueue {
  private readonly queuePath: string;
  private readonly wazirHome: string;

  constructor(wazirHome?: string) {
    this.wazirHome = resolveWazirHome(wazirHome);
    this.queuePath = path.join(this.wazirHome, 'diagnostics-queue.jsonl');
  }

  enqueue(input: DiagnosticEventInput): DiagnosticEvent | null {
    if (!hasAcceptedDiagnostics(this.wazirHome)) {
      return null;
    }
    const consent = readConsentRecord(this.wazirHome);
    const event = buildSanitizedDiagnosticEvent(
      input,
      consent?.installationId ?? 'anon',
      consent?.noticeVersion ?? DIAGNOSTIC_NOTICE_VERSION,
    );
    const existing = this.readAllValid();
    existing.push(event);
    const bounded = existing.slice(-MAX_QUEUE_EVENTS);
    fs.mkdirSync(this.wazirHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      this.queuePath,
      bounded.map((e) => JSON.stringify(e)).join('\n') + (bounded.length ? '\n' : ''),
      { mode: 0o600 },
    );
    return event;
  }

  readAllValid(nowMs = Date.now(), ttlMs = DEFAULT_EVENT_TTL_MS): DiagnosticEvent[] {
    if (!fs.existsSync(this.queuePath)) return [];
    const lines = fs.readFileSync(this.queuePath, 'utf8').split('\n').filter(Boolean);
    const valid: DiagnosticEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as DiagnosticEvent;
        const ts = Date.parse(parsed.timestamp);
        if (!Number.isNaN(ts) && nowMs - ts <= ttlMs) {
          valid.push(parsed);
        }
      } catch {
        // Drop corrupted lines
      }
    }
    return valid;
  }

  clear(): void {
    if (fs.existsSync(this.queuePath)) {
      fs.rmSync(this.queuePath, { force: true });
    }
  }
}
