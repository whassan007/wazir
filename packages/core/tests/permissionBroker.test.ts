import { describe, it, expect, vi } from 'vitest';
import { PermissionBroker } from '../src/permissions/permissionBroker.js';
import { isImportantPermissionOperation } from '../src/permissions/importantOperation.js';
import { redactPermissionText, pickLeastEscalating } from '../src/permissions/adaptorUtils.js';

describe('Permission & Security Classifier (Adapted from Qwen-Live-Harness)', () => {
  describe('isImportantPermissionOperation', () => {
    it('classifies safe inspection commands as non-important', () => {
      expect(isImportantPermissionOperation({ command: 'pwd' })).toBe(false);
      expect(isImportantPermissionOperation({ command: 'ls -la' })).toBe(false);
      expect(isImportantPermissionOperation({ command: 'git status' })).toBe(false);
      expect(isImportantPermissionOperation({ command: 'git diff HEAD~1' })).toBe(false);
      expect(isImportantPermissionOperation({ command: 'git log -n 5' })).toBe(false);
      expect(isImportantPermissionOperation({ operation: 'read' })).toBe(false);
      expect(isImportantPermissionOperation({ operation: 'list' })).toBe(false);
    });

    it('classifies destructive or piped commands as important', () => {
      expect(isImportantPermissionOperation({ command: 'rm -rf /tmp/data' })).toBe(true);
      expect(isImportantPermissionOperation({ command: 'git push origin main' })).toBe(true);
      expect(isImportantPermissionOperation({ command: 'cat file.txt | grep secret' })).toBe(true);
      expect(isImportantPermissionOperation({ command: 'echo "alert" > /etc/hosts' })).toBe(true);
      expect(isImportantPermissionOperation({ command: 'npm install evil-package' })).toBe(true);
      expect(isImportantPermissionOperation({ operation: 'write' })).toBe(true);
      expect(isImportantPermissionOperation({ operation: 'delete' })).toBe(true);
    });
  });

  describe('redactPermissionText', () => {
    it('redacts sensitive API keys and tokens', () => {
      const text = 'curl -H "Authorization: Bearer sk-ant-api03-abcdef1234567890" https://api.anthropic.com';
      const redacted = redactPermissionText(text);
      expect(redacted).not.toContain('abcdef1234567890');
      expect(redacted).toContain('[REDACTED]');
    });

    it('redacts GitHub and AWS credentials', () => {
      const gh = 'clone with token ghp_123456789012345678901234567890';
      expect(redactPermissionText(gh)).toContain('[REDACTED_GH_TOKEN]');

      const aws = 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      expect(redactPermissionText(aws)).toContain('[REDACTED_AWS_KEY]');
    });
  });

  describe('PermissionBroker', () => {
    it('auto-answers when operation is safe read-only', async () => {
      const onDecision = vi.fn();
      const broker = new PermissionBroker({ onDecision });

      const result = await broker.requestPermission({
        requestId: 'req-1',
        backendName: 'qwen-code',
        sessionId: 'sess-1',
        title: 'Run git status',
        options: [
          { optionId: 'opt-allow', kind: 'proceed', escalation: 'once' },
          { optionId: 'opt-deny', kind: 'reject', escalation: 'once' },
        ],
        details: { command: 'git status' },
      });

      expect(result.optionId).toBe('opt-allow');
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedDecision: 'allow',
          auto: true,
        }),
      );
    });

    it('parks and requires decision for important operations', async () => {
      const onAsk = vi.fn();
      const broker = new PermissionBroker({ onAsk });

      const requestPromise = broker.requestPermission({
        requestId: 'req-2',
        backendName: 'qwen-code',
        sessionId: 'sess-1',
        title: 'Run dangerous rm command',
        options: [
          { optionId: 'opt-allow', kind: 'proceed', escalation: 'once' },
          { optionId: 'opt-deny', kind: 'reject', escalation: 'once' },
        ],
        details: { command: 'rm -rf ./temp' },
      });

      expect(onAsk).toHaveBeenCalled();
      const pendingList = broker.getPending();
      expect(pendingList).toHaveLength(1);

      // Operator decides to allow
      broker.decide(pendingList[0].requestHandle, 'allow');

      const outcome = await requestPromise;
      expect(outcome.optionId).toBe('opt-allow');
      expect(broker.getPending()).toHaveLength(0);
    });

    it('handles deny decisions cleanly', async () => {
      const broker = new PermissionBroker();

      const requestPromise = broker.requestPermission({
        requestId: 'req-3',
        backendName: 'claude-code',
        sessionId: 'sess-2',
        title: 'Mutate system file',
        options: [
          { optionId: 'opt-allow', kind: 'proceed', escalation: 'once' },
          { optionId: 'opt-deny', kind: 'reject', escalation: 'once' },
        ],
        details: { command: 'chmod 777 /etc' },
      });

      const handle = broker.getPending()[0].requestHandle;
      broker.decide(handle, 'deny');

      const outcome = await requestPromise;
      expect(outcome.cancelled).toBe(true);
      expect(outcome.optionId).toBe('opt-deny');
    });
  });
});
