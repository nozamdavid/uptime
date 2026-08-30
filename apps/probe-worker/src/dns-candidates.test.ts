import { describe, expect, it, vi } from 'vitest';

import {
  cloudflareDohResolver,
  collectDnsCandidates,
  type DnsResolverAdapter,
  type ResolverAnswer,
} from './dns-candidates.js';

const instruction = {
  diagnosticId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
  windowStartedAt: '2026-08-30T00:00:00.000Z',
  deadlineMs: 2_000,
} as const;

function resolverWith(
  answers: Partial<Record<'A' | 'AAAA' | 'CNAME', readonly ResolverAnswer[]>>,
): DnsResolverAdapter {
  return {
    resolve: vi.fn(async (_hostname: string, type: 'A' | 'AAAA' | 'CNAME') => answers[type] ?? []),
  };
}

describe('collectDnsCandidates', () => {
  it('collects normalized, bounded public candidates with TTLs', async () => {
    const resolver = resolverWith({
      CNAME: [{ type: 'CNAME', data: 'Edge.Example.NET.', ttl: 60 }],
      A: [{ type: 'A', data: '8.8.8.8', ttl: 300 }],
      AAAA: [{ type: 'AAAA', data: '2606:4700:4700::1111', ttl: 900_000 }],
    });
    await expect(
      collectDnsCandidates('Example.COM', instruction, {
        resolver,
        now: () => new Date('2026-08-30T12:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      finalHostname: 'example.com',
      resolver: 'cloudflare-doh',
      observedAt: '2026-08-30T12:00:00.000Z',
      status: 'success',
      cnameCandidates: ['edge.example.net'],
      aCandidates: [{ address: '8.8.8.8', ttl: 300 }],
      aaaaCandidates: [{ address: '2606:4700:4700::1111', ttl: 604_800 }],
      filteredAddressCount: 0,
      errorCode: null,
      schemaVersion: '1',
      parserVersion: '1',
    });
  });

  it('filters private, loopback, link-local, multicast, reserved and documentation IPs', async () => {
    const resolver = resolverWith({
      A: ['10.0.0.1', '127.0.0.1', '169.254.1.1', '192.0.2.1', '224.0.0.1', '8.8.4.4'].map(
        (data) => ({ type: 'A' as const, data, ttl: 60 }),
      ),
      AAAA: [
        '::1',
        'fc00::1',
        'fe80::1',
        'ff02::1',
        '2001::1',
        '2001:db8::1',
        '2002::1',
        '3fff::1',
        '2606:4700:4700::1001',
      ].map((data) => ({ type: 'AAAA' as const, data, ttl: 60 })),
    });
    const result = await collectDnsCandidates('example.com', instruction, { resolver });
    expect(result.filteredAddressCount).toBe(13);
    expect(result.aCandidates).toEqual([{ address: '8.8.4.4', ttl: 60 }]);
    expect(result.aaaaCandidates).toEqual([{ address: '2606:4700:4700::1001', ttl: 60 }]);
  });

  it('caps and de-duplicates each candidate family at eight', async () => {
    const resolver = resolverWith({
      CNAME: Array.from({ length: 12 }, (_, index) => ({
        type: 'CNAME',
        data: `edge-${index}.example.net`,
        ttl: 60,
      })),
      A: Array.from({ length: 12 }, (_, index) => ({
        type: 'A',
        data: `8.8.8.${index + 1}`,
        ttl: 60,
      })),
      AAAA: Array.from({ length: 12 }, (_, index) => ({
        type: 'AAAA',
        data: `2606:4700:4700::${index + 1}`,
        ttl: 60,
      })),
    });
    const result = await collectDnsCandidates('example.com', instruction, { resolver });
    expect(result.cnameCandidates).toHaveLength(8);
    expect(result.aCandidates).toHaveLength(8);
    expect(result.aaaaCandidates).toHaveLength(8);
  });

  it('returns partial with a safe error when one resolver query fails', async () => {
    const resolver: DnsResolverAdapter = {
      async resolve(_hostname, type) {
        if (type === 'AAAA') throw new Error('secret raw resolver detail');
        return type === 'A' ? [{ type, data: '1.1.1.1', ttl: 60 }] : [];
      },
    };
    const result = await collectDnsCandidates('example.com', instruction, { resolver });
    expect(result).toMatchObject({
      status: 'partial',
      errorCode: 'resolver_failure',
      aCandidates: [{ address: '1.1.1.1', ttl: 60 }],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('uses one strict total deadline without retries', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(
      (_hostname: string, _type: 'A' | 'AAAA' | 'CNAME', signal: AbortSignal) =>
        new Promise<readonly ResolverAnswer[]>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const resolver: DnsResolverAdapter = { resolve };
    const pending = collectDnsCandidates(
      'example.com',
      { ...instruction, deadlineMs: 100 },
      {
        resolver,
      },
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(resolve).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('is non-throwing for invalid hostnames and malformed resolver answers', async () => {
    const invalid = await collectDnsCandidates('bad_host', instruction, {
      resolver: resolverWith({}),
    });
    expect(invalid).toMatchObject({ status: 'failed', errorCode: 'invalid_hostname' });

    const malformed = await collectDnsCandidates('example.com', instruction, {
      resolver: resolverWith({
        CNAME: [{ type: 'CNAME', data: '-invalid.example', ttl: 60 }],
        A: [{ type: 'A', data: 'not-an-ip', ttl: 60 }],
        AAAA: [{ type: 'AAAA', data: 'not::ipv6::data', ttl: 60 }],
      }),
    });
    expect(malformed).toMatchObject({
      status: 'success',
      cnameCandidates: [],
      aCandidates: [],
      aaaaCandidates: [],
      filteredAddressCount: 0,
    });
  });
});

describe('cloudflareDohResolver', () => {
  it('rejects non-DNS JSON responses before parsing them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 0, Answer: [] }), {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    await expect(
      cloudflareDohResolver.resolve('example.com', 'A', new AbortController().signal),
    ).rejects.toThrow('resolver_failure');
    vi.unstubAllGlobals();
  });

  it('rejects an oversized DoH body without retaining or parsing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 0, padding: 'x'.repeat(40_000) }), {
          headers: { 'content-type': 'application/dns-json' },
        }),
      ),
    );

    await expect(
      cloudflareDohResolver.resolve('example.com', 'A', new AbortController().signal),
    ).rejects.toThrow('resolver_failure');
    vi.unstubAllGlobals();
  });

  it('rejects a mismatched DNS question to avoid accepting unrelated answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            Status: 0,
            Question: [{ name: 'other.example.', type: 1 }],
            Answer: [{ name: 'other.example.', type: 1, TTL: 60, data: '8.8.8.8' }],
          }),
          { headers: { 'content-type': 'application/dns-json' } },
        ),
      ),
    );

    await expect(
      cloudflareDohResolver.resolve('example.com', 'A', new AbortController().signal),
    ).rejects.toThrow('resolver_failure');
    vi.unstubAllGlobals();
  });

  it('also validates the question on an NXDOMAIN response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ Status: 3, Question: [{ name: 'other.example.', type: 1 }] }),
            { headers: { 'content-type': 'application/dns-json' } },
          ),
        ),
    );

    await expect(
      cloudflareDohResolver.resolve('example.com', 'A', new AbortController().signal),
    ).rejects.toThrow('resolver_failure');
    vi.unstubAllGlobals();
  });
});
