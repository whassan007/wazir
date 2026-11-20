import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import {
  redactDiagnosticPayload,
  resolveWazirHome,
  type DiagnosticEvent,
} from '@wazir/observability';

export interface AggregatedDiagnosticIssue {
  fingerprint: string;
  component: string;
  failureCategory: string;
  errorCode: string;
  exceptionCategory: string;
  severity: 'P0' | 'P1' | 'P2';
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedVersions: string[];
  latestNote?: string;
  triageSummary?: string;
}

interface DiagnosticsStore {
  events: DiagnosticEvent[];
  issues: Record<string, AggregatedDiagnosticIssue>;
}

const RATE_WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 60;

function severityForCategory(category: string): 'P0' | 'P1' | 'P2' {
  if (category === 'crash' || category === 'install') return 'P0';
  if (category === 'model_failure' || category === 'worker_error' || category === 'command_routing') return 'P1';
  return 'P2';
}

export function registerDiagnosticsRoutes(app: Express, wazirHome?: string): void {
  registerDiagnosticsIngestionRoute(app, wazirHome);
  registerDiagnosticsAdminRoutes(app, wazirHome);
}

function getDiagnosticsStoreHelpers(wazirHome?: string) {
  const home = resolveWazirHome(wazirHome);
  const storePath = path.join(home, 'diagnostics-store.json');

  function loadStore(): DiagnosticsStore {
    try {
      if (fs.existsSync(storePath)) {
        const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<DiagnosticsStore>;
        return {
          events: Array.isArray(parsed.events) ? parsed.events : [],
          issues: parsed.issues && typeof parsed.issues === 'object' ? parsed.issues : {},
        };
      }
    } catch {
      // Fallback to empty store
    }
    return { events: [], issues: {} };
  }

  function saveStore(store: DiagnosticsStore): void {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const bounded: DiagnosticsStore = {
      events: store.events.slice(-1000),
      issues: store.issues,
    };
    fs.writeFileSync(storePath, `${JSON.stringify(bounded, null, 2)}\n`, { mode: 0o600 });
  }

  return { loadStore, saveStore };
}

export function registerDiagnosticsIngestionRoute(app: Express, wazirHome?: string): void {
  const { loadStore, saveStore } = getDiagnosticsStoreHelpers(wazirHome);
  const rateMap = new Map<string, { windowStart: number; count: number }>();

  app.post('/api/v1/diagnostics/events', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid diagnostic payload' });
      return;
    }

    const event = redactDiagnosticPayload(body);
    if (!event) {
      res.status(413).json({ error: 'Diagnostic payload rejected (oversized or malformed)' });
      return;
    }

    const now = Date.now();
    const bucket = rateMap.get(event.installationId) ?? { windowStart: now, count: 0 };
    if (now - bucket.windowStart > RATE_WINDOW_MS) {
      bucket.windowStart = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    rateMap.set(event.installationId, bucket);
    if (bucket.count > MAX_EVENTS_PER_WINDOW) {
      res.status(429).json({ error: 'Diagnostic rate limit exceeded' });
      return;
    }

    const store = loadStore();
    store.events.push(event);
    const existing = store.issues[event.fingerprint];
    if (existing) {
      existing.count += 1;
      existing.lastSeen = event.timestamp;
      if (!existing.affectedVersions.includes(event.appVersion)) {
        existing.affectedVersions.push(event.appVersion);
      }
      if (event.sanitizedNote) existing.latestNote = event.sanitizedNote;
    } else {
      store.issues[event.fingerprint] = {
        fingerprint: event.fingerprint,
        component: event.component,
        failureCategory: event.failureCategory,
        errorCode: event.errorCode,
        exceptionCategory: event.exceptionCategory,
        severity: severityForCategory(event.failureCategory),
        count: 1,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        affectedVersions: [event.appVersion],
        ...(event.sanitizedNote ? { latestNote: event.sanitizedNote } : {}),
      };
    }
    saveStore(store);

    res.status(202).json({
      accepted: true,
      eventId: event.eventId,
      fingerprint: event.fingerprint,
      issueCount: store.issues[event.fingerprint].count,
    });
  });
}

export function registerDiagnosticsAdminRoutes(app: Express, wazirHome?: string): void {
  const { loadStore, saveStore } = getDiagnosticsStoreHelpers(wazirHome);

  app.get('/api/v1/diagnostics/issues', (_req: Request, res: Response) => {
    const store = loadStore();
    const issues = Object.values(store.issues).sort((a, b) => b.count - a.count);
    res.json({
      totalEvents: store.events.length,
      totalIssues: issues.length,
      issues,
    });
  });

  app.delete('/api/v1/diagnostics/events', (_req: Request, res: Response) => {
    saveStore({ events: [], issues: {} });
    res.json({ purged: true });
  });

  app.post('/api/v1/diagnostics/triage', async (req: Request, res: Response) => {
    const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';
    const store = loadStore();
    const issue = store.issues[fingerprint];
    if (!issue) {
      res.status(404).json({ error: `Issue '${fingerprint}' not found` });
      return;
    }
    const triageSummary = `[${issue.severity}] ${issue.component}/${issue.errorCode} (${issue.exceptionCategory}, ${issue.count} occurrences across ${issue.affectedVersions.join(', ')}). Reproduction candidate: inspect ${issue.component} under ${issue.failureCategory} condition.`;
    issue.triageSummary = triageSummary;
    saveStore(store);
    res.json({
      fingerprint: issue.fingerprint,
      severity: issue.severity,
      triageSummary,
      localModelCandidate: 'qwen3-coder:30b',
    });
  });
}
