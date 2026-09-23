/**
 * Task-complexity classification used to gate planning and set per-task
 * execution budgets. Without this, a one-file "write a quicksort program"
 * request gets the same 4-step plan DAG and maxTurns=30/maxRepairCycles=2/
 * maxRetries=3 budgets as a multi-service refactor, which is how a trivial
 * task can burn 50+ model calls before failing.
 */
export type TaskComplexity = 'trivial' | 'small' | 'complex';

export interface ComplexityBudget {
  maxTurns: number;
  maxRepairCycles: number;
  maxRetries: number;
  /** When true, callers should skip DAG planning and use a single implement+verify step. */
  skipPlanning: boolean;
}

const BUDGETS: Record<TaskComplexity, ComplexityBudget> = {
  trivial: { maxTurns: 4, maxRepairCycles: 1, maxRetries: 1, skipPlanning: true },
  small: { maxTurns: 8, maxRepairCycles: 2, maxRetries: 2, skipPlanning: false },
  complex: { maxTurns: 30, maxRepairCycles: 2, maxRetries: 3, skipPlanning: false },
};

// Explicit signals for large, cross-cutting work — these override everything else.
const COMPLEX_SIGNALS = /\b(refactor|migrat\w*|architect\w*|across the (repo|codebase|project)|multi-service|multiple (files|modules|services)|entire (codebase|project)|end-to-end|end to end)\b/i;

// "add one endpoint", "fix one isolated test" style asks.
const SMALL_SIGNALS = /\b(add|fix|update|modify|patch)\b.*\b(endpoint|test|function|method|bug|route|component|module)\b/i;

// "write a C++ quicksort program", "create a python hello world script".
const TRIVIAL_SIGNALS = /\b(write|create|generate)\b.*\b(program|script|function|snippet|hello world|class)\b/i;

/**
 * Deterministic heuristic classifier (no model call — trivial tasks must not
 * spend a model turn just to find out they're trivial).
 */
export function classifyComplexity(prompt: string): TaskComplexity {
  const text = prompt.trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const fileMentions = (text.match(/\.(cpp|cc|cxx|c|py|js|ts|tsx|jsx|go|rs|java|rb|php)\b/gi) ?? []).length;

  if (COMPLEX_SIGNALS.test(text)) return 'complex';
  if (wordCount > 40) return 'complex';
  if (fileMentions > 2) return 'complex';

  if (TRIVIAL_SIGNALS.test(text) && wordCount <= 20 && fileMentions <= 1) return 'trivial';
  if (SMALL_SIGNALS.test(text)) return 'small';

  // No fallback to 'trivial' purely on prompt brevity: a short, ambiguous task
  // description (e.g. a /fanout entry like "setup database") isn't necessarily a
  // one-shot task — it may still need several files/tool calls. Only an explicit
  // trivial signal (see TRIVIAL_SIGNALS) earns the tight trivial budget; anything
  // else defaults to the more forgiving 'small' budget.
  return 'small';
}

export function budgetFor(complexity: TaskComplexity): ComplexityBudget {
  return BUDGETS[complexity];
}
