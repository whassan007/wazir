module a20_budget_enforcement

/*
 * Alloy 6 Formal Model for Wazir Hardening Program
 * Agent A20 (Gemini TIER 1 — Retry Accounting, Token Limits & Budget Enforcement)
 *
 * Core Invariant: "Retries, restarts, and failovers must not bypass established execution and cost budgets."
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

pred completeExecution {
  TerminalStatus = "RUNNING"
  // Safe condition: cannot complete if cumulative budget was violated
  accumulatedCost =< ExecutionConfig.maxCost
  accumulatedTokens =< ExecutionConfig.maxTokens
  PastAttempts' = PastAttempts + CurrentAttempt
  no CurrentAttempt'
  RetriesCount' = RetriesCount
  TerminalStatus' = "COMPLETED"
}

pred failoverOrRetry[nextAttempt: Attempt] {
  TerminalStatus = "RUNNING"
  RetriesCount < ExecutionConfig.maxRetries
  nextAttempt not in (PastAttempts + CurrentAttempt)

  // Conservation rule: only dispatch if projected cost & tokens do not exceed hard budget
  plus[accumulatedCost, nextAttempt.cost] =< ExecutionConfig.maxCost
  plus[accumulatedTokens, nextAttempt.tokens] =< ExecutionConfig.maxTokens

  PastAttempts' = PastAttempts + CurrentAttempt
  CurrentAttempt' = nextAttempt
  RetriesCount' = plus[RetriesCount, 1]
  TerminalStatus' = "RUNNING"
}

pred terminateExhausted {
  TerminalStatus = "RUNNING"
  (
    RetriesCount = ExecutionConfig.maxRetries or
    plus[accumulatedCost, 1] > ExecutionConfig.maxCost or
    plus[accumulatedTokens, 1] > ExecutionConfig.maxTokens
  )
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
    completeExecution or
    (some next: Attempt | failoverOrRetry[next]) or
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
