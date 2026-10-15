import fs from 'node:fs';
import crypto from 'node:crypto';
const [file, phase, head, prompt] = process.argv.slice(2);
try {
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(prompt)).digest('hex');
  if (receipt.phase !== Number(phase) || receipt.head !== head || receipt.promptSha256 !== digest || receipt.decision !== 'PASS' || receipt.reviewer !== 'recovery-supervisor') throw Error('identity mismatch');
  if (!Array.isArray(receipt.requirements) || receipt.requirements.length < 3 || receipt.requirements.some(r => r.status !== 'PASS' || !r.requirement || !Array.isArray(r.evidence) || !r.evidence.length)) throw Error('missing acceptance evidence');
  for (const item of receipt.requirements) for (const file of item.evidence) if (!fs.statSync(file).isFile()) throw Error('missing evidence artifact');
} catch (error) { console.error('PHASE_ACCEPTANCE_UNVERIFIED:', error.message); process.exit(1); }
