import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { expiredCheckRunsQuery, finalizeDailyUptimeRollupsQuery } from './scheduler.js';

describe('daily uptime rollup finalization', () => {
  it('upserts only closed UTC days and preserves imported history', () => {
    const query = new PgDialect().sqlToQuery(
      finalizeDailyUptimeRollupsQuery(new Date('2026-08-30T18:45:00.000Z')),
    );

    const normalizedSql = query.sql.toLowerCase();
    expect(normalizedSql).toContain('insert into monitor_daily_uptime');
    expect(normalizedSql).toContain('on conflict (monitor_id, day) do update');
    expect(normalizedSql).toContain("where monitor_daily_uptime.source = 'calculated'");
    expect(query.params).toContain('2026-08-30T00:00:00.000Z');
    expect(query.params).toContain('2026-08-30T18:45:00.000Z');
  });

  it('purges raw check runs older than 24 hours in bounded batches', () => {
    const query = new PgDialect().sqlToQuery(expiredCheckRunsQuery(500));
    const normalizedSql = query.sql.toLowerCase();
    expect(normalizedSql).toContain('delete from check_runs');
    expect(normalizedSql).toContain("interval '24 hours'");
    expect(query.params).toContain(500);
  });
});
