import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type {
  ImprovementLifecycleState,
  ImprovementAttemptRecord,
  SupervisorLease,
  ImprovementOpportunity,
  ExperimentPlan,
  CandidateImplementation,
  CandidateVerificationResult,
  ComparativeBenchmarkSuiteResult,
  MetaOptimizationDecision,
} from '@wazir/core';

export interface DurableSupervisorOptions {
  supervisorId?: string;
  store?: KeyValueStore;
  leaseDurationMs?: number;
  projectRoot?: string;
}

export const VALID_LIFECYCLE_TRANSITIONS: Record<ImprovementLifecycleState, ImprovementLifecycleState[]> = {
  DISCOVERED: ['QUALIFIED_FOR_EXPERIMENT', 'REJECTED', 'BLOCKED', 'CANCELLED'],
  QUALIFIED_FOR_EXPERIMENT: ['PLANNED', 'REJECTED', 'BLOCKED', 'CANCELLED'],
  PLANNED: ['IMPLEMENTING', 'REJECTED', 'BLOCKED', 'CANCELLED'],
  IMPLEMENTING: ['VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['BENCHMARKING', 'REJECTED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  BENCHMARKING: ['READY_TO_COMMIT', 'REJECTED', 'INCONCLUSIVE', 'FAILED', 'CANCELLED'],
  READY_TO_COMMIT: ['COMMITTED', 'REJECTED', 'FAILED', 'CANCELLED'],
  COMMITTED: [],
  REJECTED: [],
  BLOCKED: ['QUALIFIED_FOR_EXPERIMENT', 'PLANNED', 'IMPLEMENTING', 'CANCELLED'],
  INCONCLUSIVE: ['QUALIFIED_FOR_EXPERIMENT', 'CANCELLED'],
  CANCELLED: [],
  FAILED: ['QUALIFIED_FOR_EXPERIMENT', 'PLANNED', 'IMPLEMENTING', 'CANCELLED'],
};

export class DurableImprovementSupervisor {
  public readonly supervisorId: string;
  private readonly store?: KeyValueStore;
  private readonly leaseDurationMs: number;
  private currentLease?: SupervisorLease;
  private currentAttempt?: ImprovementAttemptRecord;
  private fencingCounter: number = 0;

  constructor(options: DurableSupervisorOptions = {}) {
    this.supervisorId = options.supervisorId ?? `supervisor-${randomUUID().slice(0, 8)}`;
    this.store = options.store;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
  }

  /**
   * Acquire authoritative lease to prevent dual supervisors from executing concurrently.
   */
  public async acquireLease(attemptId: string, options: { force?: boolean } = {}): Promise<SupervisorLease> {
    const key = `meta/supervisor/lease/${attemptId}`;
    const now = new Date();

    if (this.store) {
      const existing = (await this.store.get(key)) as SupervisorLease | null;
      if (existing) {
        const expiresAt = new Date(existing.expiresAt);
        if (expiresAt > now && existing.ownerId !== this.supervisorId && !options.force) {
          throw new Error(
            `SUPERVISOR_LEASE_CONFLICT: Attempt ${attemptId} is owned by active supervisor ${existing.ownerId} until ${expiresAt.toISOString()}`,
          );
        }
        if (existing.fencingToken >= this.fencingCounter) {
          this.fencingCounter = existing.fencingToken;
        }
      }
    }

    this.fencingCounter += 1;
    const lease: SupervisorLease = {
      leaseToken: `lease-${randomUUID()}`,
      ownerId: this.supervisorId,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + this.leaseDurationMs),
      fencingToken: this.fencingCounter,
    };

    if (this.store) {
      await this.store.put(key, lease);
    }
    this.currentLease = lease;
    return lease;
  }

  /**
   * Renews the current supervisor lease.
   */
  public async renewLease(attemptId: string): Promise<SupervisorLease> {
    if (!this.currentLease || this.currentLease.ownerId !== this.supervisorId) {
      return this.acquireLease(attemptId);
    }

    const key = `meta/supervisor/lease/${attemptId}`;
    const now = new Date();
    this.currentLease.expiresAt = new Date(now.getTime() + this.leaseDurationMs);

    if (this.store) {
      await this.store.put(key, this.currentLease);
    }
    return this.currentLease;
  }

  /**
   * Releases lease when attempt reaches terminal state.
   */
  public async releaseLease(attemptId: string): Promise<void> {
    const key = `meta/supervisor/lease/${attemptId}`;
    if (this.store) {
      await this.store.delete(key);
    }
    this.currentLease = undefined;
  }

  /**
   * Initializes or loads an existing attempt record.
   */
  public async initAttempt(params: {
    attemptId?: string;
    opportunity?: ImprovementOpportunity;
    plan?: ExperimentPlan;
  }): Promise<ImprovementAttemptRecord> {
    const attemptId = params.attemptId ?? `attempt-${randomUUID().slice(0, 8)}`;
    await this.acquireLease(attemptId);

    const key = `meta/supervisor/attempt/${attemptId}`;
    if (this.store) {
      const existing = (await this.store.get(key)) as ImprovementAttemptRecord | null;
      if (existing) {
        this.currentAttempt = existing;
        return existing;
      }
    }

    const record: ImprovementAttemptRecord = {
      attemptId,
      opportunityId: params.opportunity?.id,
      experimentId: params.plan?.experimentId,
      state: 'DISCOVERED',
      stateVersion: 1,
      fencingToken: this.currentLease!.fencingToken,
      supervisorOwnerId: this.supervisorId,
      plan: params.plan,
      reasons: [],
      history: [
        {
          state: 'DISCOVERED',
          timestamp: new Date(),
          reason: 'Initial opportunity discovered',
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (this.store) {
      await this.store.put(key, record);
    }
    this.currentAttempt = record;
    return record;
  }

  /**
   * Executes atomic state transition with validation, versioning, and persistence.
   */
  public async transitionTo(
    newState: ImprovementLifecycleState,
    reason?: string,
    metadata?: Partial<ImprovementAttemptRecord>,
  ): Promise<ImprovementAttemptRecord> {
    if (!this.currentAttempt) {
      throw new Error('NO_ACTIVE_ATTEMPT: Call initAttempt() before transitioning states.');
    }

    const attemptId = this.currentAttempt.attemptId;
    const currentState = this.currentAttempt.state;

    // Validate transition
    const allowed = VALID_LIFECYCLE_TRANSITIONS[currentState] ?? [];
    if (!allowed.includes(newState)) {
      throw new Error(
        `INVALID_STATE_TRANSITION: Cannot transition attempt ${attemptId} from '${currentState}' to '${newState}'. Allowed: [${allowed.join(', ')}]`,
      );
    }

    // Verify lease and fencing token
    await this.renewLease(attemptId);

    const now = new Date();
    this.currentAttempt.state = newState;
    this.currentAttempt.stateVersion += 1;
    this.currentAttempt.updatedAt = now;
    if (reason) {
      this.currentAttempt.reasons.push(reason);
    }

    // Apply metadata updates
    if (metadata) {
      if (metadata.candidateId) this.currentAttempt.candidateId = metadata.candidateId;
      if (metadata.worktreePath) this.currentAttempt.worktreePath = metadata.worktreePath;
      if (metadata.branchName) this.currentAttempt.branchName = metadata.branchName;
      if (metadata.commitSha) this.currentAttempt.commitSha = metadata.commitSha;
      if (metadata.plan) this.currentAttempt.plan = metadata.plan;
      if (metadata.candidate) this.currentAttempt.candidate = metadata.candidate;
      if (metadata.verificationResult) this.currentAttempt.verificationResult = metadata.verificationResult;
      if (metadata.benchmarkResult) this.currentAttempt.benchmarkResult = metadata.benchmarkResult;
      if (metadata.decision) this.currentAttempt.decision = metadata.decision;
    }

    this.currentAttempt.history.push({
      state: newState,
      timestamp: now,
      reason,
      details: metadata?.verificationResult ? { verification: metadata.verificationResult } : undefined,
    });

    if (this.store) {
      await this.store.put(`meta/supervisor/attempt/${attemptId}`, this.currentAttempt);
    }

    // Release lease on terminal states
    if (['COMMITTED', 'REJECTED', 'CANCELLED'].includes(newState)) {
      await this.releaseLease(attemptId);
    }

    return this.currentAttempt;
  }

  /**
   * Resumes crashed or interrupted attempts from persistence.
   */
  public async resumeAttempt(attemptId: string): Promise<ImprovementAttemptRecord | null> {
    const key = `meta/supervisor/attempt/${attemptId}`;
    if (!this.store) return null;

    const record = (await this.store.get(key)) as ImprovementAttemptRecord | null;
    if (!record) return null;

    // Acquire or re-claim lease
    await this.acquireLease(attemptId, { force: true });
    this.currentAttempt = record;

    // If interrupted during volatile states, handle recovery
    if (['IMPLEMENTING', 'VERIFYING', 'BENCHMARKING'].includes(record.state)) {
      // Record crash recovery checkpoint
      await this.transitionTo('BLOCKED', `Interrupted during ${record.state}; recovered to BLOCKED for safe inspection`);
    }

    return this.currentAttempt;
  }

  public getCurrentAttempt(): ImprovementAttemptRecord | undefined {
    return this.currentAttempt;
  }

  public getCurrentLease(): SupervisorLease | undefined {
    return this.currentLease;
  }

  public async listAttempts(): Promise<ImprovementAttemptRecord[]> {
    if (!this.store || !('list' in this.store) || typeof (this.store as any).list !== 'function') {
      return this.currentAttempt ? [this.currentAttempt] : [];
    }
    const entries = await (this.store as any).list('meta/supervisor/attempt/');
    return entries.map((e: any) => e.value as ImprovementAttemptRecord).filter(Boolean);
  }
}
