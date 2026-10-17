import { renderCompactLogo, renderUnicodeMediumLogo, formatWorkspacePath, detectTerminalCapabilities } from '../brand.js';
import { color } from '../colors.js';

export interface MissionSnapshot {
  workspace: string;
  agents: number;
  running: number;
  ready: number;
  installed: number;
  computers: number;
  jobs: Array<{ id: string; title: string; status: string }>;
  models: Array<{ name: string; provider: string; ready: boolean }>;
  runtimes: Array<{ name: string; health: string }>;
  approvals: number;
  inputTokens: number;
  outputTokens: number;
  events: Array<{ time: string; kind: string; text: string }>;
  evidence: string[];
}

/** Read-only projection. No sample workers, guessed prices, or synthetic verification. */
export function renderMissionControl(s: MissionSnapshot, width: number, height: number): string[] {
  const lines: string[] = [];
  const dense = height < 23;
  const section = (title: string) => color.bold(color.cyan(`  ${title}`));
  const caps = detectTerminalCapabilities({ columns: width });
  const fullLogo = width >= 76 && height >= 38;
  if (fullLogo) {
    const logo = renderUnicodeMediumLogo(caps.colorMode).split('\n');
    const intro = [
      color.bold('MISSION CONTROL'),
      'Autonomous Agent Orchestration',
      '',
      `${s.running} executing / ${s.agents} agents registered`,
      `${s.ready} ready / ${s.installed} models discovered`,
      `${s.computers} computers / ${s.runtimes.length} runtimes`,
      s.approvals ? color.yellow(`${s.approvals} approvals need review → Tab`) : color.green('Approval queue clear'),
      '',
      'Enter a task below to start.',
      '!command runs in this workspace.',
      'Tab views · 5 models · 6 evidence',
    ];
    logo.forEach((line, i) => lines.push(line + ' '.repeat(Math.max(1, 38 - line.replace(/\x1b\[[0-9;]*m/g, '').length)) + (intro[i] ?? '')));
  } else {
    lines.push(`  ${renderCompactLogo({ colorMode: caps.colorMode, unicode: caps.unicode, maxWidth: width })}`);
    lines.push(`  ${s.running} executing · ${s.ready}/${s.installed} models ready · ${s.approvals} approvals`);
  }
  if (!dense) lines.push('');
  lines.push(section('EXECUTION MONITOR'));
  if (!s.jobs.length) lines.push('  No jobs yet. Describe a task in the prompt.');
  for (const job of s.jobs.slice(0, dense ? 1 : 3)) {
    const status = job.status.toUpperCase();
    const badge = /FAIL|ERROR/.test(status) ? color.red(status) : /COMPLETE/.test(status) ? color.green(status) : color.cyan(status);
    lines.push(`  ${badge}  ${job.title}  ${color.gray(job.id)}`);
  }
  if (!dense) lines.push(color.gray('  ↑↓ select · Enter inspect · [ / ] cycle tasks · Enter full output'));
  if (!dense) lines.push('');
  lines.push(section('MODELS & PROVIDERS'));
  const modelLimit = dense ? 1 : 3;
  if (!s.models.length) lines.push(color.yellow('  No models discovered. /refresh or /model to configure.'));
  for (const m of s.models.slice(0, modelLimit)) {
    lines.push(`  ${m.ready ? color.green('READY') : color.yellow('NOT READY')}  ${m.name}  ${color.gray(m.provider)}`);
  }
  if (s.models.length > modelLimit) lines.push(color.gray(`  +${s.models.length - modelLimit} models · 5 opens model intelligence`));
  for (const r of s.runtimes.slice(0, dense ? 0 : 2)) lines.push(`  ${r.name} · ${r.health === 'healthy' ? color.green(r.health) : color.yellow(r.health)}`);
  lines.push(`  Session tokens ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out · Cost: unreported`);
  if (!dense) lines.push('');
  lines.push(section('ACTIVITY & TOOL CALLS'));
  if (!s.events.length) lines.push(color.gray('  Waiting for execution events. Tab opens the live timeline.'));
  for (const e of s.events.slice(dense ? -1 : -3)) lines.push(`  ${e.time} ${color.cyan(e.kind.toUpperCase())} ${e.text}`);
  if (!dense) lines.push('');
  lines.push(section('VERIFICATION EVIDENCE'));
  lines.push(...(s.evidence.length ? s.evidence.map(e => `  ${e}`) : [color.gray('  No verification recorded. 6 opens checks and provenance.')]));
  // Keep the operational sections reachable on short terminals instead of letting
  // a decorative logo consume the content viewport.
  return lines.slice(0, height);
}

export function missionHeader(workspace: string, view: string, width: number): string[] {
  return [
    ` ${renderCompactLogo({ maxWidth: 20, colorMode: detectTerminalCapabilities().colorMode })}  ${color.bold('MISSION CONTROL')}`,
    ` ${formatWorkspacePath(workspace, Math.max(12, width - 25))}  ${color.cyan(`[View: ${view.toUpperCase()}]`)}`,
    color.gray(' 1 Home   Tab Timeline / Approvals / Worktrees   5 Models   6 Evidence   ? Help'),
  ];
}
