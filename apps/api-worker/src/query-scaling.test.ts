import { afterEach, describe, expect, it } from 'vitest';
import { type Database, pgAll } from '@uptime/cloudflare/postgres';

import {
  getStatusPage,
  monitorSelect,
  monitorSummaries,
  publicStatusPagePayload,
} from './queries.js';
import { createTestContext, type TestContext } from './testing/test-utils.js';
import type { MonitorRow } from './types.js';

const contexts: TestContext[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close();
});

function countingDatabase(db: Database): { db: Database; queries: () => number } {
  let count = 0;
  return {
    db: {
      ...db,
      query: (sql, values) => {
        count += 1;
        return db.query(sql, values);
      },
      transaction: async (fn) => {
        return db.transaction(async (tx) => {
          const countingTx = {
            ...tx,
            query: (sql: string, values?: unknown[]) => {
              count += 1;
              return tx.query(sql, values);
            },
          };
          return fn(countingTx as unknown as Database);
        });
      },
    },
    queries: () => count,
  };
}

describe('high-cardinality API query scaling', () => {
  it('keeps monitor lists and 150-monitor status pages on a fixed query budget', async () => {
    const ctx = await createTestContext();
    contexts.push(ctx);
    const db = ctx.db;

    await db.query(`
      INSERT INTO ${db.table('status_pages')} (id, title, public_slug) VALUES ('page', 'Large page', 'large-page');
      INSERT INTO ${db.table('status_page_groups')} (id, status_page_id, title, position)
        VALUES ('group', 'page', 'Services', 0);
      INSERT INTO ${db.table('monitors')}
        (id, name, url, interval_seconds, timeout_ms, next_check_at, created_at, updated_at)
      SELECT 'monitor-' || lpad(i::text, 3, '0'), 'Monitor ' || lpad(i::text, 3, '0'),
        'https://example.com/' || i, 60, 1000, '2026-09-21T12:00:00.000Z',
        '2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z'
      FROM generate_series(0, 149) AS i;
      INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id)
      SELECT 'monitor-' || lpad(i::text, 3, '0'), 'us-east' FROM generate_series(0, 149) AS i;
      INSERT INTO ${db.table('status_page_monitors')} (status_page_id, group_id, monitor_id, position)
      SELECT 'page', 'group', 'monitor-' || lpad(i::text, 3, '0'), i FROM generate_series(0, 149) AS i;
    `);

    const listCounter = countingDatabase(db);
    const rows = await pgAll<MonitorRow>(
      listCounter.db,
      `${monitorSelect(listCounter.db)} ORDER BY m.created_at DESC`,
    );
    const summaries = await monitorSummaries(listCounter.db, rows, {
      warn: () => undefined,
    });
    expect(summaries).toHaveLength(150);
    expect(summaries[0]?.monitor.regionIds).toEqual(['us-east']);
    expect(listCounter.queries()).toBe(4);

    const page = await getStatusPage(db, 'page');
    expect(page).not.toBeNull();
    const pageCounter = countingDatabase(db);
    const payload = await publicStatusPagePayload(
      pageCounter.db,
      page!,
      new Date('2026-09-21T12:00:00.000Z'),
    );
    expect(payload.statusPage.groups[0]?.monitors).toHaveLength(150);
    expect(payload.statusPage.groups[0]?.monitors[149]).toMatchObject({
      id: 'monitor-149',
      configuredRegionCount: 1,
      status: 'unknown',
      uptimePercentage: null,
    });
    expect(pageCounter.queries()).toBeLessThanOrEqual(8);
  });
});
