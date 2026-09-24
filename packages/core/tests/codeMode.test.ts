import { describe, it, expect } from 'vitest';
import {
  CodeModeService,
  VerificationEngine,
  type CodeModeToolExecutor,
} from '../src/index.js';

describe('Gate 3: Code Mode / Batched Tool Execution', () => {
  // Simulated file system and tool executor that mirrors ToolRegistry -> PolicyEngine -> ExecutionEngine
  const createMockEnvironment = (options: {
    denyPolicyPaths?: string[];
    verificationEngine?: VerificationEngine;
  } = {}) => {
    const files = new Map<string, string>([
      ['file1.txt', 'Content 1'],
      ['file2.txt', 'Content 2'],
      ['file3.txt', 'Content 3'],
      ['file4.txt', 'Content 4'],
      ['file5.txt', 'Content 5'],
    ]);

    const verificationEngine = options.verificationEngine ?? new VerificationEngine();

    const toolExecutor: CodeModeToolExecutor = async (toolName, input, ctx) => {
      // 1. Policy check
      if (input.path && options.denyPolicyPaths?.includes(input.path as string)) {
        return {
          ok: false,
          output: '',
          error: `POLICY_DENIED: path '${input.path}' is restricted`,
          failureClass: 'POLICY_DENIED',
          durationMs: 1,
        };
      }

      // 2. Read tool
      if (toolName === 'read') {
        const filePath = input.path as string;
        if (!files.has(filePath)) {
          return {
            ok: false,
            output: '',
            error: `File not found: ${filePath}`,
            failureClass: 'TOOL_EXECUTION_FAILED',
            durationMs: 1,
          };
        }
        return {
          ok: true,
          output: files.get(filePath)!,
          durationMs: 2,
        };
      }

      // 3. Write tool (physical mutation -> workspace revision advance)
      if (toolName === 'write') {
        const filePath = input.path as string;
        const content = input.content as string;
        const before = files.get(filePath) ?? null;
        files.set(filePath, content);

        verificationEngine.trackPhysicalMutation({
          filePath,
          beforeContent: before,
          afterContent: content,
        });

        return {
          ok: true,
          output: `Wrote ${content.length} bytes to ${filePath}`,
          durationMs: 3,
        };
      }

      // 4. Search tool
      if (toolName === 'search') {
        const query = (input.query as string) ?? '';
        const matches = Array.from(files.entries())
          .filter(([_, content]) => content.includes(query))
          .map(([f, c]) => `${f}: ${c}`);
        return {
          ok: true,
          output: matches.join('\n'),
          durationMs: 2,
        };
      }

      // Unknown tool
      return {
        ok: false,
        output: '',
        error: `Unknown tool: ${toolName}`,
        failureClass: 'TOOL_VALIDATION_FAILED',
        durationMs: 0,
      };
    };

    return { files, verificationEngine, toolExecutor };
  };

  it('proves 5 reads execute from one model action with deterministic parallel returns', async () => {
    const { toolExecutor } = createMockEnvironment();
    const codeMode = new CodeModeService({ toolExecutor });

    const script = `
      const [f1, f2, f3, f4, f5] = await Promise.all([
        wazir.read('file1.txt'),
        wazir.read('file2.txt'),
        wazir.read('file3.txt'),
        wazir.read('file4.txt'),
        wazir.read('file5.txt'),
      ]);
      return { f1, f2, f3, f4, f5 };
    `;

    const result = await codeMode.executeScript(script);

    expect(result.ok).toBe(true);
    expect(result.returnValue).toEqual({
      f1: 'Content 1',
      f2: 'Content 2',
      f3: 'Content 3',
      f4: 'Content 4',
      f5: 'Content 5',
    });

    // Sub-calls and round trip measurements
    expect(result.toolCallsExecuted).toBe(5);
    expect(result.subCalls).toHaveLength(5);
    expect(result.roundTripReduction.actualTurnCount).toBe(1);
    expect(result.roundTripReduction.equivalentTurnCount).toBe(5);
    expect(result.roundTripReduction.roundTripsSaved).toBe(4);
  });

  it('enforces policy engine restrictions within Code Mode', async () => {
    const { toolExecutor } = createMockEnvironment({
      denyPolicyPaths: ['/etc/shadow', 'secret.key'],
    });
    const codeMode = new CodeModeService({ toolExecutor });

    const script = `
      await wazir.read('/etc/shadow');
    `;

    const result = await codeMode.executeScript(script);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('POLICY_DENIED');
  });

  it('preserves provenance for every sub-call', async () => {
    const { toolExecutor } = createMockEnvironment();
    const codeMode = new CodeModeService({ toolExecutor });

    const script = `
      const a = await wazir.read('file1.txt');
      const b = await wazir.read('file2.txt');
      return { a, b };
    `;

    const result = await codeMode.executeScript(script);
    expect(result.ok).toBe(true);
    expect(result.subCalls).toHaveLength(2);

    for (const sub of result.subCalls) {
      expect(sub.callId).toMatch(/^cm-/);
      expect(sub.tool).toBe('read');
      expect(sub.provenance).toBeDefined();
      expect(sub.provenance?.source).toBe('code_mode');
      expect(sub.timestamp).toBeInstanceOf(Date);
      expect(sub.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('preserves workspace revision semantics during batched mutations', async () => {
    const { toolExecutor, verificationEngine } = createMockEnvironment();
    const codeMode = new CodeModeService({ toolExecutor });

    expect(verificationEngine.getRevision()).toBe(0);

    const script = `
      await wazir.write('new1.txt', 'First batch write');
      await wazir.write('new2.txt', 'Second batch write');
      return 'done';
    `;

    const result = await codeMode.executeScript(script);
    expect(result.ok).toBe(true);

    // Each physical mutation advanced the workspace revision
    expect(verificationEngine.getRevision()).toBe(2);
    expect(verificationEngine.getFilesChanged()).toContain('new1.txt');
    expect(verificationEngine.getFilesChanged()).toContain('new2.txt');
  });

  it('terminates script when execution exceeds timeout', async () => {
    const { toolExecutor } = createMockEnvironment();
    const codeMode = new CodeModeService({
      toolExecutor,
      limits: { timeoutMs: 50 },
    });

    const script = `
      await new Promise(r => setTimeout(r, 500));
      return 'should not reach here';
    `;

    const result = await codeMode.executeScript(script);
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('CODE_MODE_TIMEOUT');
  });

  it('terminates script when call budget is exceeded', async () => {
    const { toolExecutor } = createMockEnvironment();
    const codeMode = new CodeModeService({
      toolExecutor,
      limits: { maxCalls: 3 },
    });

    const script = `
      await wazir.read('file1.txt');
      await wazir.read('file2.txt');
      await wazir.read('file3.txt');
      await wazir.read('file4.txt'); // 4th call exceeds budget of 3
      return 'should not reach here';
    `;

    const result = await codeMode.executeScript(script);
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('CODE_MODE_BUDGET_EXCEEDED');
    expect(result.error).toContain('CODE_MODE_BUDGET_EXCEEDED');
  });

  it('supports cancellation via AbortSignal', async () => {
    const { toolExecutor } = createMockEnvironment();
    const codeMode = new CodeModeService({ toolExecutor });

    const controller = new AbortController();
    controller.abort(); // already aborted

    const script = `
      await wazir.read('file1.txt');
      return 'done';
    `;

    const result = await codeMode.executeScript(script, {
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('CANCELLED');
  });

  it('represents failed sub-operations accurately', async () => {
    const { toolExecutor } = createMockEnvironment();
    const codeMode = new CodeModeService({ toolExecutor });

    const script = `
      await wazir.read('nonexistent_file.txt');
    `;

    const result = await codeMode.executeScript(script);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('File not found');
    expect(result.subCalls).toHaveLength(1);
    expect(result.subCalls[0].ok).toBe(false);
  });

  it('prevents Code Mode from bypassing ToolRegistry into host globals', async () => {
    const { toolExecutor } = createMockEnvironment();
    const codeMode = new CodeModeService({ toolExecutor });

    const script = `
      return typeof process;
    `;

    const result = await codeMode.executeScript(script);
    expect(result.ok).toBe(true);
    // process should NOT exist in sandbox
    expect(result.returnValue).toBe('undefined');

    const escapeScript = `
      require('fs');
    `;
    const escapeResult = await codeMode.executeScript(escapeScript);
    expect(escapeResult.ok).toBe(false);
    expect(escapeResult.error).toContain('require is not defined');
  });
});
