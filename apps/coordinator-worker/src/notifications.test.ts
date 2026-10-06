import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sealProviderConfig } from '@uptime/api-worker/credentials';
import type { Database } from '@uptime/cloudflare/postgres';

import { processNotifications } from './notifications.js';
import { NotificationDeliveryError } from './providers.js';
import {
  all,
  count,
  first,
  seedMonitor,
  seedObservation,
  seedRound,
  useTenantDatabase,
} from './testing-postgres.js';

const now = new Date('2026-09-20T10:00:00.000Z');
const secret = 'y'.repeat(40);
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function addService(
  db: Database,
  id: string,
  provider: string,
  config: unknown,
  updatedAt = '2026-09-01T00:00:00.000Z',
): Promise<void> {
  const sealed = await sealProviderConfig(secret, config);
  await db.query(
    `INSERT INTO ${db.table('notification_services')} (id, name, provider, enabled, config, updated_at)
     VALUES ($1, $2, $3, 1, $4, $5)`,
    [id, id, provider, sealed, updatedAt],
  );
}

async function link(db: Database, monitorId: string, serviceId: string) {
  await db.query(
    `INSERT INTO ${db.table('monitor_notification_services')} (monitor_id, notification_service_id) VALUES ($1, $2)`,
    [monitorId, serviceId],
  );
}

async function deliveries(db: Database) {
  return all<{
    kind: string;
    status: string;
    attempts: number;
    event_key: string;
    last_error: string | null;
  }>(
    db,
    `SELECT kind, status, attempts, event_key, last_error FROM ${db.table('notification_deliveries')} ORDER BY created_at, kind`,
  );
}

async function seedOutage(db: Database, monitorId: string): Promise<void> {
  await seedRound(db, {
    id: `history-${monitorId}`,
    monitorId,
    windowStartedAt: '2026-09-20T09:59:00.000Z',
    status: 'complete',
    expectedRegions: ['us-east'],
  });
  await seedObservation(db, {
    checkRunId: `history-${monitorId}`,
    monitorId,
    regionId: 'us-east',
    scheduledWindow: '2026-09-20T09:59:00.000Z',
    success: false,
    startedAt: '2026-09-20T09:59:05.000Z',
  });
}

function failHistoryWrites(db: Database): Database {
  return {
    ...db,
    async query<T extends object>(sql: string, values?: readonly unknown[]) {
      if (sql.includes('INSERT INTO') && sql.includes(db.table('notification_history'))) {
        throw new Error('history storage unavailable');
      }
      return db.query<T>(sql, values);
    },
    transaction(callback) {
      return db.transaction((tx) => callback(failHistoryWrites(tx)));
    },
  };
}

vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });
const getFixture = useTenantDatabase();
let fixture: Awaited<ReturnType<typeof getFixture>>;

