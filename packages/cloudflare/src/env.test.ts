import { describe, expect, it } from 'vitest';
import { parseRegionsList, requireBinding, sessionTtlSeconds, toBoolean } from './env.js';

describe('env helpers', () => {
  it('defaults to every region and parses explicit lists', () => {
    expect(parseRegionsList(undefined)).toContain('eu-west');
    expect(parseRegionsList('')).toHaveLength(9);
    expect(parseRegionsList('eu-west, asia')).toEqual(['eu-west', 'asia']);
    expect(() => parseRegionsList('eu-west,,asia')).toThrow(/empty/);
    expect(() => parseRegionsList('nope')).toThrow(/unknown/);
    expect(() => parseRegionsList('eu-west,eu-west')).toThrow(/duplicate/);
  });

  it('parses the session TTL with bounds', () => {
    expect(sessionTtlSeconds({})).toBe(604_800);
    expect(sessionTtlSeconds({ SESSION_TTL_SECONDS: '300' })).toBe(300);
    expect(() => sessionTtlSeconds({ SESSION_TTL_SECONDS: '10' })).toThrow();
    expect(() => sessionTtlSeconds({ SESSION_TTL_SECONDS: 'abc' })).toThrow();
  });

  it('requires bindings and normalizes booleans', () => {
    expect(requireBinding('x', 'X')).toBe('x');
    expect(() => requireBinding(undefined, 'DB')).toThrow(/DB/);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean('true')).toBe(true);
    expect(toBoolean(null)).toBe(false);
  });
});
