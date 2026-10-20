import { expect, test } from 'vitest';

export function reverseString(str: string): string {
  return str.split('').reverse().join('');
}

test('reverses WAZIR', () => {
  expect(reverseString('WAZIR')).toBe('RIZAW');
});

test('reverses lowercase', () => {
  expect(reverseString('wazir')).toBe('rizaw');
});

test('handles empty string', () => {
  expect(reverseString('')).toBe('');
});
