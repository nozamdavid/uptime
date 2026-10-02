import { describe, expect, it } from 'vitest';

import {
  parseProbeBatchResponse,
  probeEndpointFor,
  regionalProbeBatches,
  signBatchRequest,
  type ProbeTask,
  type RegionalProbeBatch,
} from './probe.js';
import type { CoordinatorConfig } from './env.js';
import type { DueRound } from '@uptime/cloudflare';
import type { RegionId } from '@uptime/regions';
import { signProbeRequestBody } from './signing.js';
import { hmacSha256Base64Url } from '@uptime/cloudflare';

function dueRound(regionIds: RegionId[]): DueRound {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    monitorId: '22222222-2222-4222-8222-222222222222',
    monitorUrl: 'https://example.com/health',
    timeoutMs: 1_000,
    windowStartedAt: '2026-09-20T10:00:00.000Z',
    dnsDiagnosticsEnabled: false,
    regionIds,
  };
}

function task(round: DueRound, regionId: RegionId): ProbeTask {
  return {
    round,
    regionId,
    reserved: undefined,
    item: {
      checkRunId: round.id,
      monitorId: round.monitorId,
      windowStartedAt: round.windowStartedAt,
      url: round.monitorUrl,
      timeoutMs: round.timeoutMs,
      method: 'GET',
      maxRedirects: 5,
      maxBodyBytes: 65_536,
    },
  };
}

function config(overrides: Partial<CoordinatorConfig> = {}): CoordinatorConfig {
  return {
    db: {} as CoordinatorConfig['db'],
    reports: null,
    enabledRegionIds: ['us-east', 'eu-west'],
    enabledRegions: [],
    workersUrlDomain: 'account.workers.dev',
    probeSigningSecret: 'x'.repeat(40),
    credentialEncryptionSecret: 'y'.repeat(40),
    reportIntervalSeconds: 60,
    staleAfterSeconds: 180,
    monitorBatch: 50,
    probeConcurrency: 8,
    probeRequestMaxSkewSeconds: 60,
    notificationMaxAttempts: 8,
    detailedResultsRetentionDays: 7,
    dnsDiagnosticsRetentionDays: 30,
    environment: 'test',
    ...overrides,
  };
}

function batch(regionId: RegionId, tasks: ProbeTask[]): RegionalProbeBatch {
  return { regionId, tasks };
}

describe('probe dispatch', () => {
  it('resolves regional endpoints from the shared domain', () => {
    expect(probeEndpointFor(config(), 'us-east')).toBe(
      'https://uptime-probe-us-east.account.workers.dev',
    );
  });

  it('resolves every staging endpoint under only the isolated worker prefix', () => {
    const stagingConfig = config({ probeWorkerNamePrefix: 'uptime-staging-probe-' });
    expect(
      ['us-east', 'eu-west'].map((regionId) =>
        probeEndpointFor(stagingConfig, regionId as RegionId),
      ),
    ).toEqual([
      'https://uptime-staging-probe-us-east.account.workers.dev',
      'https://uptime-staging-probe-eu-west.account.workers.dev',
    ]);
  });

  it('groups tasks by region and splits into batches of five', () => {
    const round = dueRound(['us-east']);
    const tasks = Array.from({ length: 7 }, (_, index) => ({
      ...task(round, 'us-east'),
      item: {
        ...task(round, 'us-east').item,
        checkRunId: `11111111-1111-4111-8111-00000000000${index}`,
      },
    }));
    const batches = regionalProbeBatches([...tasks, task(round, 'eu-west')]);
    expect(batches).toHaveLength(3);
    expect(batches[0]!.tasks).toHaveLength(5);
    expect(batches[1]!.tasks).toHaveLength(2);
    expect(batches[2]!.regionId).toBe('eu-west');
  });

  it('signs the exact canonical envelope the probe verifies', async () => {
    const issuedAt = new Date('2026-09-20T10:00:00.000Z');
    const signed = await signProbeRequestBody(
      (requestId, envelopeIssuedAt) => ({
        requestId,
        issuedAt: envelopeIssuedAt,
        regionId: 'us-east',
        items: [],
      }),
      'secret',
      issuedAt,
    );
    expect(signed.headers['x-uptime-issued-at']).toBe(issuedAt.toISOString());
    expect(signed.headers['x-uptime-signature-version']).toBe('v1');
    // Reproduce the probe Worker's verification over the exact envelope.
    const expected = await hmacSha256Base64Url(
      'secret',
      `v1\n${issuedAt.toISOString()}\n${signed.requestId}\n${signed.body}`,
    );
    expect(expected).toBe(signed.headers['x-uptime-signature']);
  });

  it('accepts a well-formed batch response and rejects mismatched identity', async () => {
    const round = dueRound(['us-east']);
    const regionalBatch = batch('us-east', [task(round, 'us-east')]);
    const signed = await signBatchRequest(
      config(),
      regionalBatch,
      new Date('2026-09-20T10:00:00.000Z'),
    );
    const requestId = signed.requestId;
    const good = {
      requestId,
      regionId: 'us-east',
      results: [
        {
          checkRunId: round.id,
          monitorId: round.monitorId,
          response: {
            regionId: 'us-east',
            status: 'success',
            success: true,
            httpStatus: 200,
            responseMs: 100,
            totalMs: 110,
            errorCode: null,
            errorDetail: null,
            placement: null,
            colo: null,
            finalUrl: 'https://example.com/health',
            endpointEvidence: null,
            dnsDiagnostic: null,
            redirectCount: 0,
            bodyBytes: 10,
            probeVersion: 'test',
            startedAt: '2026-09-20T10:00:01.000Z',
            completedAt: '2026-09-20T10:00:02.000Z',
          },
        },
      ],
    };
    const parsed = parseProbeBatchResponse(good, regionalBatch, requestId);
    expect(parsed.diagnostics.get(`${round.id}:${round.monitorId}`)?.observation.success).toBe(
      true,
    );

    expect(() =>
      parseProbeBatchResponse(
        { ...good, requestId: crypto.randomUUID() },
        regionalBatch,
        requestId,
      ),
    ).toThrow(/mismatched identity/);
    expect(() =>
      parseProbeBatchResponse(
        {
          ...good,
          results: [...good.results, { ...good.results[0]!, checkRunId: crypto.randomUUID() }],
        },
        regionalBatch,
        requestId,
      ),
    ).toThrow(/unexpected or duplicate/);
  });
});
