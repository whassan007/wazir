// Child process for multi-process ledger tests. Bundled by the test with esbuild, then run
// as N separate node processes against one SQLite file.
import { AccountRegistry, DEFAULT_POLICY, ResourceLedger, TokenBudgetManager } from '../../src/resources/index.js';

const [mode, file, accountsJson, arg] = process.argv.slice(2);
const ledger = new ResourceLedger(file);
const policy = { ...DEFAULT_POLICY, enforce: true, estimateMargin: 0, leaseMs: Number(process.env.LEASE_MS ?? 900_000) };
const budget = new TokenBudgetManager(ledger, new AccountRegistry(JSON.parse(accountsJson)), policy);

if (mode === 'race') {
  // Wait for the shared start time so every process contends at once.
  const startAt = Number(arg);
  while (Date.now() < startAt) { /* spin */ }
  let admitted = 0;
  for (let i = 0; i < 10; i++) {
    const d = budget.admit({ requestId: `${process.pid}-${i}`, accountId: 'A', modelId: 'm', workload: 'critical-review', estimatedInputTokens: 1_000, estimatedOutputTokens: 0 });
    if (d.outcome === 'admitted') admitted++;
  }
  process.stdout.write(JSON.stringify({ admitted }));
  ledger.close();
} else if (mode === 'reserve-and-hang') {
  const d = budget.admit({ requestId: arg, accountId: 'A', modelId: 'm', workload: 'critical-review', estimatedInputTokens: 4_000, estimatedOutputTokens: 1_000 });
  process.stdout.write(`${d.outcome}\n`);
  setInterval(() => undefined, 1_000); // killed by the parent between reservation and settlement
} else if (mode === 'recover') {
  const startAt = Number(arg);
  while (Date.now() < startAt) { /* spin */ }
  process.stdout.write(JSON.stringify({ recovered: ledger.recoverExpired() }));
  ledger.close();
}
