import { describe, expect, it } from 'vitest';
import { chunk, jitteredBackoffSeconds } from './db.js';

describe('db utilities', () => {
  it('caps exponential retry backoff at one hour', () => {
    expect(jitteredBackoffSeconds(1)).toBe(30);
    expect(jitteredBackoffSeconds(2)).toBe(60);
    expect(jitteredBackoffSeconds(3)).toBe(120);
    expect(jitteredBackoffSeconds(20)).toBe(3_600);
  });

  it('chunks arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
