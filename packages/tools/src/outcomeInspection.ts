import type { ToolCallCheckpoint, ToolOutcomeInspection } from '@wazir/core';
import { readFile } from 'node:fs/promises';
import { resolveInsideProject } from './paths.js';

/**
 * Physical-state inspection for a tool call whose outcome was never recorded (the
 * process died between dispatch and result). Only answers what the filesystem can
 * prove; everything else is UNDETERMINED and left for an operator.
 *
 * - READ_ONLY calls have no side effect: NOT_APPLIED, repeat freely.
 * - write: the target holding exactly the intended content proves APPLIED. Anything
 *   else is NOT_APPLIED (writes are atomic, so the target is either the old or the new
 *   file), and re-issuing it is safe because it sets exact content.
 * - edit (single replacement): old text present and new text absent proves NOT_APPLIED;
 *   old absent and new present proves APPLIED. Overlapping or ambiguous text, or a file
 *   that holds neither (changed by something else since), is UNDETERMINED.
 * - shell, git, MCP and other external effects: UNDETERMINED.
 */
export async function inspectToolOutcome(projectRoot: string, call: Pick<ToolCallCheckpoint, 'toolName' | 'input' | 'sideEffectClass'>): Promise<ToolOutcomeInspection> {
  if (call.sideEffectClass === 'READ_ONLY') {
    return { outcome: 'NOT_APPLIED', evidence: `'${call.toolName}' is read-only; an interrupted call left no side effect` };
  }
  const input = (call.input ?? {}) as Record<string, unknown>;
  if ((call.toolName !== 'write' && call.toolName !== 'edit') || typeof input.path !== 'string') {
    return { outcome: 'UNDETERMINED', evidence: `no physical check can prove whether '${call.toolName}' took effect` };
  }

  let current: string | null;
  try {
    const { real } = await resolveInsideProject(projectRoot, input.path);
    current = await readFile(real, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { outcome: 'UNDETERMINED', evidence: `cannot read '${input.path}': ${error instanceof Error ? error.message : String(error)}` };
    }
    current = null;
  }

  if (call.toolName === 'write') {
    if (typeof input.content !== 'string') return { outcome: 'UNDETERMINED', evidence: 'write call has no recorded content to compare' };
    return current === input.content
      ? { outcome: 'APPLIED', evidence: `'${input.path}' holds exactly the intended content` }
      : { outcome: 'NOT_APPLIED', evidence: `'${input.path}' ${current === null ? 'does not exist' : 'differs from the intended content'}; write sets exact content, so re-issuing it is safe` };
  }

  const oldString = typeof input.oldString === 'string' ? input.oldString : '';
  const newString = typeof input.newString === 'string' ? input.newString : '';
  if (current === null) return { outcome: 'UNDETERMINED', evidence: `'${input.path}' no longer exists` };
  if (!oldString || input.replaceAll === true || oldString.includes(newString) || newString.includes(oldString)) {
    return { outcome: 'UNDETERMINED', evidence: 'edit text overlaps or replaces all occurrences; presence checks cannot prove the outcome' };
  }
  const hasOld = current.includes(oldString);
  const hasNew = current.includes(newString);
  if (hasOld && !hasNew) return { outcome: 'NOT_APPLIED', evidence: `'${input.path}' still contains the original text and not the replacement` };
  if (!hasOld && hasNew) return { outcome: 'APPLIED', evidence: `'${input.path}' contains the replacement and not the original text` };
  return { outcome: 'UNDETERMINED', evidence: `'${input.path}' contains ${hasOld ? 'both' : 'neither'} the original and the replacement text` };
}
