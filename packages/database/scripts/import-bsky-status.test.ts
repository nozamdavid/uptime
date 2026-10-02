import { describe, expect, it } from 'vitest';

import { canonicalMonitorUrl, inferMonitorRegions, utcYesterday } from './import-bsky-status.js';

describe('Bluesky status import', () => {
  it('matches equivalent root URLs without duplicating a trailing slash', () => {
    expect(canonicalMonitorUrl('https://PUBLIC.API.BSKY.APP/')).toBe(
      canonicalMonitorUrl('https://public.api.bsky.app'),
    );
  });

  it('infers east and west regions from hostname labels', () => {
    expect(inferMonitorRegions('https://host.us-east.example/xrpc/_health')).toEqual({
      regionIds: ['us-east'],
      usedFallback: false,
    });
    expect(inferMonitorRegions('https://host.us-west.example/xrpc/_health')).toEqual({
      regionIds: ['us-west'],
      usedFallback: false,
    });
  });

  it('uses every region when the hostname has no recognized region label', () => {
    const inferred = inferMonitorRegions('https://public.api.bsky.app');
    expect(inferred.usedFallback).toBe(true);
    expect(inferred.regionIds).toHaveLength(9);
  });

  it('calculates the cutoff as yesterday in UTC', () => {
    expect(utcYesterday(new Date('2026-08-30T00:05:00-07:00'))).toBe('2026-08-29');
  });
});
