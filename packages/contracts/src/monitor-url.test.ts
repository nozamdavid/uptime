import { describe, expect, it } from 'vitest';

import {
  intervalSecondsSchema,
  monitorBulkFrequencyUpdateSchema,
  monitorCreateSchema,
  normalizeMonitorUrl,
  publicMonitorSlugSchema,
} from './index.js';

const baseMonitor = {
  regionIds: ['us-east'] as const,
  intervalSeconds: 300 as const,
  timeoutMs: 10_000,
  enabled: true,
  dnsDiagnosticsEnabled: false,
  isPublic: false,
};

describe('monitor URL normalization', () => {
  it.each([
    ['example.com/health', 'https://example.com/health'],
    ['  status.example.com  ', 'https://status.example.com'],
    ['http://example.com/health', 'http://example.com/health'],
    ['https://example.com/health', 'https://example.com/health'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeMonitorUrl(input)).toBe(expected);
    expect(monitorCreateSchema.parse({ ...baseMonitor, url: input }).url).toBe(expected);
  });

  it('still rejects an explicitly unsupported protocol', () => {
    expect(() => monitorCreateSchema.parse({ ...baseMonitor, url: 'ftp://example.com' })).toThrow(
      /HTTP or HTTPS/,
    );
  });
});

describe('public monitor slug', () => {
  it('normalizes casing and spaces', () => {
    expect(publicMonitorSlugSchema.parse(' My Public Monitor ')).toBe('my-public-monitor');
    expect(publicMonitorSlugSchema.parse('Public.Host.Bsky.Network')).toBe(
      'public.host.bsky.network',
    );
  });

  it.each(['ab', 'ends-', 'two--hyphens', 'not_allowed'])('rejects %s', (slug) => {
    expect(publicMonitorSlugSchema.safeParse(slug).success).toBe(false);
  });
});

describe('monitor check frequency', () => {
  it.each([60, 840, 900, 1_200, 3_600])('accepts %i seconds', (seconds) => {
    expect(intervalSecondsSchema.parse(seconds)).toBe(seconds);
  });

  it.each([59, 960, 3_900])('rejects unsupported interval %i', (seconds) => {
    expect(() => intervalSecondsSchema.parse(seconds)).toThrow(/Check frequency/);
  });

  it('validates bulk frequency changes', () => {
    const input = {
      monitorIds: ['00000000-0000-4000-8000-000000000001'],
      intervalSeconds: 1_200,
    };
    expect(monitorBulkFrequencyUpdateSchema.parse(input)).toEqual(input);
    expect(monitorBulkFrequencyUpdateSchema.safeParse({ ...input, monitorIds: [] }).success).toBe(
      false,
    );
  });
});
