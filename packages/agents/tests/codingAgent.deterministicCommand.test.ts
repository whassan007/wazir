import { describe, expect, it } from 'vitest';
import { isDeterministicCommandRequest } from '../src/codingAgent.js';

/**
 * Regression coverage for the deterministic command fast path (P0-A). A trivial,
 * explicitly-typed command like `ls` must resolve to a direct tool call with no
 * LLM involvement, while anything ambiguous or containing shell metacharacters
 * must fall through to the full coding agent so it stays subject to the normal
 * authorization/sandbox path.
 */
describe('isDeterministicCommandRequest', () => {
  describe('matches (direct tool call, no LLM)', () => {
    const cases: Array<[string, string, 'shell' | 'git']> = [
      ['bare ls', 'ls', 'shell'],
      ['ls with flags', 'ls -la', 'shell'],
      ['ls with path', 'ls packages/agents', 'shell'],
      ['dir alias', 'dir', 'shell'],
      ['bare pwd', 'pwd', 'shell'],
      ['git status', 'git status', 'git'],
      ['git diff', 'git diff', 'git'],
      ['git diff with path', 'git diff packages/agents/src/codingAgent.ts', 'git'],
      ['git log', 'git log', 'git'],
      ['git log with flag', 'git log --oneline', 'git'],
      ['leading/trailing whitespace', '  ls  ', 'shell'],
    ];
    for (const [label, input, tool] of cases) {
      it(label, () => {
        const result = isDeterministicCommandRequest(input);
        expect(result).not.toBeNull();
        expect(result?.tool).toBe(tool);
      });
    }
  });

  describe('does not match (falls through to full agent)', () => {
    const cases: Array<[string, string]> = [
      ['prose mentioning ls', 'can you run ls for me?'],
      ['prose mentioning git status', 'please check git status and summarize'],
      ['shell metacharacter semicolon', 'ls; rm -rf /'],
      ['shell metacharacter pipe', 'ls | grep foo'],
      ['shell metacharacter backtick', 'ls `whoami`'],
      ['shell metacharacter dollar', 'ls $(whoami)'],
      ['shell metacharacter redirect', 'ls > out.txt'],
      ['unrelated git subcommand', 'git push origin main'],
      ['unrelated git subcommand commit', 'git commit -am "wip"'],
      ['empty', '   '],
      ['too long', 'ls ' + 'x'.repeat(300)],
      ['natural language question', 'what files are in this directory?'],
    ];
    for (const [label, input] of cases) {
      it(label, () => {
        expect(isDeterministicCommandRequest(input)).toBeNull();
      });
    }
  });
});
