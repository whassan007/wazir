import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const metricNames = `task_success acceptance_success build_success test_success verification_success
model_calls input_tokens output_tokens peak_context_tokens context_revisions tool_calls tool_failures malformed_actions duplicate_actions
physical_mutations workspace_revisions stale_evidence_attempts false_mutation_events repair_cycles subagents_spawned subagent_failures
wall_time runtime_wait_time model_load_time worker_failures recoveries unknown_outcomes files_read files_changed diff_size
final_claim_matches_filesystem protected_oracles_pass provenance_complete`.split(/\s+/);

export function emptyMetrics() { return Object.fromEntries(metricNames.map(key => [key, null])); }

export async function snapshot(root) {
  const result = {};
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (['.git', 'out', '.wazir', 'node_modules'].includes(entry.name) || /^core(?:\.|$)/.test(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Fixture contains symlink: ${rel}`);
      if (entry.isDirectory()) await visit(abs);
      else {
        const data = await fs.readFile(abs);
        result[rel] = { hash: createHash('sha256').update(data).digest('hex'), bytes: data.length };
      }
    }
  }
  await visit(root);
  return result;
}

export function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => before[key]?.hash !== after[key]?.hash).sort();
}

export function assessRecord(record, { before, after, executionId, completeEvents }) {
  const metrics = emptyMetrics();
  const failures = [];
  const changed = changedPaths(before, after);
  metrics.files_changed = changed;
  if (!record || typeof executionId !== 'string' || record.execution?.id !== executionId) return { metrics, failures: ['Missing matching durable execution record'] };
  const events = record.events ?? [];
  const tools = record.toolCalls ?? [];
  const count = type => events.filter(e => e.type === type).length;
  const revision = record.workspaceState?.revision;
  metrics.model_calls = count('generation.started');
  metrics.input_tokens = record.usage?.input ?? null;
  metrics.output_tokens = record.usage?.output ?? null;
  metrics.context_revisions = count('context.revision.completed');
  metrics.tool_calls = tools.length;
  metrics.tool_failures = tools.filter(t => !t.ok).length;
  metrics.malformed_actions = Math.max(count('action.validation_failed'),
    events.filter(e => e.type === 'agent.turn' && String(e.data?.content).startsWith('ACTION_VALIDATION_FAILED')).length);
  metrics.workspace_revisions = revision ?? null;
  metrics.stale_evidence_attempts = count('evidence.stale') + count('EVIDENCE_STALE');
  // Execution forks include checkpoint forks; they are not a reliable child count.
  metrics.unknown_outcomes = count('tool.call.outcome_unknown');
  metrics.files_read = [...new Set(tools.filter(t => t.tool === 'read').map(t => t.input?.path).filter(Boolean))];
  metrics.repair_cycles = (record.checks ?? []).filter(c => !c.ok).length;
  metrics.task_success = record.execution.status === 'completed' && record.evaluation?.success === true;
  const checks = record.checks ?? [];
  metrics.verification_success = Number.isInteger(revision) && record.evaluation?.workspaceRevision === revision &&
    ['build', 'test'].every(name => {
      const last = checks.filter(c => c.name === name).at(-1);
      return last?.ok === true && last.workspaceRevision === revision;
    });
  const claimed = [...new Set(record.evaluation?.filesChanged ?? [])].filter(p => !p.startsWith('out/') && !/^core(?:\.|$)/.test(p)).sort();
  // This verifies the structured file claim. Free-form prose is retained for review.
  metrics.final_claim_matches_filesystem = JSON.stringify(claimed) === JSON.stringify(changed) && changed.length > 0;
  metrics.provenance_complete = events.length > 0 && tools.length > 0 && metrics.model_calls > 0 &&
    new Set(events.map(e => e.eventId)).size === events.length &&
    events.every((e, i) => e.executionId === executionId && typeof e.eventId === 'string' && Number.isInteger(e.sequence) && (i === 0 || e.sequence === events[i - 1].sequence + 1)) &&
    tools.every(t => {
      // Production CLI stores the dispatch identity in ToolCallRecord.id.
      const id = t.callId ?? t.id;
      const started = events.some(e => e.type === 'tool.started' && (e.callId ?? e.data?.callId) === id);
      const completed = events.some(e => e.type === 'tool.completed' && (e.callId ?? e.data?.callId) === id);
      const denied = t.policyEffect === 'deny' || t.policyEffect === 'ask';
      return typeof id === 'string' && id.length > 0 && completed && (denied ? !started && t.ok === false : started);
    }) && completeEvents === 1;
  for (const key of ['task_success', 'verification_success', 'final_claim_matches_filesystem', 'provenance_complete']) {
    if (metrics[key] !== true) failures.push(key);
  }
  return { metrics, failures };
}
