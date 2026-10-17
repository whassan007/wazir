import { createHash, randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';

export type ImprovementMode = 'harden' | 'optimize' | 'evolve';
export type SupervisorPhase =
  | 'IDLE'
  | 'OBSERVING'
  | 'DIAGNOSING'
  | 'PLANNING'
  | 'EXPERIMENTING'
  | 'VERIFYING'
  | 'QUALIFYING'
  | 'STAGED'
  | 'PAUSED'
  | 'BLOCKED'
  | 'FAILED'
  | 'STOPPED';

export interface ImprovementIncident {
  signature: string;
  kind: string;
  summary: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sources: string[];
  mode?: ImprovementMode;
}

export interface ImprovementRecommendation {
  id: string;
  signature: string;
  mode: ImprovementMode;
  category: string;
  targetComponent: string;
  summary: string;
  proposedAction: string;
  evidence: Record<string, unknown>;
  status: 'OPEN' | 'STAGED' | 'PROMOTED' | 'REJECTED';
  createdAt: string;
  updatedAt: string;
}

export interface SupervisorState {
  schema: 1;
  instanceId: string;
  pid: number;
  phase: SupervisorPhase;
  modes: ImprovementMode[];
  cycles: number;
  failures: number;
  consecutiveFailures: number;
  nextRunAt: string;
  updatedAt: string;
  reason?: string;
  activeAttempt?: string;
  incidentsCount?: number;
  recommendationsCount?: number;
}

export interface SupervisorResult {
  decision: 'STAGED' | 'QUALIFIED' | 'INCONCLUSIVE' | 'REJECTED';
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface SupervisorDependencies {
  store: KeyValueStore;
  observe: () => Promise<Array<{ source: string; kind: string; summary: string }>>;
  diagnose?: (modes: ImprovementMode[]) => Promise<Array<Omit<ImprovementRecommendation, 'id' | 'createdAt' | 'updatedAt' | 'status'>>>;
  busy: () => Promise<boolean>;
  experiment?: (attemptId: string, modes: ImprovementMode[]) => Promise<SupervisorResult>;
  recordLearning?: (entry: { attemptId: string; modes: ImprovementMode[]; result: SupervisorResult; completedAt: string }) => Promise<void>;
  optimize?: (attemptId: string) => Promise<SupervisorResult>;
  log?: (event: Record<string, unknown>) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  maxCycles?: number;
}

export function parseImprovementModes(value = 'harden'): ImprovementMode[] {
  const modes = [...new Set(value.split(',').map((m) => m.trim()).filter(Boolean))];
  if (!modes.length || modes.some((mode) => !['harden', 'optimize', 'evolve'].includes(mode))) {
    throw new Error('Mode must be harden, optimize, or evolve');
  }
  return modes as ImprovementMode[];
}

export function redactImprovementText(value: string): string {
  return value
    .replace(/\b(?:sk-|ghp_|github_pat_)[\w-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|token|secret)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .slice(0, 2000);
}

/**
 * Caller owns the OS singleton lease. State and control have separate keys so
 * polling clients cannot overwrite checkpoints or a simultaneous pause request.
 */
export class SelfImprovementSupervisor {
  private state!: SupervisorState;
  private readonly now: () => number;

  constructor(private readonly deps: SupervisorDependencies) {
    this.now = deps.now ?? Date.now;
    if ((deps.intervalMs ?? 60_000) < 1000) throw new Error('Minimum interval is 1000ms');
    if (!Number.isInteger(deps.maxCycles ?? 1000) || (deps.maxCycles ?? 1000) < 1) {
      throw new Error('Invalid cycle budget');
    }
  }

  async initialize(modes: ImprovementMode[]): Promise<SupervisorState> {
    const previous = await this.deps.store.get<SupervisorState>('supervisor/state');
    if (previous?.activeAttempt) {
      await this.deps.store.put(`supervisor/attempts/${previous.activeAttempt}`, {
        attemptId: previous.activeAttempt,
        modes: previous.modes,
        decision: 'INCONCLUSIVE',
        reason: 'INTERRUPTED: side effects uncertain; manual review required',
        completedAt: new Date(this.now()).toISOString(),
      });
    }
    this.state = {
      schema: 1,
      instanceId: randomUUID(),
      pid: process.pid,
      phase: 'IDLE',
      modes,
      cycles: 0,
      failures: previous?.failures ?? 0,
      consecutiveFailures: 0,
      nextRunAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      incidentsCount: previous?.incidentsCount ?? 0,
      recommendationsCount: previous?.recommendationsCount ?? 0,
    };
    await this.save();
    return this.snapshot();
  }

  snapshot(): SupervisorState {
    return structuredClone(this.state);
  }

  async tick(): Promise<SupervisorState> {
    const control = await this.deps.store.get<string>('supervisor/control');
    if (control === 'stop') return this.transition('STOPPED', 'Operator requested stop');
    if (control === 'pause') return this.transition('PAUSED', 'Operator requested pause');
    if (this.state.cycles >= (this.deps.maxCycles ?? 1000)) {
      return this.transition('BLOCKED', 'CYCLE_BUDGET_EXHAUSTED');
    }
    if (this.now() < Date.parse(this.state.nextRunAt)) return this.snapshot();

    try {
      if (await this.deps.busy()) {
        this.defer(1);
        return this.transition('IDLE', 'Foreground workload or resource pressure; deferred');
      }

      this.state.cycles++;
      await this.transition('OBSERVING');
      const observations = (await this.deps.observe()).slice(0, 500);
      for (const observation of observations) {
        await this.recordIncident(observation);
      }

      await this.transition('DIAGNOSING');
      await this.generateRecommendations();

      await this.transition('PLANNING');

      if (this.deps.experiment) {
        const attemptId = randomUUID();
        this.state.activeAttempt = attemptId;
        await this.transition('EXPERIMENTING');
        const result = await this.deps.experiment(attemptId, this.state.modes);
        const completedAt = new Date(this.now()).toISOString();
        await this.deps.store.put(`supervisor/attempts/${attemptId}`, {
          attemptId,
          modes: this.state.modes,
          ...result,
          completedAt,
        });
        await this.deps.recordLearning?.({
          attemptId,
          modes: this.state.modes,
          result,
          completedAt,
        });
        this.state.activeAttempt = undefined;
        this.state.consecutiveFailures = 0;
        this.defer(1);
        await this.prune('supervisor/attempts/', 200);
        const passed = result.decision === 'STAGED' || result.decision === 'QUALIFIED';
        return this.transition(passed ? 'STAGED' : 'BLOCKED', result.reason);
      }

      if (this.state.modes.includes('optimize') && this.deps.optimize) {
        const attemptId = randomUUID();
        this.state.activeAttempt = attemptId;
        await this.transition('EXPERIMENTING');
        const result = await this.deps.optimize(attemptId);
        await this.deps.store.put(`supervisor/attempts/${attemptId}`, {
          attemptId,
          modes: ['optimize'],
          ...result,
          completedAt: new Date(this.now()).toISOString(),
        });
        this.state.activeAttempt = undefined;
        this.state.consecutiveFailures = 0;
        this.defer(1);
        await this.prune('supervisor/attempts/', 200);
        const passed = result.decision === 'STAGED' || result.decision === 'QUALIFIED';
        return this.transition(passed ? 'STAGED' : 'BLOCKED', result.reason);
      }

      this.defer(1);
      if (this.state.modes.includes('evolve')) {
        return this.transition(
          'BLOCKED',
          'EVOLVE requires an authorized feature scope (--scope <file>) with independent checks',
        );
      }
      if (this.state.modes.includes('optimize') && !this.state.modes.includes('harden')) {
        return this.transition(
          'BLOCKED',
          'No comparable optimization benchmark tasks or authorized scope configured',
        );
      }
      return this.transition(
        'BLOCKED',
        'No authorized reproducible repair scope and independent oracle configured',
      );
    } catch (error) {
      this.state.failures++;
      this.state.consecutiveFailures++;
      if (this.state.activeAttempt) {
        await this.deps.store.put(`supervisor/attempts/${this.state.activeAttempt}`, {
          attemptId: this.state.activeAttempt,
          modes: this.state.modes,
          decision: 'INCONCLUSIVE',
          reason: 'EXECUTION_ERROR: inspect retained workspace before retry',
          error: redactImprovementText(String(error)),
          completedAt: new Date(this.now()).toISOString(),
        });
        this.state.activeAttempt = undefined;
      }
      this.defer(Math.min(32, 2 ** this.state.consecutiveFailures));
      return this.transition(
        this.state.consecutiveFailures >= 3 ? 'BLOCKED' : 'FAILED',
        redactImprovementText(String(error)),
      );
    }
  }

  async recordIncident(observation: { source: string; kind: string; summary: string }): Promise<void> {
    const summary = redactImprovementText(observation.summary).slice(0, 1200);
    const signature = createHash('sha256')
      .update(observation.kind + summary.replace(/\b\d+\b/g, '#'))
      .digest('hex')
      .slice(0, 24);
    const key = `supervisor/incidents/${signature}`;
    const previous = await this.deps.store.get<ImprovementIncident>(key);
    if (previous?.sources.includes(observation.source)) return;
    const timestamp = new Date(this.now()).toISOString();
    const incident: ImprovementIncident = {
      signature,
      kind: observation.kind,
      summary,
      count: (previous?.count ?? 0) + 1,
      firstSeen: previous?.firstSeen ?? timestamp,
      lastSeen: timestamp,
      sources: [...(previous?.sources ?? []), observation.source].slice(-100),
      mode: observation.kind.includes('token') || observation.kind.includes('latency') ? 'optimize' : 'harden',
    };
    await this.deps.store.put(key, incident);
    await this.prune('supervisor/incidents/', 500);
    const allIncidents = await this.deps.store.list('supervisor/incidents/');
    this.state.incidentsCount = allIncidents.length;
  }

  private async generateRecommendations(): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    const incidents = await this.deps.store.list('supervisor/incidents/');
    for (const entry of incidents) {
      const inc = entry.value as ImprovementIncident;
      if (!inc || !inc.signature) continue;
      const recKey = `supervisor/recommendations/rec-${inc.signature}`;
      const existing = await this.deps.store.get<ImprovementRecommendation>(recKey);
      const proposedAction =
        inc.kind === 'crash'
          ? 'Create an isolated HARDEN repair scope reproducing the crash stack trace and adding a regression test.'
          : inc.kind === 'tool_protocol_failure'
            ? 'Route multi-file coding tasks away from models with repeated tool-call protocol failures or tighten tool schema validation.'
            : inc.kind === 'build_failure'
              ? 'Isolate build regression in a candidate worktree and verify with BuildOracle + TestOracle.'
              : 'Author a bounded repair scope with an independent failing test oracle before applying source changes.';
      const rec: ImprovementRecommendation = {
        id: `rec-${inc.signature}`,
        signature: inc.signature,
        mode: inc.mode ?? 'harden',
        category: inc.kind.toUpperCase(),
        targetComponent: inc.kind === 'tool_protocol_failure' ? 'ModelRouter' : 'ExecutionEngine',
        summary: inc.summary.slice(0, 300),
        proposedAction,
        evidence: {
          incidentSignature: inc.signature,
          occurrences: inc.count,
          sources: inc.sources.slice(-10),
          lastSeen: inc.lastSeen,
        },
        status: existing?.status ?? 'OPEN',
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      await this.deps.store.put(recKey, rec);
    }

    if (this.deps.diagnose) {
      const extra = await this.deps.diagnose(this.state.modes);
      for (const item of extra) {
        const recId = `rec-${item.signature}`;
        const recKey = `supervisor/recommendations/${recId}`;
        const existing = await this.deps.store.get<ImprovementRecommendation>(recKey);
        const rec: ImprovementRecommendation = {
          id: recId,
          signature: item.signature,
          mode: item.mode,
          category: item.category,
          targetComponent: item.targetComponent,
          summary: redactImprovementText(item.summary),
          proposedAction: redactImprovementText(item.proposedAction),
          evidence: item.evidence,
          status: existing?.status ?? 'OPEN',
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
        };
        await this.deps.store.put(recKey, rec);
      }
    }

    await this.prune('supervisor/recommendations/', 300);
    const allRecs = await this.deps.store.list('supervisor/recommendations/');
    this.state.recommendationsCount = allRecs.length;
  }

  private defer(multiplier: number): void {
    this.state.nextRunAt = new Date(
      this.now() + (this.deps.intervalMs ?? 60_000) * multiplier,
    ).toISOString();
  }

  private async transition(phase: SupervisorPhase, reason?: string): Promise<SupervisorState> {
    this.state.phase = phase;
    this.state.reason = reason;
    await this.save();
    await this.deps.log?.({
      time: this.state.updatedAt,
      event: 'phase',
      phase,
      reason,
      instanceId: this.state.instanceId,
      attemptId: this.state.activeAttempt,
      cycles: this.state.cycles,
    });
    return this.snapshot();
  }

  private async save(): Promise<void> {
    this.state.updatedAt = new Date(this.now()).toISOString();
    await this.deps.store.put('supervisor/state', this.state);
  }

  private async prune(prefix: string, limit: number): Promise<void> {
    const entries = await this.deps.store.list(prefix);
    entries.sort((a, b) =>
      String((a.value as any).lastSeen ?? (a.value as any).updatedAt ?? (a.value as any).completedAt ?? '').localeCompare(
        String((b.value as any).lastSeen ?? (b.value as any).updatedAt ?? (b.value as any).completedAt ?? ''),
      ),
    );
    for (const entry of entries.slice(0, Math.max(0, entries.length - limit))) {
      await this.deps.store.delete(entry.key);
    }
  }
}
