import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase } from '@uptime/database';

import { claimDueRunsQuery } from './scheduler.js';

const databaseUrl = process.env['DATABASE_URL'];
const database = databaseUrl ? createDatabase(databaseUrl) : null;

describe('claimDueRunsQuery', () => {
  it('does not use updated_at while advancing a routine check schedule', () => {
    const query = new PgDialect().sqlToQuery(claimDueRunsQuery()).sql;

    expect(query).not.toContain('updated_at');
  });
});

async function counts(): Promise<{ monitors: number; checkRuns: number; observations: number }> {
  if (!database) throw new Error('DATABASE_URL is required for this integration test');
  const result = await database.db.execute(sql`
    SELECT
      (SELECT count(*)::integer FROM monitors) AS monitors,
      (SELECT count(*)::integer FROM check_runs) AS "checkRuns",
      (SELECT count(*)::integer FROM observations) AS observations
  `);
  return (result as unknown as { monitors: number; checkRuns: number; observations: number }[])[0]!;
}

describe.skipIf(!database)('due-run claim SQL', () => {
  afterAll(async () => {
    await database?.close();
  });

  it('is accepted by PostgreSQL without mutating monitor or run data', async () => {
    const before = await counts();

    await expect(database!.db.execute(sql`EXPLAIN ${claimDueRunsQuery()}`)).resolves.toBeDefined();

    await expect(counts()).resolves.toEqual(before);
  });

  it('advances next_check_at without changing updated_at', async () => {
    const monitorId = '00000000-0000-4000-8000-000000000099';
    const rollback = new Error('rollback claimed run test data');

    await expect(
      database!.db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO monitors (
            id, name, url, interval_seconds, timeout_ms, enabled, dns_diagnostics_enabled,
            next_check_at, created_at, updated_at
          ) VALUES (
            ${monitorId}, 'claim query freshness test', 'https://example.com/health',
            60, 1000, true, false,
            now() - interval '1 minute', now() - interval '1 day',
            date_trunc('milliseconds', now()) - interval '1 day'
          )
        `);
        await tx.execute(sql`
          INSERT INTO monitor_regions (monitor_id, region_id) VALUES (${monitorId}, 'eu-west')
        `);
        const before = await tx.execute(
          sql`SELECT updated_at AS "updatedAt" FROM monitors WHERE id = ${monitorId}`,
        );

        await tx.execute(claimDueRunsQuery());

        const after = await tx.execute(
          sql`SELECT updated_at AS "updatedAt" FROM monitors WHERE id = ${monitorId}`,
        );
        const beforeUpdatedAt = (before as unknown as { updatedAt: Date }[])[0]?.updatedAt;
        const afterUpdatedAt = (after as unknown as { updatedAt: Date }[])[0]?.updatedAt;
        expect(afterUpdatedAt?.getTime()).toBe(beforeUpdatedAt?.getTime());

        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
