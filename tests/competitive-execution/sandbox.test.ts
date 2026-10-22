import path from 'node:path';
import { promises as fs } from 'node:fs';
import { expect, it } from 'vitest';
import { fixture, config, policy } from './harness.js';
import { CompetitiveExecution, raceGit } from '../../packages/core/src/services/competitiveExecution.js';
import { verifyCompetitiveCandidate } from '../../apps/cli/src/competitive.js';
import { sandboxStatus } from '../../packages/tools/src/sandbox.js';

it('production verifier either independently validates candidate in a real OS sandbox or fails closed', async () => {
  const f = await fixture();
  try {
    const service = new CompetitiveExecution({ ...f.deps, verify: verifyCompetitiveCandidate });
    const record = await service.create({ repository: f.root, task: 'Fix add', configurations: [config('a')], policy });
    const result = await service.run(record.id);
    if (sandboxStatus().mode === 'none') {
      expect(result.state).toBe('NO_VALID_WINNER');
      expect(result.attempts[0].failure).toContain('OS sandbox');
    } else {
      expect(result.attempts[0].checks?.[0].output).toContain('2 passed');
      expect(result.state).toBe('AWAITING_MERGE');
    }
  } finally { await f.dispose(); }
});

it.runIf(sandboxStatus().mode !== 'none')('OS sandbox blocks protected-test writes, shared workspace reads, and inherited credentials', async () => {
  for (const attack of ['write', 'rename', 'read', 'secret', 'network']) {
    const f = await fixture();
    try {
      await fs.mkdir(path.join(f.root, 'tests'));
      await fs.writeFile(path.join(f.root, 'tests', 'guard.txt'), 'trusted');
      await raceGit(f.root, ['add', 'tests']); await raceGit(f.root, ['commit', '-m', 'trusted guard']);
      const secret = path.join(f.root, '.secret-outside-verifier');
      await fs.writeFile(secret, 'private');
      const code = attack === 'write' ? "require('node:fs').writeFileSync('acceptance.cjs','tampered');"
        : attack === 'rename' ? "require('node:fs').renameSync('tests','renamed-tests');"
        : attack === 'read' ? `require('node:fs').readFileSync(${JSON.stringify(secret)});`
        : attack === 'network' ? "require('node:net').connect(9,'127.0.0.1');"
        : "if (!process.env.WAZIR_RACE_TEST_SECRET) throw new Error('secret unavailable');";
      const service = new CompetitiveExecution({ ...f.deps, verify: verifyCompetitiveCandidate, run: async ({ attempt }) => {
        await fs.writeFile(path.join(attempt.worktree!.worktreeDir, 'src/add.cjs'), code + '\nexports.add=(a,b)=>a+b;\n'); return {};
      } });
      process.env.WAZIR_RACE_TEST_SECRET = 'must-not-inherit';
      const record = await service.create({ repository: f.root, task: 'Fix add', configurations: [config('a')], policy });
      const result = await service.run(record.id);
      expect(result.state, attack).toBe('NO_VALID_WINNER');
      if (attack === 'network') expect(result.attempts[0].checks?.[0].output).toMatch(/EPERM|Operation not permitted/);
      expect(await fs.readFile(secret, 'utf8')).toBe('private');
      expect(await fs.readFile(path.join(f.root, 'acceptance.cjs'), 'utf8')).toContain('assert.equal');
    } finally { delete process.env.WAZIR_RACE_TEST_SECRET; await f.dispose(); }
  }
});