beforeAll(() => {
  fixture = getFixture();
});
afterEach(async () => {
  await fixture.adminDb.transaction(async (tx) => {
    for (const table of [
      'notification_history',
      'notification_deliveries',
      'monitor_notification_state',
      'monitor_notification_services',
      'observations',
      'check_runs',
      'notification_services',
      'monitor_regions',
      'monitors',
    ])
      await tx.query(`DELETE FROM ${tx.table(table)}`);
  });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

describe('notification processing', () => {
  it.each([true, false])(
    'samples delivery claim and provider completion clocks (retry: %s)',
    async (retry) => {
      const { db } = fixture;
      const monitorId = await seedMonitor(db, { outageThreshold: 1 });
      const serviceId = '00000000-0000-4000-8000-0000000000e1';
      await addService(db, serviceId, 'webhook', {
        webhookUrl: 'https://hooks.example.test/notify',
      });
      await link(db, monitorId, serviceId);
      await seedRound(db, {
        id: 'clock-round',
        monitorId,
        windowStartedAt: now.toISOString(),
        status: 'complete',
        expectedRegions: ['us-east'],
      });
      await seedObservation(db, {
        checkRunId: 'clock-round',
        monitorId,
        regionId: 'us-east',
        scheduledWindow: now.toISOString(),
        success: false,
      });
      let liveTime = new Date(now.getTime() + 90_000);
      let claimedLease: string | null = null;
      await processNotifications({
        db,
        now,
        liveNow: () => liveTime,
        fetch: (async () => {
          claimedLease = (await first<{ lease_until: string }>(
            db,
            `SELECT lease_until FROM ${db.table('notification_deliveries')}`,
          ))!.lease_until;
          liveTime = new Date(liveTime.getTime() + 20_000);
          return new Response('{}', {
            status: retry ? 429 : 200,
            headers: { 'retry-after': '120' },
          });
        }) as typeof fetch,
        enabledRegionIds: ['us-east'],
        credentialEncryptionSecret: secret,
        maxAttempts: 8,
        leaseToken: 'clock-lease',
        log,
      });
      expect(claimedLease).toBe('2026-09-20T10:02:30.000Z');
      const delivery = (await first<{
        status: string;
        next_attempt_at: string;
        sent_at: string | null;
      }>(
        db,
        `SELECT status, next_attempt_at, sent_at FROM ${db.table('notification_deliveries')}`,
      ))!;
      if (retry) {
        expect(delivery.status).toBe('pending');
        expect(delivery.next_attempt_at).toBe('2026-09-20T10:03:50.000Z');
      } else {
        expect(delivery.status).toBe('sent');
        expect(delivery.sent_at).toBe('2026-09-20T10:01:50.000Z');
      }
    },
  );

  it('creates one delivery per outage across all linked services, then sends it', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, { outageThreshold: 1, recoveryThreshold: 1 });
    await addService(db, '00000000-0000-4000-8000-0000000000a1', 'telegram', {
      botToken: '123456:abcdefghijklmnopqrstuvwxyz',
      chatId: '-100123',
    });
    await addService(db, '00000000-0000-4000-8000-0000000000a2', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000a1');
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000a2');
    await seedRound(db, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east', 'eu-west'],
    });
    await seedObservation(db, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    await seedObservation(db, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'eu-west',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:06.000Z',
    });

    const sent: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      // Telegram requires `{ ok: true }`; other providers accept any 2xx.
      return new Response(url.includes('api.telegram.org') ? '{"ok":true}' : '{}', {
        status: 200,
      });
    }) as typeof fetch;

    await processNotifications({
      db,
      fetch: fetchImpl,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-1',
      log,
    });

    const rows = await deliveries(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'outage')).toBe(true);
    expect(rows.every((row) => row.status === 'sent' && row.attempts === 1)).toBe(true);
    expect(sent.some((url) => url.includes('api.telegram.org'))).toBe(true);
    expect(sent.some((url) => url.includes('hooks.example.test'))).toBe(true);
    const state = (await first<{ status: string; failure_streak: number }>(
      db,
      `SELECT status, failure_streak FROM ${db.table('monitor_notification_state')} WHERE monitor_id = $1`,
      [monitorId],
    ))!;
    expect(state).toEqual({ status: 'down', failure_streak: 1 });
    // A second evaluation must not enqueue a duplicate outage event.
    await processNotifications({
      db,
      fetch: fetchImpl,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-2',
      log,
    });
    expect(await count(db, 'notification_deliveries')).toBe(2);
  });

  it('records the exact sent text, monitor snapshot, and validated provider link', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {
      id: '00000000-0000-4000-8000-0000000000f8',
      name: 'Checkout API',
      url: 'https://shop.example.test/health',
      outageThreshold: 1,
    });
    const serviceId = '00000000-0000-4000-8000-0000000000f9';
    await addService(db, serviceId, 'telegram', {
      botToken: '123456:abcdefghijklmnopqrstuvwxyz',
      chatId: '@status_room',
    });
    await link(db, monitorId, serviceId);
    await seedOutage(db, monitorId);
    let sentText = '';
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentText = (JSON.parse(String(init?.body)) as { text: string }).text;
      return Response.json({
        ok: true,
        result: {
          message_id: 72,
          chat: { type: 'channel', username: 'status_room' },
        },
      });
    }) as typeof fetch;

    await processNotifications({
      db,
      fetch: fetchImpl,
      now,
      enabledRegionIds: ['us-east'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'history-success',
      log,
    });

    const history = (await first<{
      monitor_id: string;
      monitor_name: string;
      monitor_url: string;
      status: string;
      text: string;
      external_url: string | null;
      error: string | null;
    }>(
      db,
      `SELECT monitor_id, monitor_name, monitor_url, status, text, external_url, error FROM ${db.table('notification_history')} WHERE notification_service_id = $1`,
      [serviceId],
    ))!;
    expect(history).toEqual({
      monitor_id: monitorId,
      monitor_name: 'Checkout API',
      monitor_url: 'https://shop.example.test/health',
      status: 'sent',
      text: sentText,
      external_url: 'https://t.me/status_room/72',
      error: null,
    });
  });

  it('records failed attempts without storing provider response secrets', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {
      id: '00000000-0000-4000-8000-0000000000fe',
      outageThreshold: 1,
    });
    const serviceId = '00000000-0000-4000-8000-0000000000ff';
    await addService(db, serviceId, 'telegram', {
      botToken: '123456:abcdefghijklmnopqrstuvwxyz',
      chatId: '-10012345',
    });
    await link(db, monitorId, serviceId);
    await seedOutage(db, monitorId);

    await processNotifications({
      db,
      fetch: (async () =>
        new Response('{"description":"private bot token 123456:abcdefghijklmnopqrstuvwxyz"}', {
          status: 400,
        })) as typeof fetch,
      now,
      enabledRegionIds: ['us-east'],
      credentialEncryptionSecret: secret,
      maxAttempts: 2,
      leaseToken: 'history-sanitized-failure',
      log,
    });

    const history = (await first<{ status: string; error: string }>(
      db,
      `SELECT status, error FROM ${db.table('notification_history')} WHERE notification_service_id = $1`,
      [serviceId],
    ))!;
    expect(history.status).toBe('failed');
    expect(history.error).toBe('Notification service rejected the message; check its settings');
    expect(history.error).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(history.error).not.toContain('private bot token');
  });

  it('does not change delivery status when history writes fail', async () => {
    for (const outcome of [
      { responseStatus: 200, expectedStatus: 'sent' },
      { responseStatus: 400, expectedStatus: 'failed' },
      { responseStatus: 503, expectedStatus: 'pending' },
    ]) {
      const { db } = fixture;
      const monitorId = await seedMonitor(db, {
        id:
          outcome.responseStatus === 200
            ? '00000000-0000-4000-8000-0000000000f6'
            : outcome.responseStatus === 400
              ? '00000000-0000-4000-8000-0000000000fa'
              : '00000000-0000-4000-8000-0000000000fb',
        outageThreshold: 1,
      });
      const serviceId =
        outcome.responseStatus === 200
          ? '00000000-0000-4000-8000-0000000000f7'
          : outcome.responseStatus === 400
            ? '00000000-0000-4000-8000-0000000000fc'
            : '00000000-0000-4000-8000-0000000000fd';
      await addService(db, serviceId, 'telegram', {
        botToken: '123456:abcdefghijklmnopqrstuvwxyz',
        chatId: '-10012345',
      });
      await link(db, monitorId, serviceId);
      await seedOutage(db, monitorId);

      await processNotifications({
        db: failHistoryWrites(db),
        fetch: (async () =>
          outcome.responseStatus === 200
            ? Response.json({
                ok: true,
                result: {
                  message_id: 9,
                  chat: { type: 'supergroup', username: 'status_room' },
                },
              })
            : new Response(
                '{"description":"private bot token 123456:abcdefghijklmnopqrstuvwxyz"}',
                { status: outcome.responseStatus },
              )) as typeof fetch,
        now,
        enabledRegionIds: ['us-east'],
        credentialEncryptionSecret: secret,
        maxAttempts: 2,
        leaseToken: `history-failure-${outcome.responseStatus}`,
        log,
      });

      const delivery = (await first<{ status: string; last_error: string | null }>(
        db,
        `SELECT status, last_error FROM ${db.table('notification_deliveries')} WHERE notification_service_id = $1`,
        [serviceId],
      ))!;
      expect(delivery.status).toBe(outcome.expectedStatus);
      if (outcome.responseStatus === 200) {
        expect(delivery.last_error).toBeNull();
      } else {
        expect(delivery.last_error).not.toContain('abcdefghijklmnopqrstuvwxyz');
        expect(delivery.last_error).not.toContain('private bot token');
      }
    }
  });

  it('does not alert when a round is missing regions even with a linked service', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, { outageThreshold: 1 });
    await addService(db, '00000000-0000-4000-8000-0000000000b1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000b1');
    await seedRound(db, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'partial',
      expectedRegions: ['us-east', 'eu-west'],
    });
    await seedObservation(db, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: true,
      startedAt: '2026-09-20T09:59:05.000Z',
    });

    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await processNotifications({
      db,
      fetch: fetchImpl,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-1',
      log,
    });
    expect(await count(db, 'notification_deliveries')).toBe(0);
    const state = (await first<{ status: string; failure_streak: number; success_streak: number }>(
      db,
      `SELECT status, failure_streak, success_streak FROM ${db.table('monitor_notification_state')} WHERE monitor_id = $1`,
      [monitorId],
    ))!;
    expect(state).toEqual({ status: 'healthy', failure_streak: 0, success_streak: 0 });
  });

  it('retries transient provider failures with backoff and stops at the attempt limit', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, { outageThreshold: 1 });
    await addService(db, '00000000-0000-4000-8000-0000000000c1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000c1');
    await seedRound(db, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    await seedObservation(db, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    const failing = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await processNotifications({
      db,
      fetch: failing,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 2,
      leaseToken: 'lease-1',
      log,
    });
    let row = (await deliveries(db))[0]!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);

    // The delivery is not due until its backoff elapses.
    await processNotifications({
      db,
      fetch: failing,
      now: new Date(now.getTime() + 1_000),
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 2,
      leaseToken: 'lease-2',
      log,
    });
    expect((await deliveries(db))[0]!.attempts).toBe(1);

    await processNotifications({
      db,
      fetch: failing,
      now: new Date(now.getTime() + 3_600_000),
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 2,
      leaseToken: 'lease-3',
      log,
    });
    row = (await deliveries(db))[0]!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(2);
  });

  it('reclaims a delivery whose send lease expired after a crash', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, { outageThreshold: 1 });
    await addService(db, '00000000-0000-4000-8000-0000000000d1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000d1');
    // No rounds: the only pending work is the stuck delivery.
    // Simulate a delivery stuck in `sending` from a crashed invocation.
    await db.query(
      `INSERT INTO ${db.table('notification_deliveries')} (
           id, monitor_id, notification_service_id, event_key, kind, message, status, attempts,
           next_attempt_at, lease_until, lease_token
         ) VALUES ('stuck', $1, '00000000-0000-4000-8000-0000000000d1', 'evt', 'outage',
           '{"kind":"outage","monitorName":"x","monitorUrl":"https://example.com","occurredAt":"2026-09-20T09:59:00.000Z","outageStartedAt":null}',
         'sending', 1, $2, '2026-09-20T09:00:00.000Z', 'dead')`,
      [monitorId, now.toISOString()],
    );
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await processNotifications({
      db,
      fetch: fetchImpl,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-1',
      log,
    });
    const row = (await first<{ status: string; lease_token: string | null }>(
      db,
      `SELECT status, lease_token FROM ${db.table('notification_deliveries')} WHERE id = 'stuck'`,
    ))!;
    expect(row.status).toBe('sent');
    expect(row.lease_token).toBeNull();
  });

  it('does not let a stale overlapping evaluation regress a newer incident watermark', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, { outageThreshold: 1 });
    await addService(db, '00000000-0000-4000-8000-0000000000f1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000f1');
    await seedRound(db, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    await seedObservation(db, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const deps = {
      db,
      fetch: fetchImpl,
      now,
      enabledRegionIds: ['us-east', 'eu-west'] as const,
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-1',
      log,
    };
    await processNotifications(deps);
    const advanced = (await first<{ last_window_started_at: string }>(
      db,
      `SELECT last_window_started_at FROM ${db.table('monitor_notification_state')} WHERE monitor_id = $1`,
      [monitorId],
    ))!;
    expect(advanced.last_window_started_at).toBe('2026-09-20T09:59:00.000Z');

    // A stale invocation that observed an empty watermark must not roll state
    // back, nor fabricate a second outage for the already-processed round.
    await processNotifications({ ...deps, leaseToken: 'lease-2' });
    const after = (await first<{ last_window_started_at: string; status: string }>(
      db,
      `SELECT last_window_started_at, status FROM ${db.table('monitor_notification_state')} WHERE monitor_id = $1`,
      [monitorId],
    ))!;
    expect(after).toEqual({
      last_window_started_at: '2026-09-20T09:59:00.000Z',
      status: 'down',
    });
    expect(await count(db, 'notification_deliveries')).toBe(1);
  });

  it('does not cancel a newer delivery when a stale evaluation overlaps', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, { outageThreshold: 1, recoveryThreshold: 1 });
    await addService(db, '00000000-0000-4000-8000-0000000000f2', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000f2');
    // Existing state at an older watermark with a mismatched fingerprint, so a
    // stale evaluation would reset and try to cancel pending deliveries.
    await db.query(
      `INSERT INTO ${db.table('monitor_notification_state')} (
           monitor_id, config_fingerprint, last_window_started_at, status, failure_streak,
           success_streak, outage_started_at, last_reminder_at
         ) VALUES ($1, 'old', '2026-09-20T08:59:00.000Z', 'healthy', 0, 0, NULL, NULL)`,
      [monitorId],
    );
    await seedRound(db, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    await seedObservation(db, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    // A newer invocation commits its watermark and delivery on an independent
    // connection before this stale invocation runs.
    const newerDb = await fixture.openConnection();
    await processNotifications({
      db: newerDb,
      fetch: (async () => new Response('nope', { status: 503 })) as typeof fetch,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'newer-lease',
      log,
    });
    const newerId = (await first<{ id: string }>(
      db,
      `SELECT id FROM ${db.table('notification_deliveries')}`,
    ))!.id;
    await db.query(`UPDATE ${db.table('notification_deliveries')} SET id = 'newer' WHERE id = $1`, [
      newerId,
    ]);
    await processNotifications({
      db,
      fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-1',
      log,
    });
    const newer = (await first<{ status: string }>(
      db,
      `SELECT status FROM ${db.table('notification_deliveries')} WHERE id = 'newer'`,
    ))!;
    expect(newer.status).not.toBe('cancelled');
    // The stale batch must not enqueue its own obsolete outage alongside the
    // delivery created by the invocation that won the state transition.
    expect(await count(db, 'notification_deliveries')).toBe(1);
  });

  it('fails an SMTP delivery terminally because Workers cannot open sockets', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, { outageThreshold: 1 });
    await addService(db, '00000000-0000-4000-8000-0000000000e1', 'smtp', {
      host: 'smtp.example.test',
      port: 587,
      security: 'starttls',
      from: 'uptime@example.test',
      to: ['ops@example.test'],
    });
    await link(db, monitorId, '00000000-0000-4000-8000-0000000000e1');
    await seedRound(db, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    await seedObservation(db, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    const fetchImpl = (async () => {
      throw new Error('SMTP must not use fetch');
    }) as typeof fetch;
    await processNotifications({
      db,
      fetch: fetchImpl,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-1',
      log,
    });
    const row = (await deliveries(db))[0]!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('SMTP is not supported');
  });
});

describe('provider classification', () => {
  it('marks retryable and terminal delivery errors explicitly', () => {
    expect(new NotificationDeliveryError(true).retryable).toBe(true);
    expect(new NotificationDeliveryError(false).retryable).toBe(false);
  });
});
