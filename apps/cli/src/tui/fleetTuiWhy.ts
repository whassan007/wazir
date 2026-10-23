import { promptCacheReuse, promptCacheSource } from '@wazir/runtimes-interfaces';
import { buildCanaryRollbackWhy, rollbackEntryFromRecord } from './canaryTimeline.js';
import type { WhyExplanationData } from './observabilityViews.js';

export function buildFleetWhyExplanation(tui: any, topic: string): WhyExplanationData {
  const t = topic.toLowerCase().trim();
  const card = tui.agents.get(tui.selectedTaskId ?? '') ?? tui.getAgents()[0];
  const width = 84;
  const maxRows = 24;

  switch (t) {
    // Each branch reports only state observed in engine records. Absent evidence is
    // UNKNOWN and carries no immutableHash: a fabricated digest would read as proof.
    case 'model': {
      const modelId = card?.modelId ?? tui.selectedModelId;
      return {
        topic: 'model',
        headline: 'Model assignment for selected task',
        decision: modelId ? `Assigned model [${modelId}]` : 'UNKNOWN — no model assignment recorded',
        rationale: [
          modelId
            ? 'Assignment read from the task card; routing scores are not persisted for this view.'
            : 'No task card with a model assignment is selected.',
        ],
        evidence: [
          { label: 'Selected Model', value: modelId ?? 'UNKNOWN' },
          { label: 'Routing Confidence', value: 'UNKNOWN' },
        ],
        controllerAudit: { source: 'Task card (FleetTui)', verifiedAt: new Date() },
        width,
        maxRows,
      };
    }

    case 'worker': {
      const comp = tui.engine.computers.list()[0];
      return {
        topic: 'worker',
        headline: 'Worker placement',
        decision: comp ? `Registered worker [${comp.id}]` : 'UNKNOWN — no worker registered',
        rationale: [
          comp
            ? 'Values read from ComputerRegistry; per-task placement decisions are not recorded here.'
            : 'ComputerRegistry has no registered computers.',
        ],
        evidence: [
          { label: 'Node Identifier', value: comp?.id ?? 'UNKNOWN' },
          { label: 'Memory', value: comp?.hardware?.memoryGB !== undefined ? `${comp.hardware.memoryGB}GB` : 'UNKNOWN' },
          { label: 'Active Reservations', value: comp?.reservations?.length ?? 'UNKNOWN' },
          { label: 'Health Status', value: comp?.status ? String(comp.status).toUpperCase() : 'UNKNOWN' },
          { label: 'Placement Decision', value: 'UNKNOWN' },
        ],
        controllerAudit: { source: 'ComputerRegistry', verifiedAt: new Date() },
        width,
        maxRows,
      };
    }

    case 'tool': {
      return {
        topic: 'tool',
        headline: 'Policy Engine authorization',
        decision: 'UNKNOWN — no policy decision record is attached to this view',
        rationale: [
          'Tool authorization is decided per call by PolicyEngine / ApprovalQueue.',
          'Open /evidence for the recorded tool receipts of a task.',
        ],
        evidence: [{ label: 'Policy Decision', value: 'UNKNOWN' }],
        controllerAudit: { source: 'PolicyEngine / ApprovalQueue', verifiedAt: new Date() },
        width,
        maxRows,
      };
    }

    case 'context': {
      const samples = tui.contextSamples ?? [];
      const lastSample = samples[samples.length - 1];
      const cache = lastSample?.cache;
      const readStatus = cache?.cacheReadTokens?.status ?? 'UNKNOWN';
      const inputStatus = cache?.inputTokens?.status ?? 'UNKNOWN';
      const isUnsupported = readStatus === 'UNSUPPORTED' || cache?.cacheWriteTokens?.status === 'UNSUPPORTED';
      const providerName = cache?.provider ?? 'Provider';

      let decision = 'Cache savings: UNKNOWN';
      if (isUnsupported) {
        decision = 'Cache savings: UNKNOWN';
      } else if (readStatus === 'OBSERVED' && inputStatus === 'OBSERVED') {
        decision = 'Cache savings: OBSERVED';
      } else if (readStatus === 'ESTIMATED' || inputStatus === 'ESTIMATED') {
        decision = 'Cache savings: ESTIMATED';
      }

      const rationale: string[] = [];
      if (isUnsupported) {
        rationale.push(`${providerName} does not support prompt cache telemetry on wire responses.`);
        rationale.push('Prompt cache token savings cannot be observed directly from provider metadata.');
      } else if (readStatus === 'OBSERVED') {
        rationale.push(`Provider ${providerName} returned verified prompt cache usage on completion wire.`);
        rationale.push('Cache read tokens directly observed from prompt_tokens_details or proxy headers.');
      } else if (readStatus === 'ESTIMATED') {
        rationale.push('Prompt cache token savings estimated from stable prefix overlap heuristics.');
      } else {
        rationale.push('No prompt cache telemetry recorded for current context sample window.');
      }

      return {
        topic: 'context',
        headline: 'Context memory & prompt cache telemetry',
        decision,
        rationale,
        evidence: [
          { label: 'Provider', value: cache?.provider ?? 'UNKNOWN' },
          { label: 'Cache Read', value: cache?.cacheReadTokens?.status === 'OBSERVED' ? String(cache.cacheReadTokens.value) : (cache?.cacheReadTokens?.status ?? 'UNKNOWN') },
          { label: 'Cache Write', value: cache?.cacheWriteTokens?.status === 'OBSERVED' ? String(cache.cacheWriteTokens.value) : (cache?.cacheWriteTokens?.status ?? 'UNKNOWN') },
          { label: 'Effective Reuse', value: cache ? promptCacheReuse(cache) : 'UNKNOWN' },
          { label: 'Source', value: cache ? promptCacheSource(cache) : 'UNKNOWN' },
        ],
        controllerAudit: {
          source: 'ContextRevisionService / TelemetryService',
          verifiedAt: new Date(),
        },
        width,
        maxRows,
      };
    }

    case 'candidate': {
      const searches = tui.engine.solutionSearch?.listSearches() ?? [];
      const activeSearch = searches[searches.length - 1];
      const cand = activeSearch?.selectedCandidate;
      const check = (name: string) => {
        const c = cand?.checks?.find((r: { name: string }) => r.name === name);
        return c ? (c.ok ? 'PASS' : 'FAIL') : 'UNKNOWN';
      };
      const onFrontier = cand && activeSearch?.paretoFrontier?.candidates
        ? activeSearch.paretoFrontier.candidates.some((c: { candidateId: string }) => c.candidateId === cand.candidateId)
        : 'UNKNOWN';
      return {
        topic: 'candidate',
        headline: 'Candidate selection',
        decision: cand ? `Selected candidate [${cand.candidateId}]` : 'UNKNOWN — no candidate selected',
        rationale: [activeSearch?.selectionReason || 'No selection reason recorded.'],
        evidence: [
          { label: 'Candidate ID', value: cand?.candidateId ?? 'UNKNOWN' },
          { label: 'Pareto Frontier', value: onFrontier },
          { label: 'Build Check', value: check('build') },
          { label: 'Test Check', value: check('test') },
        ],
        controllerAudit: { source: 'SolutionSearchService', verifiedAt: new Date() },
        width,
        maxRows,
      };
    }

    case 'prune': {
      const searches = tui.engine.solutionSearch?.listSearches() ?? [];
      const pruned = (searches[searches.length - 1]?.candidates ?? []).filter(
        (c: { isPruned?: boolean; prunedReason?: string }) => c.isPruned || c.prunedReason,
      );
      return {
        topic: 'prune',
        headline: 'Search branch pruning',
        decision: pruned.length ? `Pruned ${pruned.length} candidate(s)` : 'UNKNOWN — no pruned candidates recorded',
        rationale: pruned.length
          ? pruned.slice(0, 5).map((c: { candidateId: string; prunedReason?: string }) => `${c.candidateId}: ${c.prunedReason ?? 'reason not recorded'}`)
          : ['The active search has no pruned candidates on record.'],
        evidence: [{ label: 'Pruned Count', value: pruned.length ? pruned.length : 'UNKNOWN' }],
        controllerAudit: { source: 'SolutionSearchService', verifiedAt: new Date() },
        width,
        maxRows,
      };
    }

    case 'complete':
    case 'incomplete': {
      // Derived only from the durable ExecutionRecord (see inspectVerificationEvidence).
      const cached = tui.currentEvidenceInspection();
      if (!cached) {
        return {
          topic: 'complete',
          headline: 'No execution evidence loaded',
          decision: 'UNKNOWN — completion cannot be asserted without an execution record',
          rationale: ['Open /evidence for a task with an execution record.', 'MODEL CLAIM != EXECUTION EVIDENCE: model narration is not consulted.'],
          evidence: [],
          controllerAudit: { source: 'ExecutionEngine record / VerificationEvidenceInspector', verifiedAt: new Date() },
          width,
          maxRows,
        };
      }
      const { inspection, why } = cached;
      return {
        topic: why.complete ? 'complete' : 'incomplete',
        headline: why.complete ? `Why complete? Evidence chain for R${inspection.currentRevision}` : `Why incomplete? Missing evidence for R${inspection.currentRevision}`,
        decision: why.complete ? 'Completion eligible: YES' : 'Completion eligible: NO',
        rationale: why.complete ? why.chain : why.missing,
        evidence: inspection.slots.map((sl: any) => ({ label: sl.oracle, value: sl.status === 'MISSING' ? 'MISSING' : `${sl.status} @R${sl.revision} exit ${sl.exitCode}` })),
        controllerAudit: {
          source: `ExecutionEngine record ${inspection.executionId}`,
          verifiedAt: new Date(),
          immutableHash: String(inspection.workspaceDigest),
        },
        width,
        maxRows,
      };
    }

    case 'rollback': {
      // Prefer exact stored canary evidence: the timeline's selected rollback, else the
      // timeline canary's record, else the most recently rolled-back canary record.
      const selected = tui.getSelectedCanaryTimelineEntry();
      if (tui.canaryTimeline && selected && (selected.label === 'ROLLBACK' || selected.guardEvidence)) {
        return buildCanaryRollbackWhy(selected, tui.canaryTimeline.canaryId, width, maxRows);
      }
      const canaryRecords: any[] = (tui.engine.optimizer as any)?.getCanaryDeploymentService?.()?.listDeployments?.() ?? [];
      const rolledBack = canaryRecords
        .filter((r) => r?.rollbackReason)
        .sort((a, b) => (a.canaryId === tui.canaryTimeline?.canaryId ? -1 : b.canaryId === tui.canaryTimeline?.canaryId ? 1 : 0)
          || new Date(b.completedAt ?? b.updatedAt ?? 0).getTime() - new Date(a.completedAt ?? a.updatedAt ?? 0).getTime());
      const storedEntry = rolledBack[0] ? rollbackEntryFromRecord(rolledBack[0]) : undefined;
      if (storedEntry) {
        return buildCanaryRollbackWhy(storedEntry, rolledBack[0].canaryId, width, maxRows);
      }
      return {
        topic: 'rollback',
        headline: 'Canary rollback',
        decision: 'UNKNOWN — no rolled-back canary on record',
        rationale: ['CanaryDeploymentService has no deployment with a rollback reason.'],
        evidence: [{ label: 'Rollback Status', value: 'UNKNOWN' }],
        controllerAudit: { source: 'CanaryDeploymentService / RegressionGuard', verifiedAt: new Date() },
        width,
        maxRows,
      };
    }

    default: {
      return {
        topic: t || 'unknown',
        headline: `Topic '${t}' explanation`,
        decision: 'Topic not recognized',
        rationale: [
          'Valid explainability topics: why [model|worker|tool|candidate|prune|complete|rollback]',
          'All answers must be grounded in structured controller evidence, never LLM prose',
        ],
        evidence: [
          { label: 'Supported Topic 1', value: 'model (empirical capability routing)' },
          { label: 'Supported Topic 2', value: 'worker (topology & resource admission)' },
          { label: 'Supported Topic 3', value: 'tool (policy authorization & sandbox)' },
          { label: 'Supported Topic 4', value: 'candidate (Pareto frontier selection)' },
          { label: 'Supported Topic 5', value: 'prune (MCTS early termination)' },
          { label: 'Supported Topic 6', value: 'complete (physical verification proof)' },
          { label: 'Supported Topic 7', value: 'rollback (RegressionGuard trigger)' },
        ],
        controllerAudit: {
          source: 'MissionControl / ExplainabilityService',
          verifiedAt: new Date(),
        },
        width,
        maxRows,
      };
    }
  }
}
