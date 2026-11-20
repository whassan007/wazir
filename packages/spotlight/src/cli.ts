import { executeSpotlightMatch, querySpotlight } from './router.js';

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'match') {
    const query = rest.join(' ');
    const matches = await querySpotlight(query);
    process.stdout.write(JSON.stringify(matches, null, 2) + '\n');
    return;
  }
  if (cmd === 'run') {
    const payload = JSON.parse(rest.join(' '));
    const result = await executeSpotlightMatch(payload);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stderr.write('Usage: wazir-spotlight <match <query>|run <match-json>>\n');
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exitCode = 1;
});
