import { describe, expect, it } from 'vitest';
import { isConversationalFastPathRequest } from '../src/codingAgent.js';

/**
 * Regression coverage for the conversational fast-path classifier. Previously,
 * WORKSPACE_OR_TOOL_ACTION_RE hard-blocked the fast path on common ambiguous
 * verbs (fix/debug/update/remove/execute/project) even when the request was
 * pure conversation or snippet debugging with no repository reference at all,
 * forcing those into the full multi-turn coding agent unnecessarily.
 */
describe('isConversationalFastPathRequest', () => {
  describe('should take the fast path (standalone conversation / snippets)', () => {
    const cases: Array<[string, string]> = [
      ['standalone code generation', 'Write a JavaScript function that removes duplicate values.'],
      ['standalone generation, "project" absent from path context', 'Write a function to validate an email address.'],
      ['snippet bug fix with inline code', 'Find and fix the bug in this Python function:\ndef add(a,b):\n    return a-b'],
      ['snippet debug, no code noun overlap with repo', 'Debug this code: for i in range(10) print(i)'],
      ['explanation of a fix, no file reference', 'Explain how to fix this function.'],
      ['explanation question', 'What does this regex do: ^[a-z]+$'],
      ['arithmetic', 'What is 42 * 17?'],
      ['bare arithmetic expression', '12 + 30'],
      ['translation request', 'Translate "hello world" to French.'],
      ['comparison question', 'Which is faster, quicksort or mergesort?'],
      ['one-sentence summary request', 'Summarize what a binary search does in one sentence.'],
      ['snippet generation with language name', 'Implement a Rust function that reverses a linked list.'],
      ['resolve wording for a snippet', 'Resolve the bug in this function: def f(x): return x minus one'],
      ['correct wording for a snippet', 'Correct the off-by-one error in this snippet: for i in range(1, n): print(i)'],
      ['repair wording for a snippet', 'Repair the following code: print("hi"'],
    ];
    for (const [label, prompt] of cases) {
      it(label, () => {
        expect(isConversationalFastPathRequest(prompt)).toBe(true);
      });
    }
  });

  describe('should retain the full coding agent (workspace / repo / ambiguous)', () => {
    const cases: Array<[string, string]> = [
      ['explicit file path', 'Fix the implementation in src/utils.ts.'],
      ['explicit file path with extension, update verb', 'Update config.yaml to add the new endpoint.'],
      ['repo keyword', 'Inspect the repository and identify the cause of failing tests.'],
      ['codebase keyword', 'Search the codebase for unused exports.'],
      ['git keyword', 'Run git status and tell me what changed.'],
      ['npm keyword', 'Run npm install and report any errors.'],
      ['build keyword', 'Build the project and fix any compile errors.'],
      ['shell/terminal keyword', 'Execute this command in the terminal: ls -la'],
      ['ambiguous infra fix, no snippet', 'Fix the issue with my deployment pipeline.'],
      ['ambiguous mutation, no code noun', 'Remove the old backups.'],
      ['explicit workspace mutation', 'Delete the test directory and recreate it.'],
      ['mutationRequired flag set', 'Write a function that adds two numbers.'],
      ['resume flag set', 'Continue where we left off.'],
      ['expectedFiles set', 'Summarize the project.'],
      ['type debugging', 'Fix this function.'],
      ['type research', 'Investigate the regression in the test suite.'],
      ['too long', 'x'.repeat(601)],
      ['empty', '   '],
    ];
    const optionsByLabel: Record<string, Parameters<typeof isConversationalFastPathRequest>[1]> = {
      'mutationRequired flag set': { mutationRequired: true },
      'resume flag set': { resume: true },
      'expectedFiles set': { expectedFiles: ['src/index.ts'] },
      'type debugging': { type: 'debugging' },
      'type research': { type: 'research' },
    };
    for (const [label, prompt] of cases) {
      it(label, () => {
        expect(isConversationalFastPathRequest(prompt, optionsByLabel[label])).toBe(false);
      });
    }
  });

  describe('type: chat always takes the fast path unless blocked', () => {
    it('plain chat message with no workspace signal', () => {
      expect(isConversationalFastPathRequest('ls', { type: 'chat' })).toBe(true);
    });
    it('chat message mentioning a file path still blocked', () => {
      expect(isConversationalFastPathRequest('cat package.json', { type: 'chat' })).toBe(false);
    });
  });
});
