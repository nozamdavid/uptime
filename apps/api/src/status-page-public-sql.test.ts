import argon2 from 'argon2';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@uptime/database';

import { buildApi } from './server.js';

const pageId = '10000000-0000-4000-8000-000000000001';
const groupId = '20000000-0000-4000-8000-000000000001';
const monitorA = '30000000-0000-4000-8000-000000000001';
const monitorB = '30000000-0000-4000-8000-000000000002';
const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('public status page SQL', () => {
  it('prefers finalized rollups, backfills missing days, and reports recovery', async () => {
    const client = new PGlite();
    const passwordHash = await argon2.hash('correct horse battery staple', {
      type: argon2.argon2id,
    });
    const directory = new URL('../../../packages/database/migrations/', import.meta.url);
    for (const filename of (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const source = await readFile(new URL(filename, directory), 'utf8');
      await client.exec(source.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
    const app = await buildApi(
      {
        DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
        SESSION_COOKIE_SECURE: false,
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD_HASH: passwordHash,
        SESSION_SECRET: 'a'.repeat(32),
      },
      {
        db: drizzle(client) as unknown as Database,
        now: () => new Date('2026-09-16T12:00:00.000Z'),
      },
    );
    apps.push(app);

    await client.query(
      `insert into monitors (id, name, url, interval_seconds, timeout_ms)
       values ($1, 'A', 'https://a.example.com', 300, 10000),
              ($2, 'B', 'https://b.example.com', 300, 10000)`,
      [monitorA, monitorB],
    );
    await client.query(
      `insert into monitor_regions (monitor_id, region_id)
       values ($1, 'us-east'), ($1, 'eu-west'), ($2, 'us-east')`,
      [monitorA, monitorB],
    );
    await client.query(
      `insert into status_pages (id, title, public_slug) values ($1, 'Acme', 'acme')`,
      [pageId],
    );
    await client.query(
      `insert into status_page_groups (id, status_page_id, title, position)
       values ($1, $2, 'Core', 0)`,
      [groupId, pageId],
    );
    await client.query(
      `insert into status_page_monitors (status_page_id, group_id, monitor_id, position)
       values ($1, $2, $3, 0), ($1, $2, $4, 1)`,
      [pageId, groupId, monitorA, monitorB],
    );
    // Finalized rollup for A yesterday. B has no rollup: its yesterday must
    // be backfilled from raw observations instead.
    await client.query(
      `insert into monitor_daily_uptime
         (monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count)
       values ($1, '2026-09-15', 100, 50, 10, 10, 10)`,
      [monitorA],
    );

    async function run(
      id: string,
      monitorId: string,
      windowStartedAt: string,
      regions: number,
    ): Promise<void> {
      await client.query(
        `insert into check_runs
           (id, monitor_id, window_started_at, status, expected_region_count, monitor_url, timeout_ms)
         values ($1, $2, $3, 'complete', $4, 'https://example.com', 10000)`,
        [id, monitorId, windowStartedAt, regions],
      );
    }
    async function observe(
      runId: string,
      monitorId: string,
      regionId: string,
      success: boolean,
      responseMs: number | null,
      startedAt: string,
    ): Promise<void> {
      await client.query(
        `insert into observations
           (check_run_id, monitor_id, region_id, status, success, response_ms, started_at, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          runId,
          monitorId,
          regionId,
          success ? 'success' : 'http_failure',
          success,
          responseMs,
          startedAt,
        ],
      );
    }

    // Raw history for A yesterday exists but must lose to the finalized rollup.
    let n = 0;
    for (const hour of ['21', '22', '23']) {
      const runId = `40000000-0000-4000-8000-0000000000${String(10 + n).slice(-2)}`;
      n += 1;
      await run(runId, monitorA, `2026-09-15T${hour}:00:00.000Z`, 1);
      await observe(runId, monitorA, 'us-east', true, 999, `2026-09-15T${hour}:00:10.000Z`);
    }
    // B yesterday has no rollup: backfill from these observations.
    await run('40000000-0000-4000-8000-000000000020', monitorB, '2026-09-15T12:00:00.000Z', 1);
    await observe(
      '40000000-0000-4000-8000-000000000020',
      monitorB,
      'us-east',
      true,
      100,
      '2026-09-15T12:00:10.000Z',
    );
    // Today: A is 3/4 with a us-east failure in the latest window.
    await run('40000000-0000-4000-8000-000000000021', monitorA, '2026-09-16T01:00:00.000Z', 2);
    await observe(
      '40000000-0000-4000-8000-000000000021',
      monitorA,
      'us-east',
      true,
      120,
      '2026-09-16T01:00:10.000Z',
    );
    await observe(
      '40000000-0000-4000-8000-000000000021',
      monitorA,
      'eu-west',
      true,
      130,
      '2026-09-16T01:00:10.000Z',
    );
    await run('40000000-0000-4000-8000-000000000022', monitorA, '2026-09-16T02:00:00.000Z', 2);
    await observe(
      '40000000-0000-4000-8000-000000000022',
      monitorA,
      'us-east',
      false,
      null,
      '2026-09-16T02:00:10.000Z',
    );
    await observe(
      '40000000-0000-4000-8000-000000000022',
      monitorA,
      'eu-west',
      true,
      140,
      '2026-09-16T02:00:10.000Z',
    );
    // Today: B is clean.
    await run('40000000-0000-4000-8000-000000000023', monitorB, '2026-09-16T03:00:00.000Z', 1);
    await observe(
      '40000000-0000-4000-8000-000000000023',
      monitorB,
      'us-east',
      true,
      110,
      '2026-09-16T03:00:10.000Z',
    );

    const response = await app.inject({ method: 'GET', url: '/api/status-pages/public/acme' });
    expect(response.statusCode).toBe(200);
    const monitors = response.json().statusPage.groups[0].monitors;
    expect(monitors).toHaveLength(2);
    // PGlite returns Postgres arrays as literals while postgres-js parses
    // them; normalize so the test asserts on values, not the driver.
    for (const monitor of monitors) {
      if (typeof monitor.affectedRegionIds === 'string') {
        monitor.affectedRegionIds = monitor.affectedRegionIds
          .replace(/^[{\s]+|[}\s]+$/g, '')
          .split(',')
          .map((part: string) => part.trim())
          .filter(Boolean);
      }
    }

    const [a, b] = monitors;
    expect(a.days).toHaveLength(90);
    // Finalized rollup wins over the raw 999ms observations.
    expect(a.days.at(-2)).toEqual({
      date: '2026-09-15',
      uptimePercentage: 100,
      averageResponseMs: 50,
    });
    expect(a.days.at(-1)).toEqual({
      date: '2026-09-16',
      uptimePercentage: 75,
      averageResponseMs: 130,
    });
    expect(a.configuredRegionCount).toBe(2);
    expect(a.affectedRegionIds).toEqual(['us-east']);
    expect(a.recoveryStatus).toBe('down');
    expect(a.status).toBe('down');

    // Missing rollup is backfilled from raw observations.
    expect(b.days.at(-2)).toEqual({
      date: '2026-09-15',
      uptimePercentage: 100,
      averageResponseMs: 100,
    });
    expect(b.days.at(-1)).toEqual({
      date: '2026-09-16',
      uptimePercentage: 100,
      averageResponseMs: 110,
    });
    expect(b.configuredRegionCount).toBe(1);
    expect(b.affectedRegionIds).toEqual([]);
    expect(b.recoveryStatus).toBeNull();
    expect(b.status).toBe('up');
  });
});
