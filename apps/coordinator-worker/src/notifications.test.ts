import { describe, expect, it } from 'vitest';
import { sealProviderConfig } from '@uptime/api-worker/credentials';

import { processNotifications } from './notifications.js';
import { NotificationDeliveryError } from './providers.js';
import { count, makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';

const now = new Date('2026-09-20T10:00:00.000Z');
const secret = 'y'.repeat(40);
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function addService(
  sqlite: ReturnType<typeof makeDatabase>['sqlite'],
  id: string,
  provider: string,
  config: unknown,
  updatedAt = '2026-09-01T00:00:00.000Z',
): Promise<void> {
  const sealed = await sealProviderConfig(secret, config);
  sqlite
    .prepare(
      `INSERT INTO notification_services (id, name, provider, enabled, config, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, id, provider, sealed, updatedAt);
}

function link(
  sqlite: ReturnType<typeof makeDatabase>['sqlite'],
  monitorId: string,
  serviceId: string,
) {
  sqlite
    .prepare(
      'INSERT INTO monitor_notification_services (monitor_id, notification_service_id) VALUES (?, ?)',
    )
    .run(monitorId, serviceId);
}

function deliveries(sqlite: ReturnType<typeof makeDatabase>['sqlite']) {
  return sqlite
    .prepare(
      'SELECT kind, status, attempts, event_key, last_error FROM notification_deliveries ORDER BY created_at, kind',
    )
    .all() as Array<{
    kind: string;
    status: string;
    attempts: number;
    event_key: string;
    last_error: string | null;
  }>;
}

function seedOutage(sqlite: ReturnType<typeof makeDatabase>['sqlite'], monitorId: string): void {
  seedRound(sqlite, {
    id: `history-${monitorId}`,
    monitorId,
    windowStartedAt: '2026-09-20T09:59:00.000Z',
    status: 'complete',
    expectedRegions: ['us-east'],
  });
  seedObservation(sqlite, {
    checkRunId: `history-${monitorId}`,
    monitorId,
    regionId: 'us-east',
    scheduledWindow: '2026-09-20T09:59:00.000Z',
    success: false,
    startedAt: '2026-09-20T09:59:05.000Z',
  });
}

function failHistoryWrites(db: ReturnType<typeof makeDatabase>['db']) {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes('INSERT INTO notification_history')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === 'run') {
                return async () => {
                  throw new Error('history storage unavailable');
                };
              }
              return Reflect.get(statementTarget, statementProperty, statementReceiver);
            },
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('notification processing', () => {
  it.each([true, false])(
    'samples delivery claim and provider completion clocks (retry: %s)',
    async (retry) => {
      const { sqlite, db } = makeDatabase();
      const monitorId = seedMonitor(sqlite, { outageThreshold: 1 });
      const serviceId = '00000000-0000-4000-8000-0000000000e1';
      await addService(sqlite, serviceId, 'webhook', {
        webhookUrl: 'https://hooks.example.test/notify',
      });
      link(sqlite, monitorId, serviceId);
      seedRound(sqlite, {
        id: 'clock-round',
        monitorId,
        windowStartedAt: now.toISOString(),
        status: 'complete',
        expectedRegions: ['us-east'],
      });
      seedObservation(sqlite, {
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
          claimedLease = (
            sqlite.prepare('SELECT lease_until FROM notification_deliveries').get() as {
              lease_until: string;
            }
          ).lease_until;
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
      const delivery = sqlite
        .prepare('SELECT status, next_attempt_at, sent_at FROM notification_deliveries')
        .get() as { status: string; next_attempt_at: string; sent_at: string | null };
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
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { outageThreshold: 1, recoveryThreshold: 1 });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000a1', 'telegram', {
      botToken: '123456:abcdefghijklmnopqrstuvwxyz',
      chatId: '-100123',
    });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000a2', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000a1');
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000a2');
    seedRound(sqlite, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east', 'eu-west'],
    });
    seedObservation(sqlite, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    seedObservation(sqlite, {
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

    const rows = deliveries(sqlite);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'outage')).toBe(true);
    expect(rows.every((row) => row.status === 'sent' && row.attempts === 1)).toBe(true);
    expect(sent.some((url) => url.includes('api.telegram.org'))).toBe(true);
    expect(sent.some((url) => url.includes('hooks.example.test'))).toBe(true);
    const state = sqlite
      .prepare('SELECT status, failure_streak FROM monitor_notification_state WHERE monitor_id = ?')
      .get(monitorId) as { status: string; failure_streak: number };
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
    expect(count(sqlite, 'notification_deliveries')).toBe(2);
  });

  it('records the exact sent text, monitor snapshot, and validated provider link', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {
      id: '00000000-0000-4000-8000-0000000000f8',
      name: 'Checkout API',
      url: 'https://shop.example.test/health',
      outageThreshold: 1,
    });
    const serviceId = '00000000-0000-4000-8000-0000000000f9';
    await addService(sqlite, serviceId, 'telegram', {
      botToken: '123456:abcdefghijklmnopqrstuvwxyz',
      chatId: '@status_room',
    });
    link(sqlite, monitorId, serviceId);
    seedOutage(sqlite, monitorId);
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

    const history = sqlite
      .prepare(
        `SELECT monitor_id, monitor_name, monitor_url, status, text, external_url, error
         FROM notification_history WHERE notification_service_id = ?`,
      )
      .get(serviceId) as {
      monitor_id: string;
      monitor_name: string;
      monitor_url: string;
      status: string;
      text: string;
      external_url: string | null;
      error: string | null;
    };
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
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {
      id: '00000000-0000-4000-8000-0000000000fe',
      outageThreshold: 1,
    });
    const serviceId = '00000000-0000-4000-8000-0000000000ff';
    await addService(sqlite, serviceId, 'telegram', {
      botToken: '123456:abcdefghijklmnopqrstuvwxyz',
      chatId: '-10012345',
    });
    link(sqlite, monitorId, serviceId);
    seedOutage(sqlite, monitorId);

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

    const history = sqlite
      .prepare('SELECT status, error FROM notification_history WHERE notification_service_id = ?')
      .get(serviceId) as { status: string; error: string };
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
      const { sqlite, db } = makeDatabase();
      const monitorId = seedMonitor(sqlite, {
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
      await addService(sqlite, serviceId, 'telegram', {
        botToken: '123456:abcdefghijklmnopqrstuvwxyz',
        chatId: '-10012345',
      });
      link(sqlite, monitorId, serviceId);
      seedOutage(sqlite, monitorId);

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

      const delivery = sqlite
        .prepare(
          'SELECT status, last_error FROM notification_deliveries WHERE notification_service_id = ?',
        )
        .get(serviceId) as { status: string; last_error: string | null };
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
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { outageThreshold: 1 });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000b1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000b1');
    seedRound(sqlite, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'partial',
      expectedRegions: ['us-east', 'eu-west'],
    });
    seedObservation(sqlite, {
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
    expect(count(sqlite, 'notification_deliveries')).toBe(0);
    const state = sqlite
      .prepare(
        'SELECT status, failure_streak, success_streak FROM monitor_notification_state WHERE monitor_id = ?',
      )
      .get(monitorId) as { status: string; failure_streak: number; success_streak: number };
    expect(state).toEqual({ status: 'healthy', failure_streak: 0, success_streak: 0 });
  });

  it('retries transient provider failures with backoff and stops at the attempt limit', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { outageThreshold: 1 });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000c1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000c1');
    seedRound(sqlite, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    seedObservation(sqlite, {
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
    let row = deliveries(sqlite)[0]!;
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
    expect(deliveries(sqlite)[0]!.attempts).toBe(1);

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
    row = deliveries(sqlite)[0]!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(2);
  });

  it('reclaims a delivery whose send lease expired after a crash', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { outageThreshold: 1 });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000d1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000d1');
    // No rounds: the only pending work is the stuck delivery.
    // Simulate a delivery stuck in `sending` from a crashed invocation.
    sqlite
      .prepare(
        `INSERT INTO notification_deliveries (
           id, monitor_id, notification_service_id, event_key, kind, message, status, attempts,
           next_attempt_at, lease_until, lease_token
         ) VALUES ('stuck', ?, '00000000-0000-4000-8000-0000000000d1', 'evt', 'outage',
           '{"kind":"outage","monitorName":"x","monitorUrl":"https://example.com","occurredAt":"2026-09-20T09:59:00.000Z","outageStartedAt":null}',
           'sending', 1, ?, '2026-09-20T09:00:00.000Z', 'dead')`,
      )
      .run(monitorId, now.toISOString());
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
    const row = sqlite
      .prepare("SELECT status, lease_token FROM notification_deliveries WHERE id = 'stuck'")
      .get() as { status: string; lease_token: string | null };
    expect(row.status).toBe('sent');
    expect(row.lease_token).toBeNull();
  });

  it('does not let a stale overlapping evaluation regress a newer incident watermark', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { outageThreshold: 1 });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000f1', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000f1');
    seedRound(sqlite, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    seedObservation(sqlite, {
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
    const advanced = sqlite
      .prepare('SELECT last_window_started_at FROM monitor_notification_state WHERE monitor_id = ?')
      .get(monitorId) as { last_window_started_at: string };
    expect(advanced.last_window_started_at).toBe('2026-09-20T09:59:00.000Z');

    // A stale invocation that observed an empty watermark must not roll state
    // back, nor fabricate a second outage for the already-processed round.
    await processNotifications({ ...deps, leaseToken: 'lease-2' });
    const after = sqlite
      .prepare(
        'SELECT last_window_started_at, status FROM monitor_notification_state WHERE monitor_id = ?',
      )
      .get(monitorId) as { last_window_started_at: string; status: string };
    expect(after).toEqual({
      last_window_started_at: '2026-09-20T09:59:00.000Z',
      status: 'down',
    });
    expect(count(sqlite, 'notification_deliveries')).toBe(1);
  });

  it('does not cancel a newer delivery when a stale evaluation overlaps', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { outageThreshold: 1, recoveryThreshold: 1 });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000f2', 'webhook', {
      webhookUrl: 'https://hooks.example.test/notify',
    });
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000f2');
    // Existing state at an older watermark with a mismatched fingerprint, so a
    // stale evaluation would reset and try to cancel pending deliveries.
    sqlite
      .prepare(
        `INSERT INTO monitor_notification_state (
           monitor_id, config_fingerprint, last_window_started_at, status, failure_streak,
           success_streak, outage_started_at, last_reminder_at
         ) VALUES (?, 'old', '2026-09-20T08:59:00.000Z', 'healthy', 0, 0, NULL, NULL)`,
      )
      .run(monitorId);
    seedRound(sqlite, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    seedObservation(sqlite, {
      checkRunId: 'r1',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-09-20T09:59:00.000Z',
      success: false,
      startedAt: '2026-09-20T09:59:05.000Z',
    });
    // Interleave a newer invocation committing its watermark and delivery
    // between the stale invocation's read and its batch.
    let injected = false;
    const interleaved = {
      ...db,
      batch: async (statements: Parameters<typeof db.batch>[0]) => {
        if (!injected) {
          injected = true;
          sqlite
            .prepare(
              "UPDATE monitor_notification_state SET last_window_started_at = '2026-09-20T09:59:00.000Z' WHERE monitor_id = ?",
            )
            .run(monitorId);
          sqlite
            .prepare(
              `INSERT INTO notification_deliveries (
                 id, monitor_id, notification_service_id, event_key, kind, message, status, attempts,
                 next_attempt_at
               ) VALUES ('newer', ?, '00000000-0000-4000-8000-0000000000f2', 'evt-new', 'outage',
                 '{"kind":"outage","monitorName":"x","monitorUrl":"https://example.com","occurredAt":"2026-09-20T09:59:00.000Z","outageStartedAt":null}',
                 'pending', 0, ?)`,
            )
            .run(monitorId, now.toISOString());
        }
        return db.batch(statements);
      },
    } as typeof db;
    await processNotifications({
      db: interleaved,
      fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      leaseToken: 'lease-1',
      log,
    });
    const newer = sqlite
      .prepare("SELECT status FROM notification_deliveries WHERE id = 'newer'")
      .get() as { status: string };
    expect(newer.status).not.toBe('cancelled');
    // The stale batch must not enqueue its own obsolete outage alongside the
    // delivery created by the invocation that won the state transition.
    expect(count(sqlite, 'notification_deliveries')).toBe(1);
  });

  it('fails an SMTP delivery terminally because Workers cannot open sockets', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, { outageThreshold: 1 });
    await addService(sqlite, '00000000-0000-4000-8000-0000000000e1', 'smtp', {
      host: 'smtp.example.test',
      port: 587,
      security: 'starttls',
      from: 'uptime@example.test',
      to: ['ops@example.test'],
    });
    link(sqlite, monitorId, '00000000-0000-4000-8000-0000000000e1');
    seedRound(sqlite, {
      id: 'r1',
      monitorId,
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      status: 'complete',
      expectedRegions: ['us-east'],
    });
    seedObservation(sqlite, {
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
    const row = deliveries(sqlite)[0]!;
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
