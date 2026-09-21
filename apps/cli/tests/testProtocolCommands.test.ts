import { describe, expect, it } from 'vitest';
import { actionProtocolTestCommand } from '../src/commands.js';

// `wa test action-protocol` — the deterministic half of the protocol diagnostics (the
// other half, `wa test model-protocol`, needs a real model/runtime and isn't suitable
// for CI). Never invokes a model; exercises parseAction -> normalizeAction ->
// missingRequiredFields exactly as the live agent loop does.
describe('actionProtocolTestCommand', () => {
  it('exits 0 and reports every case passing against the current parser/validator', () => {
    const result = actionProtocolTestCommand();
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/(\d+)\/\1 passed/);
    expect(result.output).not.toContain('FAIL');
  });

  it('covers the two real bugs found live this session by name', () => {
    const result = actionProtocolTestCommand();
    expect(result.output).toContain('wrapped one level too deep under "content"');
    expect(result.output).toContain('task prose quotes a brace before the real action');
  });
});
