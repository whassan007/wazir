import readline from 'node:readline';
import type { PolicyActionRequest, PolicyDecision } from '@wazir/core';
import { color } from './colors.js';

function summarize(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value);
  }
}

/**
 * Interactive approver for policy decisions that require a human (ask).
 * Non-interactive sessions always deny — Wazir never silently allows.
 */
export async function createApprover(
  request: PolicyActionRequest,
  decision: PolicyDecision,
): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.env.WAZIR_AUTO_DENY === '1') {
    return false;
  }

  console.error('');
  console.error(color.bold('  Policy approval required'));
  console.error(`  rule:    ${color.cyan(decision.rule)}`);
  for (const reason of decision.reasons) {
    console.error(`  ${color.gray(reason)}`);
  }
  console.error(`  action:  ${color.yellow(request.tool)} ${color.gray(summarize(request.input))}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question('  approve? [y/N] ', (a) => resolve(a));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
