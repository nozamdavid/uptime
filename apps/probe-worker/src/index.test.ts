import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { regionIds, type RegionId } from '@uptime/regions';

import worker from './index.js';

const env = {
  PROBE_REGION: 'us-east' as const,
  PROBE_SIGNING_SECRET: 'a'.repeat(32),
  PROBE_REQUEST_MAX_SKEW_SECONDS: '60',
  PROBE_MAX_REQUEST_BYTES: '65536',
  PROBE_VERSION: 'test',
};

function workerEnv(regionId: RegionId) {
  return { ...env, PROBE_REGION: regionId };
}
const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  tracing: {},
} as unknown as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function signedRequest(payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  const canonical = `v1\n${String(payload.issuedAt)}\n${String(payload.requestId)}\n${body}`;
  const signature = createHmac('sha256', env.PROBE_SIGNING_SECRET)
    .update(canonical)
    .digest('base64url');
  return new Request('https://probe.test', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-uptime-issued-at': String(payload.issuedAt),
      'x-uptime-request-id': String(payload.requestId),
      'x-uptime-signature': signature,
      'x-uptime-signature-version': 'v1',
    },
  });
}

describe('probe worker request guard', () => {
  it('rejects non-POST requests before any target fetch', async () => {
    const response = await worker.fetch(new Request('https://probe.test'), env, context);
    expect(response.status).toBe(405);
  });

  it.each(regionIds)(
    'accepts the canonical %s identity and rejects a mismatched identity',
    async (regionId) => {
      const issuedAt = new Date().toISOString();
      const requestId = crypto.randomUUID();
      const payload = {
        checkRunId: crypto.randomUUID(),
        monitorId: crypto.randomUUID(),
        windowStartedAt: issuedAt,
        regionId,
        url: 'https://example.com/health',
        timeoutMs: 1_000,
        method: 'GET',
        maxRedirects: 5,
        maxBodyBytes: 65_536,
        requestId,
        issuedAt,
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));

      const accepted = await worker.fetch(signedRequest(payload), workerEnv(regionId), context);
      expect(accepted.status).toBe(200);

      const otherRegion = regionIds.find((candidate) => candidate !== regionId)!;
      const rejected = await worker.fetch(signedRequest(payload), workerEnv(otherRegion), context);
      expect(rejected.status).toBe(403);
      await expect(rejected.json()).resolves.toEqual({
        error: { code: 'region_or_identity_mismatch' },
      });
    },
  );

  it('treats a fast HTTP 521 response as unreachable', async () => {
    const issuedAt = new Date().toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Web server is down', { status: 521 })),
    );

    const response = await worker.fetch(
      signedRequest({
        checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
        monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
        windowStartedAt: issuedAt,
        regionId: 'us-east',
        url: 'https://example.com/health',
        timeoutMs: 1_000,
        method: 'GET',
        maxRedirects: 5,
        maxBodyBytes: 65_536,
        requestId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
        issuedAt,
      }),
      env,
      context,
    );

    await expect(response.json()).resolves.toMatchObject({
      status: 'http_failure',
      success: false,
      httpStatus: 521,
      errorDetail: 'HTTP 521',
    });
  });

  it('executes five same-region probes in one bounded batch', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const issuedAt = new Date().toISOString();
    const requestId = crypto.randomUUID();
    const items = Array.from({ length: 5 }, (_, index) => ({
      checkRunId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      monitorId: `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
      windowStartedAt: issuedAt,
      url: `https://example.com/${index}`,
      timeoutMs: 1_000,
      method: 'GET',
      maxRedirects: 5,
      maxBodyBytes: 65_536,
    }));

    const response = await worker.fetch(
      signedRequest({ requestId, issuedAt, regionId: 'us-east', items }),
      env,
      context,
    );
    const payload = (await response.json()) as {
      requestId: string;
      regionId: string;
      results: { checkRunId: string; monitorId: string; response: { success: boolean } }[];
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ requestId, regionId: 'us-east' });
    expect(payload.results).toHaveLength(5);
    expect(payload.results.every((result) => result.response.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(maximumActive).toBe(2);
  });

  it('returns final-response CDN evidence for a signed synthetic request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: {
          'cf-ray': '8f1234567890abcd-LHR',
          'set-cookie': 'must-not-be-retained=secret',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const issuedAt = new Date().toISOString();
    const requestId = 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745';
    const body = JSON.stringify({
      checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
      monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
      windowStartedAt: issuedAt,
      regionId: 'us-east',
      url: 'https://example.com/start',
      timeoutMs: 1_000,
      method: 'GET',
      maxRedirects: 5,
      maxBodyBytes: 65_536,
      requestId,
      issuedAt,
    });
    const response = await worker.fetch(
      signedRequest(JSON.parse(body) as Record<string, unknown>),
      env,
      context,
    );
    const observation = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(observation).toMatchObject({
      success: true,
      finalUrl: 'https://example.com/start',
      endpointEvidence: {
        finalHostname: 'example.com',
        signals: [{ name: 'cf-ray', value: '8f1234567890abcd-LHR' }],
        primaryCdn: {
          provider: 'cloudflare',
          reportedEdge: 'LHR',
          inferredContinent: 'europe',
          confidence: 'provider_reported',
        },
      },
    });
    expect(observation.dnsDiagnostic).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('collects DNS candidates for the final redirect hostname without changing HTTP timing', async () => {
    const baseNow = Date.now();
    let now = baseNow;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://cloudflare-dns.com/')) {
        now += 500;
        const type = new URL(url).searchParams.get('type');
        const answer =
          type === 'A'
            ? [{ type: 1, TTL: 120, data: '1.1.1.1' }]
            : type === 'AAAA'
              ? [{ type: 28, TTL: 120, data: '2606:4700:4700::1111' }]
              : [{ type: 5, TTL: 120, data: 'edge.example.net.' }];
        return new Response(
          JSON.stringify({
            Status: 0,
            Question: [
              { name: 'final.example.', type: type === 'A' ? 1 : type === 'AAAA' ? 28 : 5 },
            ],
            Answer: answer,
          }),
          { headers: { 'content-type': 'application/dns-json' } },
        );
      }
      if (url === 'https://example.com/start') {
        now = baseNow + 10;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://final.example/ok' },
        });
      }
      now = baseNow + 25;
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const issuedAt = new Date().toISOString();
    const response = await worker.fetch(
      signedRequest({
        checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
        monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
        windowStartedAt: issuedAt,
        regionId: 'us-east',
        url: 'https://example.com/start',
        timeoutMs: 1_000,
        method: 'GET',
        maxRedirects: 5,
        maxBodyBytes: 65_536,
        requestId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
        issuedAt,
        dnsDiagnostic: {
          diagnosticId: '6bb57ec3-fbf8-4c4f-9fc7-9572440abcc2',
          windowStartedAt: '2026-08-30T00:00:00.000Z',
          deadlineMs: 2_000,
        },
      }),
      env,
      context,
    );
    const observation = (await response.json()) as Record<string, any>;
    expect(observation).toMatchObject({
      success: true,
      finalUrl: 'https://final.example/ok',
      responseMs: 25,
      totalMs: 25,
      dnsDiagnostic: {
        finalHostname: 'final.example',
        status: 'success',
        cnameCandidates: ['edge.example.net'],
        aCandidates: [{ address: '1.1.1.1', ttl: 120 }],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const dnsUrls = fetchMock.mock.calls.slice(2).map(([input]) => String(input));
    expect(dnsUrls.every((url) => new URL(url).searchParams.get('name') === 'final.example')).toBe(
      true,
    );
  });

  it('cancels redirect bodies before following the next hop', async () => {
    const cancel = vi.fn();
    const redirectBody = new ReadableStream<Uint8Array>({ cancel });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(redirectBody, {
          status: 302,
          headers: { location: 'https://example.com/final' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const issuedAt = new Date().toISOString();

    const response = await worker.fetch(
      signedRequest({
        checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
        monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
        windowStartedAt: issuedAt,
        regionId: 'us-east',
        url: 'https://example.com/start',
        timeoutMs: 1_000,
        method: 'GET',
        maxRedirects: 5,
        maxBodyBytes: 65_536,
        requestId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
        issuedAt,
      }),
      env,
      context,
    );

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
