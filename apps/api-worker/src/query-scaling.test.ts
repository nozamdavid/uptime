import { describe, expect, it } from 'vitest';
import { createD1Adapter, createTestDatabase } from '@uptime/cloudflare/testing';
import type { D1Database } from '@uptime/cloudflare';

import {
  getStatusPage,
  monitorSelect,
  monitorSummaries,
  publicStatusPagePayload,
} from './queries.js';
import type { MonitorRow } from './types.js';

function countingDatabase(db: D1Database): { db: D1Database; queries: () => number } {
  let count = 0;
  return {
    db: {
      ...db,
      prepare(query: string) {
        count += 1;
        return db.prepare(query);
      },
    },
    queries: () => count,
  };
}

describe('high-cardinality API query scaling', () => {
  it('keeps monitor lists and 150-monitor status pages on a fixed query budget', async () => {
    const sqlite = createTestDatabase();
    sqlite.exec(`
      INSERT INTO status_pages (id, title, public_slug) VALUES ('page', 'Large page', 'large-page');
      INSERT INTO status_page_groups (id, status_page_id, title, position)
        VALUES ('group', 'page', 'Services', 0);
      WITH RECURSIVE sequence(value) AS (
        SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 149
      )
      INSERT INTO monitors
        (id, name, url, interval_seconds, timeout_ms, next_check_at, created_at, updated_at)
      SELECT printf('monitor-%03d', value), printf('Monitor %03d', value),
        'https://example.com/' || value, 60, 1000, '2026-09-21T12:00:00.000Z',
        '2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z'
      FROM sequence;
      WITH RECURSIVE sequence(value) AS (
        SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 149
      )
      INSERT INTO monitor_regions (monitor_id, region_id)
      SELECT printf('monitor-%03d', value), 'us-east' FROM sequence;
      WITH RECURSIVE sequence(value) AS (
        SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 149
      )
      INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position)
      SELECT 'page', 'group', printf('monitor-%03d', value), value FROM sequence;
    `);
    const base = createD1Adapter(sqlite);

    const listCounter = countingDatabase(base);
    const rows = await listCounter.db
      .prepare(`${monitorSelect} ORDER BY m.created_at DESC`)
      .all<MonitorRow>();
    const summaries = await monitorSummaries(listCounter.db, rows.results, {
      warn: () => undefined,
    });
    expect(summaries).toHaveLength(150);
    expect(summaries[0]?.monitor.regionIds).toEqual(['us-east']);
    expect(listCounter.queries()).toBe(4);

    const page = await getStatusPage(base, 'page');
    expect(page).not.toBeNull();
    const pageCounter = countingDatabase(base);
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
    base.close();
  });
});
