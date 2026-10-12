import type {
  SemanticStrategyCorpus,
  SemanticRetrievalPair,
  AntiStrategyCase,
  CorpusEngineeringProblem,
} from '../types/semanticCorpus.js';

// ============================================================================
// FIXTURE PAIR 1 (HIGH RELEVANCE - STRUCTURAL POSITIVE PAIR):
// A: TypeScript cancellation lease race
// B: TypeScript remote worker ownership timeout
// Same architectural defect:
// Late completion writes/processes after lease/heartbeat expiration or cancellation,
// causing split-brain state mutation.
// Different filenames, different symbols, different layouts, different error wording.
// ============================================================================

const problem1A_cancellationLeaseRace: CorpusEngineeringProblem = {
  id: 'prob-ts-lease-race-A',
  name: 'TypeScript Cancellation Lease Race',
  description:
    'A long-running execution token can be revoked due to lease expiration, but async task continuation performs late mutation without re-verifying token validity.',
  repositoryId: 'repo-task-coordinator-alpha',
  workspaceRoot: '/workspaces/task-coordinator-alpha',
  problemSignature: {
    category: 'race_condition',
    languages: ['typescript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'STALE_LEASE_COMMIT_VIOLATION',
    failureEvidenceTags: ['lease_expired', 'unfenced_mutation', 'split_brain_write'],
    domainTags: ['distributed_tasks', 'concurrency'],
  },
  taskPrompt:
    'Fix split-brain data corruption when coordinator marks lease expired during deep chunk processing',
  errorDiagnostics: [
    'Error: STALE_LEASE_COMMIT_VIOLATION: Attempted state commit on lease token 0x9f2a after revocation timestamp',
    'StateAssertionError: Invariant broken: dual active committers detected for partition 4',
  ],
  files: [
    {
      relativePath: 'src/coordination/leaseToken.ts',
      content: `
export interface LeaseToken {
  id: string;
  expiresAtEpochMs: number;
  revoked: boolean;
}

export class LeaseController {
  private active = new Map<string, LeaseToken>();

  public grant(id: string, ttlMs: number): LeaseToken {
    const token: LeaseToken = { id, expiresAtEpochMs: Date.now() + ttlMs, revoked: false };
    this.active.set(id, token);
    return token;
  }

  public revoke(id: string): void {
    const token = this.active.get(id);
    if (token) token.revoked = true;
  }
}
`,
    },
    {
      relativePath: 'src/pipeline/chunkRunner.ts',
      content: `
import { LeaseController, LeaseToken } from '../coordination/leaseToken.js';

export class ChunkRunner {
  constructor(private controller: LeaseController) {}

  public async processBatch(lease: LeaseToken, items: string[]): Promise<void> {
    for (const item of items) {
      await new Promise((r) => setTimeout(r, 10));
      // Defect: late write commits without lease fence check
      this.commitItem(item);
    }
  }

  private commitItem(item: string): void {
    // writing state directly
  }
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Inspect asynchronous loop and identify unprotected state mutation points',
      intent: 'Locate missing ownership or fencing pre-commit guards',
    },
    {
      phase: 'modify',
      action: 'Introduce fencing token guard or monotonic generation verification prior to state mutation',
      intent: 'Reject late results when lease or ownership has been revoked or superseded',
    },
    {
      phase: 'verify',
      action: 'Execute simulated delayed concurrency test under race conditions',
      intent: 'Confirm stale async operations are safely dropped without throwing split-brain errors',
    },
  ],
};

const problem1B_workerOwnershipTimeout: CorpusEngineeringProblem = {
  id: 'prob-ts-ownership-timeout-B',
  name: 'TypeScript Remote Worker Ownership Timeout',
  description:
    'A remote worker node loses partition leadership during heartbeat pause; upon resumption, it flushes staged payloads into the shared datastore without fencing.',
  repositoryId: 'repo-node-fleet-beta',
  workspaceRoot: '/workspaces/node-fleet-beta',
  problemSignature: {
    category: 'race_condition',
    languages: ['typescript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'STALE_LEASE_COMMIT_VIOLATION',
    failureEvidenceTags: ['leadership_lost', 'unfenced_mutation', 'epoch_mismatch'],
    domainTags: ['fleet_management', 'concurrency'],
  },
  taskPrompt:
    'Prevent stale remote node from persisting staged metrics after heartbeat epoch timeout and leadership loss',
  errorDiagnostics: [
    'ClusterConflictException: Partition write rejected: epoch 14 superseded by current leader epoch 15',
    'UnfencedPayloadError: Dropped late arrival payload for worker node-b-77',
  ],
  files: [
    {
      relativePath: 'core/cluster/heartbeatMonitor.ts',
      content: `
export interface NodeEpoch {
  nodeId: string;
  generation: number;
  lastHeartbeatTs: number;
}

export class HeartbeatMonitor {
  private epochs = new Map<string, NodeEpoch>();

  public heartbeat(nodeId: string, gen: number): void {
    this.epochs.set(nodeId, { nodeId, generation: gen, lastHeartbeatTs: Date.now() });
  }
}
`,
    },
    {
      relativePath: 'storage/sink/metricStore.ts',
      content: `
export class MetricStoreSink {
  public async flushStaged(nodeId: string, payload: Record<string, number>): Promise<void> {
    // Defect: ignores epoch fencing token check before writes
    await this.writeToDb(payload);
  }

  private async writeToDb(data: any): Promise<void> {
    // persistent write
  }
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Inspect asynchronous loop and identify unprotected state mutation points',
      intent: 'Locate missing ownership or fencing pre-commit guards',
    },
    {
      phase: 'modify',
      action: 'Introduce fencing token guard or monotonic generation verification prior to state mutation',
      intent: 'Reject late results when lease or ownership has been revoked or superseded',
    },
    {
      phase: 'verify',
      action: 'Execute simulated delayed concurrency test under race conditions',
      intent: 'Confirm stale async operations are safely dropped without throwing split-brain errors',
    },
  ],
};

const structuralPair1: SemanticRetrievalPair = {
  id: 'pair-structural-lease-ownership',
  name: 'TypeScript Lease Race <-> Worker Ownership Timeout',
  description:
    'Paired engineering defects sharing the identical distributed concurrency pattern (fencing token / lease expiration race), implemented with disjoint terminology (lease/coordinator vs epoch/worker/leadership).',
  sourceProblem: problem1A_cancellationLeaseRace,
  targetProblem: problem1B_workerOwnershipTimeout,
  expectedRelevance: 'HIGH',
  sharedArchitecturalConcept:
    'Monotonic generation / fencing token check to reject late results and mutations following lease or leadership expiration.',
  confoundingFactor:
    'Completely disjoint terminology (LeaseToken/ChunkRunner vs NodeEpoch/MetricStoreSink) and distinct repository directory topologies.',
  forbiddenTokensInTargetPlan: [
    'LeaseController',
    'LeaseToken',
    'chunkRunner.ts',
    'leaseToken.ts',
    'commitItem',
  ],
};

// ============================================================================
// FIXTURE PAIR 2 (CROSS-LANGUAGE ARCHITECTURE-EQUIVALENT PAIR):
// TypeScript lifecycle cancellation <-> Go lifecycle cancellation
// Transferable concepts:
// - ownership
// - lease expiration
// - late-result rejection
// - cleanup
// Non-transferable:
// - syntax
// - library calls (AbortController / setTimeout vs context.Context / time.After)
// - symbols
// ============================================================================

const problem2A_tsLifecycleCancellation: CorpusEngineeringProblem = {
  id: 'prob-ts-lifecycle-cancellation',
  name: 'TypeScript Lifecycle Task Cancellation',
  description:
    'Async pipeline stage continues dispatching network sub-requests after parent lifecycle signal has aborted, leaking resources and emitting unhandled rejections.',
  repositoryId: 'repo-ts-orchestrator',
  workspaceRoot: '/workspaces/ts-orchestrator',
  problemSignature: {
    category: 'worker_lifecycle_failure',
    languages: ['typescript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'ORPHANED_ASYNC_OPERATION',
    failureEvidenceTags: ['signal_aborted', 'resource_leak', 'unhandled_rejection'],
    domainTags: ['lifecycle', 'cancellation', 'concurrency'],
  },
  taskPrompt:
    'Prevent orphaned sub-requests from executing and leaking sockets when TaskRunner abort signal triggers',
  errorDiagnostics: [
    'UnhandledPromiseRejection: Task aborted by controller but sub-request #4 completed against closed connection',
    'Warning: Memory leak detected: 3 orphaned event listeners on abort signal',
  ],
  files: [
    {
      relativePath: 'src/runtime/taskRunner.ts',
      content: `
export class TaskRunner {
  public async executePipeline(signal: AbortSignal, stages: (() => Promise<void>)[]): Promise<void> {
    for (const stage of stages) {
      // Defect: does not check signal.aborted before next stage nor tear down handles
      await stage();
    }
  }
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Trace execution flow and lifecycle cancellation listener registration',
      intent: 'Identify missing cancellation propagation and uncollected handles',
    },
    {
      phase: 'modify',
      action: 'Attach cancellation check and teardown hook to short-circuit pending iterations and release resources',
      intent: 'Enforce immediate late-result rejection and clean disposal upon context termination',
    },
    {
      phase: 'verify',
      action: 'Run lifecycle cancellation test asserting zero active background handles remain after termination',
      intent: 'Validate resource cleanup and early exit',
    },
  ],
};

const problem2B_goLifecycleCancellation: CorpusEngineeringProblem = {
  id: 'prob-go-lifecycle-cancellation',
  name: 'Go Lifecycle Routine Cancellation',
  description:
    'Goroutine worker loop continues processing channel items after context cancellation channel is closed, triggering panic on closed downstream channel write.',
  repositoryId: 'repo-go-dispatcher',
  workspaceRoot: '/workspaces/go-dispatcher',
  problemSignature: {
    category: 'worker_lifecycle_failure',
    languages: ['go'],
    repositoryCharacteristics: ['single_package', 'compiled', 'typed'],
    failureSignature: 'ORPHANED_ASYNC_OPERATION',
    failureEvidenceTags: ['context_canceled', 'channel_closed_panic', 'goroutine_leak'],
    domainTags: ['lifecycle', 'cancellation', 'concurrency'],
  },
  taskPrompt:
    'Fix goroutine leak and panic on closed channel when parent ctx is canceled during batch stream processing',
  errorDiagnostics: [
    'panic: send on closed channel',
    'goroutine 42 [running]: dispatch.(*BatchProcessor).ProcessStream(0xc0000a6, 0xc0000a8)',
    'LeakSanitizer: detected 1 lingering goroutine after context cancellation',
  ],
  files: [
    {
      relativePath: 'dispatcher/processor.go',
      content: `
package dispatcher

import (
	"context"
)

type BatchProcessor struct {
	Out chan string
}

func (bp *BatchProcessor) ProcessStream(ctx context.Context, items []string) {
	for _, item := range items {
		// Defect: does not select on ctx.Done() prior to downstream dispatch
		bp.Out <- item
	}
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Trace execution flow and lifecycle cancellation listener registration',
      intent: 'Identify missing cancellation propagation and uncollected handles',
    },
    {
      phase: 'modify',
      action: 'Attach cancellation check and teardown hook to short-circuit pending iterations and release resources',
      intent: 'Enforce immediate late-result rejection and clean disposal upon context termination',
    },
    {
      phase: 'verify',
      action: 'Run lifecycle cancellation test asserting zero active background handles remain after termination',
      intent: 'Validate resource cleanup and early exit',
    },
  ],
};

const crossLanguagePair: SemanticRetrievalPair = {
  id: 'pair-cross-language-cancellation',
  name: 'TypeScript Lifecycle Cancellation <-> Go Context Cancellation',
  description:
    'Cross-language pair sharing the fundamental concepts of asynchronous lifecycle cancellation, ownership handoff, late-result rejection, and cleanup, despite zero syntax or token overlap.',
  sourceProblem: problem2A_tsLifecycleCancellation,
  targetProblem: problem2B_goLifecycleCancellation,
  expectedRelevance: 'HIGH',
  sharedArchitecturalConcept:
    'Lifecycle cancellation propagation, early termination check in iteration loops, and clean disposal of downstream handles/channels.',
  confoundingFactor:
    'Different languages (TypeScript vs Go), completely different concurrency primitives (AbortSignal/Promises vs context.Context/channels), and distinct tooling/compiler error traces.',
  forbiddenTokensInTargetPlan: [
    'AbortSignal',
    'AbortController',
    'TaskRunner',
    'taskRunner.ts',
    'executePipeline',
  ],
};

// ============================================================================
// FIXTURE PAIR 3 (NEGATIVE PAIR - LEXICAL SIMILARITY BUT DIFFERENT DEFECT):
// Looks lexically similar (both mention "Timeout", "Worker", "Queue", "Heartbeat")
// but Problem A is a concurrency deadlock / mutex lock order inversion,
// while Problem B is an unhandled memory heap overflow caused by unbounded queue buffering.
// ============================================================================

const problem3A_mutexLockInversion: CorpusEngineeringProblem = {
  id: 'prob-ts-lock-inversion',
  name: 'TypeScript Worker Mutex Inversion',
  description:
    'Worker thread pool deadlocks under concurrent timeout checks due to inverted acquisition order between queue mutex and worker mutex.',
  repositoryId: 'repo-worker-sync',
  workspaceRoot: '/workspaces/worker-sync',
  problemSignature: {
    category: 'race_condition',
    languages: ['typescript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'DEADLOCK_DETECTED',
    failureEvidenceTags: ['lock_inversion', 'cyclic_wait', 'hung_event_loop'],
    domainTags: ['synchronization', 'deadlock'],
  },
  taskPrompt: 'Resolve worker timeout deadlock during queue heartbeat synchronization',
  errorDiagnostics: [
    'DeadlockDetectedError: Circular wait detected between WorkerLock and QueueLock',
    'Worker timeout watchdog fired after 30000ms: thread blocked indefinitely',
  ],
  files: [
    {
      relativePath: 'src/sync/workerQueueLock.ts',
      content: `
export class WorkerQueueLock {
  // Lock A -> Lock B inversion
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Map lock acquisition ordering across competing execution paths',
      intent: 'Identify cycle in wait-for graph',
    },
    {
      phase: 'modify',
      action: 'Establish global canonical acquisition hierarchy for all mutual exclusion primitives',
      intent: 'Prevent circular lock dependencies',
    },
    {
      phase: 'verify',
      action: 'Execute high-concurrency contention stress test',
      intent: 'Ensure zero deadlock occurrences under maximal concurrency',
    },
  ],
};

const problem3B_unboundedQueueMemoryLeak: CorpusEngineeringProblem = {
  id: 'prob-ts-unbounded-queue-oom',
  name: 'TypeScript Worker Queue Heap Overflow',
  description:
    'Worker queue exhibits timeout failures not from deadlocks, but because backpressure is missing, causing process heap exhaustion (OOM) under sustained ingest.',
  repositoryId: 'repo-queue-buffer',
  workspaceRoot: '/workspaces/queue-buffer',
  problemSignature: {
    category: 'performance_regression',
    languages: ['typescript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'OUT_OF_MEMORY',
    failureEvidenceTags: ['heap_exhaustion', 'unbounded_buffer', 'missing_backpressure'],
    domainTags: ['memory', 'buffering', 'backpressure'],
  },
  taskPrompt: 'Fix worker queue timeout and slowdown when high-throughput heartbeat events queue up',
  errorDiagnostics: [
    '<--- Last few GCs ---> [12345:0x55] 120000 ms: Mark-sweep: 4096.0 MB (4120.0 MB) -> 4096.0 MB Allocation failed - JavaScript heap out of memory',
    'Fatal error: Worker queue processing timed out due to garbage collection thrashing',
  ],
  files: [
    {
      relativePath: 'src/buffer/workerQueueBuffer.ts',
      content: `
export class WorkerQueueBuffer {
  private queue: any[] = [];
  public push(item: any) { this.queue.push(item); } // No backpressure check
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Profile memory allocations and queue length over sustained load',
      intent: 'Identify unbounded buffer growth and lack of backpressure',
    },
    {
      phase: 'modify',
      action: 'Implement bounded queue capacity with reactive backpressure or drop policy',
      intent: 'Constrain heap footprint within fixed operational budget',
    },
    {
      phase: 'verify',
      action: 'Run high-throughput sustained load benchmark measuring steady-state RSS memory',
      intent: 'Verify memory plateaus below safe threshold',
    },
  ],
};

const negativePairLexicalSimilarity: SemanticRetrievalPair = {
  id: 'pair-negative-lexical-overlap',
  name: 'Deadlock Lock Inversion vs Unbounded Queue OOM',
  description:
    'Negative pair where both problems share superficial lexical tokens ("worker", "timeout", "queue", "heartbeat") but represent completely different root cause defects (synchronization deadlock vs unbounded buffer OOM).',
  sourceProblem: problem3A_mutexLockInversion,
  targetProblem: problem3B_unboundedQueueMemoryLeak,
  expectedRelevance: 'IRRELEVANT',
  confoundingFactor:
    'Heavy lexical keyword overlap ("worker", "queue", "timeout", "heartbeat") masking orthogonal root causes (mutex deadlock vs heap memory exhaustion).',
  forbiddenTokensInTargetPlan: [
    'WorkerLock',
    'QueueLock',
    'lock hierarchy',
    'mutual exclusion',
    'lock inversion',
  ],
};

// ============================================================================
// FIXTURE PAIR 4 (MEDIUM RELEVANCE - PARTIAL OVERLAP / RELATED SUBSYSTEM):
// Shared problem domain (REST API pagination & cursor stability),
// but source is off-by-one cursor truncation, whereas target is missing cursor sorting tie-breaker.
// Transferable: inspection of cursor encoding, test verification on boundary conditions.
// Partial relevance: MEDIUM.
// ============================================================================

const problem4A_cursorTruncation: CorpusEngineeringProblem = {
  id: 'prob-ts-cursor-truncation',
  name: 'TypeScript API Cursor Off-By-One Truncation',
  description:
    'Pagination cursor decoding truncates the last character of base64 salt, skipping the first element of subsequent page.',
  repositoryId: 'repo-api-catalog',
  workspaceRoot: '/workspaces/api-catalog',
  problemSignature: {
    category: 'general_repair',
    languages: ['typescript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'PAGINATION_SKIP_ANOMALY',
    failureEvidenceTags: ['cursor_decoding', 'boundary_truncation'],
    domainTags: ['api', 'pagination'],
  },
  taskPrompt: 'Repair cursor pagination off-by-one boundary skip on page transitions',
  errorDiagnostics: ['PageConsistencyError: Expected record ID 100 in page 2 but got record ID 101'],
  files: [
    {
      relativePath: 'src/api/cursor.ts',
      content: `
export function decodeCursor(c: string): string {
  return Buffer.from(c, 'base64').toString('utf8').slice(0, -1); // Bug: drops last char
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Examine boundary serialization and deserialization routines',
      intent: 'Find offset calculation mismatch',
    },
    {
      phase: 'modify',
      action: 'Align buffer slicing and cursor index arithmetic with exact boundary semantics',
      intent: 'Ensure zero element duplication or skipping across page boundaries',
    },
    {
      phase: 'verify',
      action: 'Verify pagination continuity across multiple consecutive pages',
      intent: 'Validate zero missing records',
    },
  ],
};

const problem4B_cursorSortingTieBreaker: CorpusEngineeringProblem = {
  id: 'prob-ts-cursor-tie-breaker',
  name: 'TypeScript API Cursor Non-Deterministic Order',
  description:
    'Pagination query orders by timestamp only; records sharing identical timestamp yield non-deterministic results across page boundaries.',
  repositoryId: 'repo-feed-service',
  workspaceRoot: '/workspaces/feed-service',
  problemSignature: {
    category: 'general_repair',
    languages: ['typescript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'PAGINATION_SKIP_ANOMALY',
    failureEvidenceTags: ['sorting_ambiguity', 'unstable_ordering'],
    domainTags: ['api', 'pagination'],
  },
  taskPrompt: 'Ensure deterministic cursor pagination ordering when multiple rows have identical creation timestamps',
  errorDiagnostics: ['OrderFlakinessError: Consecutive requests for page 2 returned different ordering'],
  files: [
    {
      relativePath: 'src/feed/queryBuilder.ts',
      content: `
export function buildQuery(cursorTs: number) {
  // Bug: ORDER BY created_at without secondary unique column
  return "SELECT * FROM feed WHERE created_at > ? ORDER BY created_at LIMIT 20";
}
`,
    },
  ],
  expectedAbstractApproach: [
    {
      phase: 'inspect',
      action: 'Examine boundary serialization and deserialization routines',
      intent: 'Find sorting or boundary instability',
    },
    {
      phase: 'modify',
      action: 'Add secondary unique tie-breaker column to ordering clause and composite cursor',
      intent: 'Guarantee deterministic result set order',
    },
    {
      phase: 'verify',
      action: 'Verify pagination continuity across multiple consecutive pages with duplicate timestamp data',
      intent: 'Ensure strict idempotence',
    },
  ],
};

const mediumPairPagination: SemanticRetrievalPair = {
  id: 'pair-medium-pagination-boundary',
  name: 'Cursor Off-by-one vs Cursor Tie-breaker Order',
  description:
    'Related pagination boundary flaws that share inspection methodology and testing patterns, but differ in the specific root cause mechanism (encoding slice vs SQL sort clause).',
  sourceProblem: problem4A_cursorTruncation,
  targetProblem: problem4B_cursorSortingTieBreaker,
  expectedRelevance: 'MEDIUM',
  sharedArchitecturalConcept: 'Pagination boundary verification and cursor encoding continuity.',
  confoundingFactor: 'Both are pagination bugs, but one is a code-level string slice flaw and the other is a database query sorting ambiguity.',
  forbiddenTokensInTargetPlan: ['decodeCursor', 'slice(0, -1)', 'Buffer.from'],
};

// ============================================================================
// ANTI-STRATEGY FIXTURES: Historical Failed Strategy Cases
// 1. Edit before reproduction
// 2. Blind stale replacement
// 3. Retry without reread
// ============================================================================

const antiStrategy1_editBeforeReproduction: AntiStrategyCase = {
  id: 'anti-edit-before-repro',
  name: 'Edit Before Reproduction',
  antiPatternName: 'speculative_blind_editing_before_reproduction',
  description:
    'Agent modifies code files speculatively before running tests, reproducing the reported failure, or checking error diagnostics.',
  problemSignature: {
    category: 'general_repair',
    languages: ['typescript', 'python', 'go'],
    repositoryCharacteristics: ['monorepo', 'has_ci'],
    failureSignature: 'SPECULATIVE_EDIT_CHURN',
    failureEvidenceTags: ['no_baseline_test', 'shotgun_debugging'],
  },
  historicalFailurePrompt: 'Investigate and repair test flakiness in worker session manager',
  historicalFailureEvidence:
    'Failure: Agent executed 4 edit_file operations without running any reproduction script or test. Result: introduced 3 collateral syntax errors and failed acceptance gate.',
  warningMessage:
    'ANTI-STRATEGY DETECTED: Speculative modification before baseline failure reproduction causes high repair churn and collateral damage.',
  flawedApproachSteps: [
    { phase: 'modify', action: 'Directly modify files based on hunch without running tests', intent: 'Guess fix' },
    { phase: 'modify', action: 'Modify related files speculative', intent: 'Guess more' },
    { phase: 'verify', action: 'Finally run tests', intent: 'Check if lucky' },
  ],
  consequences: [
    'Masks original root cause behind new synthetic defects',
    'Increases total token consumption by 3x-5x',
    'Violates physical evidence verification invariants',
  ],
  remedySuggestion:
    'Always execute baseline verification or targeted reproduction test FIRST to observe the physical failure before touching code.',
  expectedRelevance: 'HIGH',
};

const antiStrategy2_blindStaleReplacement: AntiStrategyCase = {
  id: 'anti-blind-stale-replacement',
  name: 'Blind Stale Replacement',
  antiPatternName: 'blind_stale_search_replace_overwrites',
  description:
    'Agent uses outdated file contents or global regex replacement across the codebase without validating current line state or lexical context.',
  problemSignature: {
    category: 'api_migration',
    languages: ['typescript', 'javascript'],
    repositoryCharacteristics: ['monorepo', 'typed'],
    failureSignature: 'STALE_OVERWRITE_COLLISION',
    failureEvidenceTags: ['stale_file_state', 'unverified_regex'],
  },
  historicalFailurePrompt: 'Rename deprecated API method call across all modules',
  historicalFailureEvidence:
    'Failure: Multi-file global string replacement overwrote unrelated comments, mock fixtures, and generated types, breaking compilation across 12 packages.',
  warningMessage:
    'ANTI-STRATEGY DETECTED: Blind global token replacement without reading current file buffers creates widespread collateral breakage.',
  flawedApproachSteps: [
    { phase: 'modify', action: 'Global regex replace across entire repository without reading', intent: 'Fast update' },
    { phase: 'compile', action: 'Run build and observe hundreds of compile errors', intent: 'Assess damage' },
  ],
  consequences: [
    'Accidental mutation of string literals, mocks, and third-party declaration files',
    'Loss of semantic diff clarity',
    'Requires complete repository checkout rollback',
  ],
  remedySuggestion:
    'Read target files immediately before editing; scope modifications with AST-aware symbols or targeted line ranges.',
  expectedRelevance: 'HIGH',
};

const antiStrategy3_retryWithoutReread: AntiStrategyCase = {
  id: 'anti-retry-without-reread',
  name: 'Retry Without Reread',
  antiPatternName: 'tight_retry_loop_without_re-reading_diagnostics',
  description:
    'Agent encounters a build or test failure and repeatedly re-invokes the same tool or command without reading compiler output or updating internal beliefs.',
  problemSignature: {
    category: 'compile_failure',
    languages: ['typescript', 'cpp', 'rust'],
    repositoryCharacteristics: ['compiled', 'typed'],
    failureSignature: 'STUBBORN_RETRY_LOOP',
    failureEvidenceTags: ['zero_diagnostic_inspection', 'repeated_identical_action'],
  },
  historicalFailurePrompt: 'Fix linker error when compiling worker binary',
  historicalFailureEvidence:
    'Failure: Agent re-executed "npm run build" 5 times consecutively without inspecting the linker diagnostic log or modifying any input flags.',
  warningMessage:
    'ANTI-STRATEGY DETECTED: Stubborn retries without analyzing error output wastes iteration budget without progressing toward resolution.',
  flawedApproachSteps: [
    { phase: 'compile', action: 'Run build', intent: 'Build' },
    { phase: 'compile', action: 'Run build again immediately without changes', intent: 'Hope for different result' },
    { phase: 'compile', action: 'Run build third time', intent: 'Still hoping' },
  ],
  consequences: [
    'Depletes agent tool call budget without producing diagnostic signal',
    'Leaves the workspace in a perpetually failing state',
  ],
  remedySuggestion:
    'Upon any check failure, read and parse the compiler/test error output before deciding the next tactical action.',
  expectedRelevance: 'HIGH',
};

// ============================================================================
// FULL CORPUS DEFINITION
// ============================================================================

export const DETERMINISTIC_SEMANTIC_CORPUS: SemanticStrategyCorpus = {
  version: '1.0.0',
  description:
    'Deterministic acceptance corpus for semantic engineering-strategy transfer validation, covering structural positive pairs, cross-language pairs, negative lexical pairs, and historical anti-strategy cases.',
  structuralPairs: [structuralPair1, mediumPairPagination],
  crossLanguagePairs: [crossLanguagePair],
  negativePairs: [negativePairLexicalSimilarity],
  antiStrategyCases: [
    antiStrategy1_editBeforeReproduction,
    antiStrategy2_blindStaleReplacement,
    antiStrategy3_retryWithoutReread,
  ],
};
