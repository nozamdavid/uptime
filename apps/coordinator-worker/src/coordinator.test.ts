import { describe, expect, it, vi } from 'vitest';
import { all, type D1Database } from '@uptime/cloudflare';
import { sealProviderConfig } from '@uptime/api-worker/credentials';
import { regionById, regionIds, type RegionId } from '@uptime/regions';

import { runCoordinatorTick } from './coordinator.js';
import type { CoordinatorConfig } from './env.js';
import { count, makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';
import { FakeR2 } from './testing-r2.js';
import { runCoordinatorSchedule } from './index.js';
import { claimJob, readJob } from './state.js';

const now = new Date('2026-09-20T10:00:00.000Z');

function config(db: D1Database): CoordinatorConfig {
  return {
    db,
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
  };
}

function probeResponse(
  item: { checkRunId: string; monitorId: string },
  regionId: RegionId,
  success: boolean,
) {
  return {
    checkRunId: item.checkRunId,
    monitorId: item.monitorId,
    response: {
      regionId,
      status: success ? 'success' : 'http_failure',
      success,
      httpStatus: success ? 200 : 503,
      responseMs: success ? 120 : null,
      totalMs: success ? 130 : 15,
      errorCode: null,
      errorDetail: success ? null : 'HTTP 503',
      placement: null,
      colo: null,
      finalUrl: 'https://example.com/health',
      endpointEvidence: null,
      dnsDiagnostic: null,
      redirectCount: 0,
      bodyBytes: 12,
      probeVersion: 'test',
      startedAt: '2026-09-20T10:00:01.000Z',
      completedAt: '2026-09-20T10:00:02.000Z',
    },
  };
}

/**
 * Fetch double that answers signed probe batches for each canonical region.
 * `behavior` returns `null` to omit a result entirely, which models a missing
 * regional probe rather than a target failure.
 */
function probeFetch(
  behavior: (regionId: RegionId, item: { checkRunId: string; monitorId: string }) => boolean | null,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const regionId = (Object.values(regionById) as Array<(typeof regionById)[RegionId]>).find(
      (region) => url.includes(`${region.workerName}.`),
    )?.id;
    if (!regionId) throw new Error(`Unexpected probe URL ${url}`);
    const body = JSON.parse(String(init?.body)) as {
      requestId: string;
      items: { checkRunId: string; monitorId: string }[];
    };
    const results = body.items
      .map((item) => ({ item, success: behavior(regionId, item) }))
      .filter(
        (entry): entry is { item: typeof entry.item; success: boolean } => entry.success !== null,
      )
      .map((entry) => probeResponse(entry.item, regionId, entry.success));
    return new Response(JSON.stringify({ requestId: body.requestId, regionId, results }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const noLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('coordinator tick', () => {
  it.each(['regional fetch', 'item persistence', 'queued fetch'] as const)(
    'drains a failed schedule before releasing its lease while another %s is held',
    async (heldOperation) => {
      const { sqlite, db } = makeDatabase();
      const regions: RegionId[] =
        heldOperation === 'item persistence' ? ['us-east'] : ['us-east', 'eu-west'];
      const monitorId = seedMonitor(sqlite, { regions });
      if (heldOperation === 'item persistence') seedMonitor(sqlite, { regions });
      const gate = deferred();
      const held = deferred();
      const failed = deferred();
      const failure = new Error('Observation write rejected');
      const failedRegion = heldOperation === 'queued fetch' ? 'eu-west' : 'us-east';
      const wrappedDb: D1Database = {
        ...db,
        prepare(query) {
          const statement = db.prepare(query);
          if (!query.includes('INSERT INTO observations')) return statement;
          return {
            ...statement,
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                ...bound,
                async run<T>() {
                  if (values[2] === monitorId && values[3] === failedRegion) {
                    failed.resolve();
                    throw failure;
                  }
                  if (heldOperation === 'item persistence') {
                    held.resolve();
                    await gate.promise;
                  }
                  return bound.run<T>();
                },
              };
            },
          };
        },
      };
      const fetchImpl = probeFetch(() => true);
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const heldRegion = heldOperation === 'queued fetch' ? 'us-east' : 'eu-west';
        if (heldOperation !== 'item persistence' && String(input).includes(heldRegion)) {
          held.resolve();
          await gate.promise;
        }
        return fetchImpl(input, init);
      });
      let settled = false;
      const startedAt = new Date();
      const schedule = runCoordinatorSchedule(
        {
          ...config(wrappedDb),
          enabledRegionIds: regions,
          probeConcurrency: heldOperation === 'queued fetch' ? 1 : 2,
        },
        startedAt,
      ).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await Promise.all([held.promise, failed.promise]);
        // Allow the failed promise to reach the schedule's catch if it fails fast.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(settled).toBe(false);
        expect((await readJob(db, 'coordinator'))?.lease_token).not.toBeNull();
        expect(await claimJob(db, 'coordinator', startedAt, 195)).toBeNull();
        gate.resolve();
        expect(await schedule).toBe(failure);
        expect(count(sqlite, 'observations')).toBe(1);
        expect((await readJob(db, 'coordinator'))?.lease_token).toBeNull();
      } finally {
        gate.resolve();
        await schedule;
        vi.unstubAllGlobals();
      }
    },
  );

  it('uses the live delivery clock after slow probe work', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { regions: ['us-east'], outageThreshold: 1 });
    const serviceId = '00000000-0000-4000-8000-0000000000e1';
    const encrypted = await sealProviderConfig('y'.repeat(40), {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    sqlite
      .prepare(
        `INSERT INTO notification_services (id, name, provider, enabled, config, updated_at)
         VALUES (?, 'Clock test', 'webhook', 1, ?, '2026-09-01T00:00:00.000Z')`,
      )
      .run(serviceId, encrypted);
    sqlite
      .prepare(
        'INSERT INTO monitor_notification_services (monitor_id, notification_service_id) VALUES (?, ?)',
      )
      .run(monitorId, serviceId);
    let liveTime = now;
    let claimedLease: string | null = null;
    const probes = probeFetch(() => false);
    await runCoordinatorTick(
      { ...config(db), enabledRegionIds: ['us-east'] },
      {
        now: () => liveTime,
        log: noLog,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes('uptime-probe-')) {
            liveTime = new Date(now.getTime() + 90_000);
            return probes(input, init);
          }
          claimedLease = (
            sqlite.prepare('SELECT lease_until FROM notification_deliveries').get() as {
              lease_until: string;
            }
          ).lease_until;
          liveTime = new Date(now.getTime() + 110_000);
          return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
        }) as typeof fetch,
      },
      { publishReports: false },
    );
    expect(claimedLease).toBe('2026-09-20T10:02:30.000Z');
    const delivery = sqlite
      .prepare('SELECT next_attempt_at FROM notification_deliveries')
      .get() as { next_attempt_at: string };
    expect(delivery.next_attempt_at).toBe('2026-09-20T10:03:50.000Z');
  });

  it('can leave report publication to the independently scheduled job', async () => {
    const { sqlite, db } = makeDatabase();
    seedMonitor(sqlite, {
      isPublic: 1,
      publicSlug: 'separate-publisher',
      nextCheckAt: '2026-09-20T11:00:00.000Z',
    });
    const reports = new FakeR2();

    const result = await runCoordinatorTick(
      { ...config(db), reports },
      { fetch: probeFetch(() => true), log: noLog, now: () => now },
      { publishReports: false },
    );

    expect(result.metrics.reportsPublished).toBe(0);
    expect(result.metrics.queryWork['reports']).toBeUndefined();
    expect(reports.store.size).toBe(0);
  });

  it('caps an oversized monitor batch at the supported 50 rounds', async () => {
    const { sqlite, db } = makeDatabase();
    for (let index = 0; index < 100; index += 1) {
      seedMonitor(sqlite, {
        id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        nextCheckAt: '2026-09-20T09:59:00.000Z',
        regions: ['us-east'],
      });
    }

    const result = await runCoordinatorTick(
      {
        ...config(db),
        monitorBatch: 500,
        enabledRegionIds: ['us-east'],
      },
      { fetch: probeFetch(() => true), log: noLog, now: () => now },
    );

    expect(result.metrics.roundsClaimed).toBe(50);
    expect(result.metrics.observationsInserted).toBe(50);
    expect(
      (
        sqlite.prepare("SELECT count(*) AS c FROM check_runs WHERE status = 'complete'").get() as {
          c: number;
        }
      ).c,
    ).toBe(50);
  });

  it('sustains the production-shaped mostly two-region fleet above its due rate', async () => {
    const { sqlite, db } = makeDatabase();
    for (let index = 0; index < 107; index += 1) {
      seedMonitor(sqlite, {
        id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        nextCheckAt: index < 50 ? '2026-09-20T09:59:00.000Z' : '2026-09-20T10:05:00.000Z',
        regions: index < 5 ? ['us-east', 'eu-west', 'asia'] : ['us-east', 'eu-west'],
        dnsDiagnosticsEnabled: 1,
        isPublic: 1,
        publicSlug: `production-${index}`,
      });
    }
    sqlite
      .prepare(
        `INSERT INTO status_pages (id, title, public_slug, report_interval_seconds)
         VALUES ('production-page', 'Production status', 'bsky', 60)`,
      )
      .run();
    for (let group = 0; group < 6; group += 1) {
      sqlite
        .prepare(
          `INSERT INTO status_page_groups (id, status_page_id, title, position)
           VALUES (?, 'production-page', ?, ?)`,
        )
        .run(`production-group-${group}`, `Group ${group + 1}`, group);
    }
    for (let index = 0; index < 106; index += 1) {
      const group = Math.floor(index / 18);
      sqlite
        .prepare(
          `INSERT INTO status_page_monitors (
             status_page_id, group_id, monitor_id, position
           ) VALUES ('production-page', ?, ?, ?)`,
        )
        .run(
          `production-group-${group}`,
          `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          index % 18,
        );
    }
    let statements = 0;
    const measuredDb = {
      ...db,
      prepare(query: string) {
        statements += 1;
        return db.prepare(query);
      },
    } as D1Database;
    const reports = new FakeR2();
    const result = await runCoordinatorTick(
      {
        ...config(measuredDb),
        reports,
        enabledRegionIds: [...regionIds],
      },
      { fetch: probeFetch(() => true), log: noLog, now: () => now },
    );

    // Production needs 27.2 rounds/minute. This shape consumes 105 of the
    // 108 regional-task allowance and clears all 50 candidates safely.
    expect(result.metrics.roundsClaimed).toBe(50);
    expect(result.metrics.observationsInserted).toBe(105);
    expect(statements).toBeLessThan(900);
    const preBudgetStatements = ['recovery', 'claims', 'probes'].reduce(
      (sum, stage) => sum + (result.metrics.queryWork[stage]?.statements ?? 0),
      0,
    );
    expect(preBudgetStatements).toBeLessThan(550);
    // Scheduled publication builds the status index without monitor graphs.
    expect(result.metrics.reportsPublished).toBeGreaterThan(0);
    expect(
      [...reports.store.keys()].some((key) => key.startsWith('private/report-cohort-samples-')),
    ).toBe(false);
    expect(reports.store.has('public/cohort.json')).toBe(true);
    expect(result.metrics.queryWork['retention']?.statements).toBeGreaterThan(0);
  });

  it('signs a queued probe batch with its actual dispatch time', async () => {
    const { sqlite, db } = makeDatabase();
    for (let index = 0; index < 6; index += 1) {
      seedMonitor(sqlite, {
        id: `10000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
        nextCheckAt: '2026-09-20T09:59:00.000Z',
        regions: ['us-east'],
        publicSlug: `queued-${index}`,
      });
    }
    let clock = now;
    const issuedAt: string[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        requestId: string;
        issuedAt: string;
        regionId: RegionId;
        items: { checkRunId: string; monitorId: string }[];
      };
      issuedAt.push(body.issuedAt);
      const results = body.items.map((item) => probeResponse(item, body.regionId, true));
      clock = new Date(clock.getTime() + 70_000);
      return new Response(
        JSON.stringify({ requestId: body.requestId, regionId: body.regionId, results }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runCoordinatorTick(
      { ...config(db), enabledRegionIds: ['us-east'], probeConcurrency: 1 },
      { fetch, log: noLog, now: () => clock },
    );

    expect(issuedAt).toEqual(['2026-09-20T10:00:00.000Z', '2026-09-20T10:01:10.000Z']);
    expect(count(sqlite, 'observations')).toBe(6);
  });

  it('measures the maximum configured 50 by 9 probe tick against the D1 query ceiling', async () => {
    const { sqlite, db } = makeDatabase();
    for (let index = 0; index < 50; index += 1) {
      seedMonitor(sqlite, {
        id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        nextCheckAt: '2026-09-20T09:59:00.000Z',
        regions: [...regionIds],
        dnsDiagnosticsEnabled: 1,
        isPublic: 1,
        publicSlug: `capacity-${index}`,
      });
    }
    sqlite
      .prepare(
        `INSERT INTO notification_services (id, name, provider, config)
         VALUES ('capacity-service', 'Capacity', 'webhook', '{}')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO status_pages (id, title, public_slug)
         VALUES ('capacity-page', 'Capacity page', 'capacity-page')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO status_page_groups (id, status_page_id, title, position)
         VALUES ('capacity-group', 'capacity-page', 'Everything', 0)`,
      )
      .run();
    for (let index = 0; index < 50; index += 1) {
      const monitorId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      sqlite
        .prepare(
          `INSERT INTO monitor_notification_services (monitor_id, notification_service_id)
           VALUES (?, 'capacity-service')`,
        )
        .run(monitorId);
      sqlite
        .prepare(
          `INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position)
           VALUES ('capacity-page', 'capacity-group', ?, ?)`,
        )
        .run(monitorId, index);
    }
    sqlite
      .prepare(
        `INSERT INTO notification_deliveries (
           id, monitor_id, notification_service_id, event_key, kind, message, next_attempt_at
         ) VALUES ('capacity-delivery', '10000000-0000-4000-8000-000000000000',
           'capacity-service', 'capacity-event', 'outage',
           '{"kind":"outage","monitorName":"Capacity","monitorUrl":"https://example.com","occurredAt":"2026-09-20T09:00:00.000Z","outageStartedAt":null}', ?)`,
      )
      .run(now.toISOString());
    let statements = 0;
    const measuredDb = {
      ...db,
      prepare(query: string) {
        statements += 1;
        return db.prepare(query);
      },
    } as D1Database;
    const reports = new FakeR2();
    const measuredConfig = {
      ...config(measuredDb),
      reports,
      enabledRegionIds: [...regionIds],
    } satisfies CoordinatorConfig;

    const result = await runCoordinatorTick(measuredConfig, {
      fetch: probeFetch(() => true),
      log: noLog,
      now: () => now,
    });

    expect(result.metrics.roundsClaimed).toBe(12);
    expect(result.metrics.observationsInserted).toBe(108);
    expect(
      (
        sqlite
          .prepare('SELECT count(*) AS c FROM monitors WHERE next_check_at <= ?')
          .get(now.toISOString()) as { c: number }
      ).c,
    ).toBe(38);
    // This counts SQL statements inside D1 batches, matching the platform
    // query limit rather than treating one batch as one operation.
    // The tick itself includes one unmetered final state write after the 890
    // work ceiling. The scheduled handler reserves two more lease writes.
    expect(statements).toBeLessThanOrEqual(900);
    const executedStatements = Object.values(result.metrics.queryWork).reduce(
      (sum, stage) => sum + stage.statements,
      0,
    );
    const budgetedStatements = Object.entries(result.metrics.queryWork)
      .filter(([stage]) => stage !== 'state')
      .reduce((sum, [, stage]) => sum + stage.statements, 0);
    expect(budgetedStatements).toBeLessThanOrEqual(890);
    // Preparing a statement is free in D1. These few extra prepares were
    // rejected synchronously by the meter before native execution.
    expect(statements - executedStatements).toBeLessThanOrEqual(10);
    expect(
      Object.values(result.metrics.queryWork).reduce((sum, stage) => sum + stage.rowsRead, 0),
    ).toBeGreaterThan(0);
    expect(
      (
        sqlite
          .prepare("SELECT attempts FROM notification_deliveries WHERE id = 'capacity-delivery'")
          .get() as { attempts: number }
      ).attempts,
    ).toBe(1);
    expect(reports.store.has('public/cohort.json')).toBe(true);
    expect(Object.values(result.metrics.queryWork).every((stage) => stage.unmeasured === 0)).toBe(
      true,
    );
  });

  it('claims due work, probes each region, and aggregates exactly once', async () => {
    const { sqlite, db } = makeDatabase();
    seedMonitor(sqlite, { nextCheckAt: '2026-09-20T09:59:00.000Z' });
    const result = await runCoordinatorTick(config(db), {
      fetch: probeFetch(() => true),
      log: noLog,
      now: () => now,
    });
    expect(result.metrics.roundsClaimed).toBe(1);
    expect(result.metrics.observationsInserted).toBe(2);
    expect(result.metrics.roundsFinalized).toBe(1);
    expect(count(sqlite, 'observations')).toBe(2);
    const daily = sqlite
      .prepare(
        `SELECT received_count, success_count, uptime_percentage FROM monitor_daily_uptime
         WHERE day = '2026-09-20'`,
      )
      .get() as { received_count: number; success_count: number; uptime_percentage: number };
    expect(daily).toEqual({ received_count: 2, success_count: 2, uptime_percentage: 100 });
  });

  it('is idempotent across a repeated invocation at the same instant', async () => {
    const { sqlite, db } = makeDatabase();
    seedMonitor(sqlite, { nextCheckAt: '2026-09-20T09:59:00.000Z' });
    const cfg = config(db);
    await runCoordinatorTick(cfg, { fetch: probeFetch(() => true), log: noLog, now: () => now });
    await runCoordinatorTick(cfg, { fetch: probeFetch(() => true), log: noLog, now: () => now });
    expect(count(sqlite, 'check_runs')).toBe(1);
    expect(count(sqlite, 'observations')).toBe(2);
    const daily = sqlite
      .prepare("SELECT received_count FROM monitor_daily_uptime WHERE day = '2026-09-20'")
      .get() as { received_count: number };
    expect(daily.received_count).toBe(2);
  });

  it('replays duplicate probe results without double counting', async () => {
    const { sqlite, db } = makeDatabase();
    seedMonitor(sqlite, { nextCheckAt: '2026-09-20T09:59:00.000Z' });
    const cfg = config(db);
    // Two ticks cannot both claim the same round, but a retried dispatch that
    // returns the same observations must be a no-op at the durable key.
    await runCoordinatorTick(cfg, { fetch: probeFetch(() => true), log: noLog, now: () => now });
    seedObservation(sqlite, {
      checkRunId: (sqlite.prepare('SELECT id FROM check_runs').get() as { id: string }).id,
      monitorId: (sqlite.prepare('SELECT id FROM monitors').get() as { id: string }).id,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: true,
      responseMs: 999,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    expect(count(sqlite, 'observations')).toBe(2);
    const daily = sqlite
      .prepare("SELECT received_count FROM monitor_daily_uptime WHERE day = '2026-09-20'")
      .get() as { received_count: number };
    expect(daily.received_count).toBe(2);
  });

  it('marks a round with a missing region as partial without inventing a failure', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { nextCheckAt: '2026-09-20T09:59:00.000Z' });
    // Only us-east answers; eu-west goes silent.
    await runCoordinatorTick(config(db), {
      fetch: probeFetch((regionId) => (regionId === 'us-east' ? true : null)),
      log: noLog,
      now: () => now,
    });
    const round = sqlite
      .prepare('SELECT id, status FROM check_runs WHERE monitor_id = ?')
      .get(monitorId) as { id: string; status: string };
    expect(round.status).toBe('pending');
    // Prevent a second round from being claimed while the first finalizes.
    sqlite
      .prepare("UPDATE monitors SET next_check_at = '2026-09-21T00:00:00.000Z' WHERE id = ?")
      .run(monitorId);
    // Advance past the collection deadline so the overdue round finalizes.
    await runCoordinatorTick(config(db), {
      fetch: probeFetch(() => true),
      log: noLog,
      now: () => new Date('2026-09-20T10:01:00.000Z'),
    });
    const finalized = sqlite
      .prepare('SELECT status FROM check_runs WHERE id = ?')
      .get(round.id) as { status: string };
    expect(finalized.status).toBe('partial');
    // A successful observation still counts; a missing region contributes nothing.
    const daily = sqlite
      .prepare(
        `SELECT received_count, success_count, uptime_percentage FROM monitor_daily_uptime
         WHERE monitor_id = ? AND day = '2026-09-20'`,
      )
      .get(monitorId) as {
      received_count: number;
      success_count: number;
      uptime_percentage: number;
    };
    expect(daily).toEqual({ received_count: 1, success_count: 1, uptime_percentage: 100 });
  });

  it('does not create a round for a monitor with no enabled regions', async () => {
    const { sqlite, db } = makeDatabase();
    seedMonitor(sqlite, { regions: ['asia'], nextCheckAt: '2026-09-20T09:59:00.000Z' });
    await runCoordinatorTick(config(db), {
      fetch: probeFetch(() => true),
      log: noLog,
      now: () => now,
    });
    expect(count(sqlite, 'check_runs')).toBe(0);
  });

  it('reclaims an expired round from a crashed coordinator', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { nextCheckAt: '2026-09-20T11:00:00.000Z' });
    seedRound(sqlite, {
      id: 'crashed',
      monitorId,
      windowStartedAt: '2026-09-20T09:00:00.000Z',
      expectedRegions: ['us-east', 'eu-west'],
      deadlineAt: '2026-09-20T09:00:16.000Z',
    });
    sqlite
      .prepare(
        `UPDATE check_runs SET claim_token = 'dead', claim_expires_at = '2026-09-20T09:00:30.000Z'
         WHERE id = 'crashed'`,
      )
      .run();
    const result = await runCoordinatorTick(config(db), {
      fetch: probeFetch(() => true),
      log: noLog,
      now: () => now,
    });
    expect(result.metrics.staleRounds).toBe(1);
    expect(result.metrics.roundsFinalized).toBe(1);
    const round = await all<{ status: string }>(
      db,
      "SELECT status FROM check_runs WHERE id = 'crashed'",
    );
    expect(round[0]?.status).toBe('partial');
  });
});
