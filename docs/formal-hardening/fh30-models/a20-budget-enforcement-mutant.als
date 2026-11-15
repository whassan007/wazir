module a20_budget_enforcement_mutant

/*
 * Alloy 6 Mutant Model for Wazir Hardening Program
 * Agent A20 (Gemini TIER 1 — Retry Accounting, Token Limits & Budget Enforcement)
 *
 * Models production defects:
 * 1. Harness fallback does not halt when remaining budget reaches 0.
 * 2. Replanning resets retry counter to 0 for replacement repair tasks.
 * 3. Multi-attempt accumulated cost is not enforced before declaring completed.
 */

open util/integer

sig Attempt {
  cost: Int,
  tokens: Int
}

one sig ExecutionConfig {
  maxCost: Int,
  maxTokens: Int,
  maxRetries: Int
}

var sig PastAttempts in Attempt {}
var sig CurrentAttempt in Attempt {}
var sig RetriesCount in Int {}
var sig TerminalStatus in String {} // "RUNNING", "COMPLETED", "FAILED"

fun accumulatedCost: Int {
  sum a: (PastAttempts + CurrentAttempt) | a.cost
}

fun accumulatedTokens: Int {
  sum a: (PastAttempts + CurrentAttempt) | a.tokens
}

pred init {
  no PastAttempts
  one CurrentAttempt
  RetriesCount = 0
  TerminalStatus = "RUNNING"
  all a: Attempt | a.cost > 0 and a.tokens > 0
  ExecutionConfig.maxCost > 0
  ExecutionConfig.maxTokens > 0
  ExecutionConfig.maxRetries > 0
  accumulatedCost =< ExecutionConfig.maxCost
  accumulatedTokens =< ExecutionConfig.maxTokens
}

// MUTANT: HarnessDispatchService allows completion without checking whether accumulated cost exceeded maxCost
pred completeExecutionMutant {
  TerminalStatus = "RUNNING"
  // Flawed: does not verify that total accumulatedCost <= maxCost across fallback attempts!
  PastAttempts' = PastAttempts + CurrentAttempt
  no CurrentAttempt'
  RetriesCount' = RetriesCount
  TerminalStatus' = "COMPLETED"
}

// MUTANT: Harness fallback dispatches even if accumulated budget is already exhausted, or replanning resets RetriesCount
pred failoverOrRetryMutant[nextAttempt: Attempt] {
  TerminalStatus = "RUNNING"
  nextAttempt not in (PastAttempts + CurrentAttempt)

  // Flawed: does not prevent dispatch when budget is exhausted
  // Flawed: on replan, RetriesCount is reset to 0
  PastAttempts' = PastAttempts + CurrentAttempt
  CurrentAttempt' = nextAttempt
  (
    // Normal retry: increment retry count
    (RetriesCount < ExecutionConfig.maxRetries and RetriesCount' = plus[RetriesCount, 1]) or
    // Replan defect: reset retry counter for repair task!
    (RetriesCount' = 0)
  )
  TerminalStatus' = "RUNNING"
}

pred terminateExhausted {
  TerminalStatus = "RUNNING"
  RetriesCount = ExecutionConfig.maxRetries
  PastAttempts' = PastAttempts + CurrentAttempt
  no CurrentAttempt'
  RetriesCount' = RetriesCount
  TerminalStatus' = "FAILED"
}

pred stutter {
  PastAttempts' = PastAttempts
  CurrentAttempt' = CurrentAttempt
  RetriesCount' = RetriesCount
  TerminalStatus' = TerminalStatus
}

fact traces {
  init
  always (
    completeExecutionMutant or
    (some next: Attempt | failoverOrRetryMutant[next]) or
    terminateExhausted or
    stutter
  )
}

assert BudgetConservationInvariant {
  always (
    accumulatedCost =< ExecutionConfig.maxCost and
    accumulatedTokens =< ExecutionConfig.maxTokens and
    RetriesCount =< ExecutionConfig.maxRetries
  )
}

check BudgetConservationInvariant for 4 Attempt, 6 Int, 8 steps
