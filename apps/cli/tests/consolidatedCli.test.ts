import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerConsolidatedCommands } from '../src/commands/consolidatedCommands.js';

describe('Consolidated Wazir CLI Commands', () => {
  it('registers fleet, studio, optimize, extensions, eval, and inspect commands deterministically', () => {
    const program = new Command();
    program.command('fleet');
    registerConsolidatedCommands(program);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('fleet');
    expect(names).toContain('studio');
    expect(names).toContain('optimize');
    expect(names).toContain('extensions');
    expect(names).toContain('eval');
    expect(names).toContain('inspect');
  });
});
