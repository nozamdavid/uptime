import { describe, expect, it } from 'vitest';
import { chunk, isUniqueViolation, jitteredBackoffSeconds, normalizeBindValue } from './db.js';

describe('db utilities', () => {
  it('normalizes booleans, dates, undefined, and objects for binding', () => {
    expect(normalizeBindValue(true)).toBe(1);
    expect(normalizeBindValue(false)).toBe(0);
    expect(normalizeBindValue(undefined)).toBeNull();
    expect(normalizeBindValue(new Date('2026-09-20T00:00:00.000Z'))).toBe(
      '2026-09-20T00:00:00.000Z',
    );
    expect(normalizeBindValue({ a: 1 })).toBe('{"a":1}');
    expect(normalizeBindValue('x')).toBe('x');
    expect(normalizeBindValue(3)).toBe(3);
  });

  it('caps exponential retry backoff at one hour', () => {
    expect(jitteredBackoffSeconds(1)).toBe(30);
    expect(jitteredBackoffSeconds(2)).toBe(60);
    expect(jitteredBackoffSeconds(3)).toBe(120);
    expect(jitteredBackoffSeconds(20)).toBe(3_600);
  });

  it('detects unique violations and chunks arrays', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: observations.x'))).toBe(true);
    expect(isUniqueViolation(new Error('syntax error'))).toBe(false);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
