import path from 'node:path';
import type { PolicyActionRequest, PolicyDecision } from '@wazir/core';

export interface SessionPolicyConfig {
  /** Pause with an `ask` decision every N USD of cumulative LLM spend (0 disables). */
  spendPauseIntervalUSD?: number;
  /** Require human confirmation on `git push` if a package install occurred in the session. */
  gateGitPushAfterPackageInstall?: boolean;
  /** Restrict file writes strictly to paths created by the agent in this session. */
  restrictWritesToAgentCreated?: boolean;
}

export interface SessionPolicyState {
  sessionId: string;
  spendUSD: number;
  lastSpendCheckpointUSD: number;
  packagesInstalled: string[];
  agentCreatedFiles: Set<string>;
  restrictWritesToAgentCreated: boolean;
}

const PACKAGE_INSTALL_RE = /\b(npm\s+(install|i|ci|add)|pnpm\s+(install|add|i)|yarn\s+(install|add)|pip3?\s+install|cargo\s+install|brew\s+install)\b/i;
const GIT_PUSH_RE = /\bgit\s+push\b/i;

/**
 * Deterministic stateful policy hooks tracking dynamic session history
 * (Omnigent pattern): spend checkpoints, contextual `git push` gates after
 * package downloads, and agent-created-only write restrictions.
 */
export class SessionPolicyTracker {
  private readonly sessions = new Map<string, SessionPolicyState>();

  constructor(private readonly defaultConfig: SessionPolicyConfig = {}) {}

  getOrCreateSession(sessionId: string, config?: SessionPolicyConfig): SessionPolicyState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        spendUSD: 0,
        lastSpendCheckpointUSD: 0,
        packagesInstalled: [],
        agentCreatedFiles: new Set<string>(),
        restrictWritesToAgentCreated: config?.restrictWritesToAgentCreated ?? this.defaultConfig.restrictWritesToAgentCreated ?? false,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  recordSpend(sessionId: string, deltaUSD: number): SessionPolicyState {
    const state = this.getOrCreateSession(sessionId);
    if (Number.isFinite(deltaUSD) && deltaUSD > 0) {
      state.spendUSD += deltaUSD;
    }
    return state;
  }

  acknowledgeSpendCheckpoint(sessionId: string): void {
    const state = this.getOrCreateSession(sessionId);
    state.lastSpendCheckpointUSD = state.spendUSD;
  }

  recordShellCommand(sessionId: string, command: string): void {
    const state = this.getOrCreateSession(sessionId);
    if (PACKAGE_INSTALL_RE.test(command)) {
      state.packagesInstalled.push(command.trim());
    }
  }

  recordAgentCreatedFile(sessionId: string, filePath: string): void {
    const state = this.getOrCreateSession(sessionId);
    state.agentCreatedFiles.add(path.resolve(filePath));
  }

  /**
   * Evaluates stateful session-history policy rules for a pending action.
   * Returns `null` when no stateful session hook triggers.
   */
  evaluate(
    sessionId: string,
    request: PolicyActionRequest,
    config?: SessionPolicyConfig,
  ): PolicyDecision | null {
    const state = this.getOrCreateSession(sessionId, config);
    const spendInterval = config?.spendPauseIntervalUSD ?? this.defaultConfig.spendPauseIntervalUSD ?? 0;
    const gatePush = config?.gateGitPushAfterPackageInstall ?? this.defaultConfig.gateGitPushAfterPackageInstall ?? true;
    const restrictCreated = config?.restrictWritesToAgentCreated ?? state.restrictWritesToAgentCreated;

    if (spendInterval > 0 && state.spendUSD - state.lastSpendCheckpointUSD >= spendInterval) {
      const delta = (state.spendUSD - state.lastSpendCheckpointUSD).toFixed(2);
      return {
        decision: 'ask',
        rule: 'session-spend-checkpoint',
        tool: request.tool,
        reasons: [`Session spend increased by $${delta} (total $${state.spendUSD.toFixed(2)}, threshold $${spendInterval}). Confirm to continue.`],
      };
    }

    const command = typeof request.input.command === 'string' ? request.input.command : undefined;
    const isShellTool = ['run_shell', 'shell', 'bash', 'shell_command'].includes(request.tool);
    if (gatePush && isShellTool && command && GIT_PUSH_RE.test(command)) {
      if (state.packagesInstalled.length > 0) {
        return {
          decision: 'ask',
          rule: 'session-git-push-after-package-install',
          tool: request.tool,
          command,
          reasons: [`git push requires confirmation because ${state.packagesInstalled.length} package install command(s) ran earlier in this session.`],
        };
      }
    }

    const isWriteTool = ['write_file', 'edit', 'edit_file', 'multi_edit', 'apply_patch', 'delete_file'].includes(request.tool);
    const targetPath =
      typeof request.input.path === 'string'
        ? request.input.path
        : typeof request.input.file_path === 'string'
          ? request.input.file_path
          : undefined;
    if (restrictCreated && isWriteTool && targetPath) {
      const resolved = path.resolve(targetPath);
      if (!state.agentCreatedFiles.has(resolved)) {
        return {
          decision: 'deny',
          rule: 'session-agent-created-files-only',
          tool: request.tool,
          reasons: [`Write to "${targetPath}" denied: session is restricted to agent-created files only.`],
        };
      }
    }

    return null;
  }
}
