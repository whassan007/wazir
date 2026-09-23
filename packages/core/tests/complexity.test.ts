import { describe, expect, it } from 'vitest';
import { classifyComplexity, budgetFor } from '../src/index.js';

describe('classifyComplexity', () => {
  it('classifies one-file "write a program" asks as trivial', () => {
    expect(classifyComplexity('write a C++ program to sort an array')).toBe('trivial');
    expect(classifyComplexity('create a python hello world script')).toBe('trivial');
    expect(classifyComplexity('write a function to reverse a string')).toBe('trivial');
  });

  it('classifies single isolated fix/add asks as small', () => {
    expect(classifyComplexity('add one endpoint for listing users')).toBe('small');
    expect(classifyComplexity('fix one isolated test in the auth module')).toBe('small');
  });

  it('classifies cross-cutting or multi-file asks as complex', () => {
    expect(classifyComplexity('refactor authentication across the repository')).toBe('complex');
    expect(classifyComplexity('migrate the persistence architecture to a new database')).toBe('complex');
    expect(classifyComplexity('implement a multi-service feature spanning billing and notifications')).toBe('complex');
  });

  it('escalates by mention count and prompt length regardless of phrasing', () => {
    expect(classifyComplexity('update a.ts and b.ts and c.ts and d.ts')).toBe('complex');
    const longPrompt = Array.from({ length: 45 }, () => 'word').join(' ');
    expect(classifyComplexity(longPrompt)).toBe('complex');
  });
});

describe('budgetFor', () => {
  it('gives trivial tasks the tightest budget and enables the fast path', () => {
    const budget = budgetFor('trivial');
    expect(budget.skipPlanning).toBe(true);
    expect(budget.maxTurns).toBeLessThan(budgetFor('small').maxTurns);
    expect(budget.maxRetries).toBeLessThan(budgetFor('complex').maxRetries);
  });

  it('gives complex tasks the full legacy budget', () => {
    const budget = budgetFor('complex');
    expect(budget.maxTurns).toBe(30);
    expect(budget.maxRepairCycles).toBe(2);
    expect(budget.maxRetries).toBe(3);
    expect(budget.skipPlanning).toBe(false);
  });
});
