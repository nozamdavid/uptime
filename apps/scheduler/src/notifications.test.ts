import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@uptime/database';
import { SchedulerNotifications } from './notifications.js';

const monitorId = '10000000-0000-4000-8000-000000000001';
const serviceId = '20000000-0000-4000-8000-000000000001';
let client: PGlite;
let db: Database;
let now: Date;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
const at = (minute: number) => new Date(Date.UTC(2026, 8, 16, 12, minute)).toISOString();
const scheduler = () =>
  new SchedulerNotifications({ db, fetch: fetchMock, now: () => now, log }, ['us-east', 'eu-west']);

beforeAll(async () => {
  client = new PGlite();
  const directory = new URL('../../../packages/database/migrations/', import.meta.url);
  for (const filename of (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const source = await readFile(new URL(filename, directory), 'utf8');
    // gen_random_uuid is built into PostgreSQL; PGlite does not need the legacy pgcrypto extension.
    await client.exec(source.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  }
  db = drizzle(client) as unknown as Database;
}, 30_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec('TRUNCATE monitors, notification_services CASCADE');
  await client.query(
    `insert into monitors (id,url,interval_seconds,timeout_ms,outage_threshold,recovery_threshold,created_at,updated_at)
    values ($1,'https://example.com',60,1000,3,2,$2,$2)`,
    [monitorId, at(0)],
  );
  await client.query(
    `insert into monitor_regions (monitor_id,region_id) values ($1,'us-east'),($1,'eu-west')`,
    [monitorId],
  );
  await client.query(
    `insert into notification_services (id,name,provider,config,created_at,updated_at)
    values ($1,'Telegram','telegram',$2,$3,$3)`,
    [
      serviceId,
      JSON.stringify({ botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '123' }),
      at(0),
    ],
  );
  await client.query('insert into monitor_notification_services values ($1,$2)', [
    monitorId,
    serviceId,
  ]);
  now = new Date(at(1));
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

async function round(
  minute: number,
  outcomes: boolean[],
  status: 'complete' | 'partial' | 'pending' = 'complete',
) {
  const id = randomUUID();
  await client.query(
    `insert into check_runs (id,monitor_id,window_started_at,status,expected_region_count,monitor_url,timeout_ms)
    values ($1,$2,$3,$4,2,'https://example.com',1000)`,
    [id, monitorId, at(minute), status],
  );
  for (const [index, success] of outcomes.entries()) {
    await client.query(
      `insert into observations (check_run_id,monitor_id,region_id,status,success,http_status,started_at)
      values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        monitorId,
        ['us-east', 'eu-west'][index],
        success ? 'success' : 'http_failure',
        success,
        success ? 200 : 503,
        at(minute),
      ],
    );
  }
  now = new Date(at(minute));
  return id;
}
async function deliveries() {
  return (
    await client.query<{ kind: string; status: string; attempts: number }>(
      'select kind,status,attempts from notification_deliveries order by created_at,id',
    )
  ).rows;
}
async function openOutage() {
  for (let minute = 1; minute <= 3; minute++) {
    await round(minute, [false, true]);
    await scheduler().tick();
  }
  expect(log.error).not.toHaveBeenCalled();
}

describe('persisted scheduler notifications', () => {
  it('applies migrations and preserves consecutive counts across scheduler restarts without duplicate sends', async () => {
    await round(1, [false, true]);
    await scheduler().tick();
    await scheduler().tick();
    expect(fetchMock).not.toHaveBeenCalled();
    await round(2, [false, false]);
    await scheduler().tick();
    expect(fetchMock).not.toHaveBeenCalled();
    await round(3, [true, false]);
    await Promise.all([scheduler().tick(), scheduler().tick()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await deliveries()).toEqual([{ kind: 'outage', status: 'sent', attempts: 1 }]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('requires complete healthy rounds to recover, and sends recovery once', async () => {
    await openOutage();
    await round(4, [true, true]);
    await scheduler().tick();
    await round(5, [true], 'partial');
    await scheduler().tick();
    await round(6, [true, true]);
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await round(7, [true, true]);
    await scheduler().tick();
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await deliveries()).map((entry) => entry.kind)).toEqual(['outage', 'recovery']);
  });

  it('retries transient delivery failures after restart without advancing a new outage', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: false, parameters: { retry_after: 120 } }, { status: 429 }),
    );
    await openOutage();
    expect(await deliveries()).toEqual([{ kind: 'outage', status: 'pending', attempts: 1 }]);
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.exec(
      "update notification_deliveries set next_attempt_at = now() - interval '1 second'",
    );
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await deliveries()).toEqual([{ kind: 'outage', status: 'sent', attempts: 2 }]);
  });

  it('sends timed reminders only when enabled and stops after recovery', async () => {
    await client.exec('update monitors set repeat_notification_minutes = 5');
    await openOutage();
    now = new Date(at(7));
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = new Date(at(8));
    await scheduler().tick();
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await round(9, [true, true]);
    await scheduler().tick();
    await round(10, [true, true]);
    await scheduler().tick();
    now = new Date(at(20));
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await deliveries()).map((entry) => entry.kind)).toEqual([
      'outage',
      'reminder',
      'recovery',
    ]);
  });

  it('does not repeat when disabled and cancels a pending outage once recovered', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await openOutage();
    await round(4, [true, true]);
    await scheduler().tick();
    await round(5, [true, true]);
    await scheduler().tick();
    now = new Date(at(30));
    await scheduler().tick();
    expect((await deliveries()).map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: 'outage', status: 'cancelled' },
      { kind: 'recovery', status: 'sent' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits for an earlier pending round before evaluating later results', async () => {
    const pendingId = await round(1, [], 'pending');
    await round(2, [false, true]);
    await round(3, [false, true]);
    await scheduler().tick();
    expect(fetchMock).not.toHaveBeenCalled();
    await client.query("update check_runs set status = 'partial' where id = $1", [pendingId]);
    await scheduler().tick();
    expect(fetchMock).not.toHaveBeenCalled();
    await round(4, [false, true]);
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels queued deliveries on disable and ignores old failures when re-enabled', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await openOutage();
    await client.query('update monitors set enabled = false, updated_at = $1', [at(4)]);
    now = new Date(at(4));
    await scheduler().tick();
    expect((await deliveries())[0]?.status).toBe('cancelled');
    await client.query('update monitors set enabled = true, updated_at = $1', [at(5)]);
    await round(6, [false, true]);
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await round(7, [false, true]);
    await scheduler().tick();
    await round(8, [false, true]);
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reclaims an expired delivery lease and gives up on permanent provider rejection', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await openOutage();
    await client.exec(
      "update notification_deliveries set status = 'sending', lease_until = now() - interval '1 second'",
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await scheduler().tick();
    expect(await deliveries()).toEqual([{ kind: 'outage', status: 'failed', attempts: 2 }]);
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps an open incident when only a destination name changes', async () => {
    await openOutage();
    await client.query('update notification_services set name = $1, updated_at = $2', [
      'Renamed',
      at(4),
    ]);
    await round(5, [true, true]);
    await scheduler().tick();
    await round(6, [true, true]);
    await scheduler().tick();
    expect((await deliveries()).map((entry) => entry.kind)).toEqual(['outage', 'recovery']);
  });

  it('delivers to multiple selected services independently when one fails', async () => {
    const discordId = randomUUID();
    await client.query(
      `insert into notification_services (id,name,provider,config,created_at,updated_at)
      values ($1,'Discord','discord',$2,$3,$3)`,
      [
        discordId,
        JSON.stringify({ webhookUrl: 'https://discord.com/api/webhooks/123/token' }),
        at(0),
      ],
    );
    await client.query('insert into monitor_notification_services values ($1,$2)', [
      monitorId,
      discordId,
    ]);
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('discord.com')
        ? new Response(null, { status: 503 })
        : Response.json({ ok: true }),
    );
    await openOutage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await deliveries()).map((entry) => entry.status).sort()).toEqual(['pending', 'sent']);
  });

  it('resets an old streak when the target and its policy change', async () => {
    await round(1, [false, true]);
    await scheduler().tick();
    await round(2, [false, true]);
    await scheduler().tick();
    await client.query('update monitors set url = $1, updated_at = $2', [
      'https://example.net',
      at(3),
    ]);
    await round(4, [false, true]);
    await scheduler().tick();
    expect(fetchMock).not.toHaveBeenCalled();
    await round(5, [false, true]);
    await scheduler().tick();
    await round(6, [false, true]);
    await scheduler().tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
