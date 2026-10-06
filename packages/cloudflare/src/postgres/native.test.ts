import { describe, expect, it } from 'vitest';
import { createPostgresTestDatabase } from '../testing/postgres.js';
import { applyPostgresMigrations } from './migrate.js';
import { isPostgresUniqueViolation } from './database.js';
import { pgAll, pgBatch, pgFirst, pgRun } from './query.js';

const migrations = [
  {
    id: '0001_native.sql',
    sql: `
  CREATE TABLE {{schema}}.items (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE {{schema}}.events (id TEXT PRIMARY KEY REFERENCES {{schema}}.items(id));
`,
  },
];

describe.skipIf(!process.env.POSTGRES_TEST_ADMIN_URL)('native PostgreSQL integration', () => {
  it('checks native syntax, rollback, unique SQLSTATE, migrations and independent schemas', async () => {
    const first = await createPostgresTestDatabase({ migrations, tables: ['items', 'events'] });
    let second: Awaited<ReturnType<typeof createPostgresTestDatabase>> | undefined;
    try {
      second = await createPostgresTestDatabase({ migrations, tables: ['items', 'events'] });
      await applyPostgresMigrations(first.adminDb, migrations, 'full-hosted');
      await first.db.query(`INSERT INTO ${first.db.table('items')} VALUES ($1, $2)`, ['a', 'kept']);
      await expect(
        first.db.transaction(async (tx) => {
          await tx.query(`UPDATE ${tx.table('items')} SET value = $1 WHERE id = $2`, [
            'rolled-back',
            'a',
          ]);
          await tx.query(`INSERT INTO ${tx.table('items')} VALUES ($1, $2)`, ['a', 'duplicate']);
        }),
      ).rejects.toSatisfy(isPostgresUniqueViolation);
      expect(
        (await first.db.query<{ value: string }>(`SELECT value FROM ${first.db.table('items')}`))
          .rows,
      ).toEqual([{ value: 'kept' }]);
      expect((await second.db.query(`SELECT * FROM ${second.db.table('items')}`)).rowCount).toBe(0);
      await expect(
        first.db.query(`SELECT * FROM ${second.db.table('items')}`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        first.db.query(`CREATE TABLE "${first.schema}".forbidden (id TEXT)`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        first.db.query(`SELECT * FROM ${first.db.table('items')} WHERE id = ?`, ['a']),
      ).rejects.toThrow();
      await expect(
        first.db.query(`INSERT INTO ${first.db.table('events')} VALUES ($1)`, ['missing']),
      ).rejects.toMatchObject({ code: '23503' });
      expect(
        await pgFirst(
          first.db,
          `SELECT $1::text AS "camelCase", $2::integer AS flag,
        $3::text AS json, $4::text AS iso`,
          ['native', true, { valid: true }, new Date('2026-10-05T00:00:00Z')],
        ),
      ).toEqual({
        camelCase: 'native',
        flag: 1,
        json: '{"valid":true}',
        iso: '2026-10-05T00:00:00.000Z',
      });
      expect(await pgAll(first.db, `SELECT $1::text[] AS ids`, [['a', 'b']])).toEqual([
        { ids: ['a', 'b'] },
      ]);
      expect(
        (
          await pgRun(first.db, `UPDATE ${first.db.table('items')} SET value=$1 WHERE id=$2`, [
            'updated',
            'a',
          ])
        ).rowCount,
      ).toBe(1);
      await expect(
        pgBatch(first.db, [
          { sql: `UPDATE ${first.db.table('items')} SET value='batch-rolled-back' WHERE id='a'` },
          { sql: `INSERT INTO ${first.db.table('events')} VALUES ('missing')` },
        ]),
      ).rejects.toMatchObject({ code: '23503' });
      expect(
        await pgFirst(first.db, `SELECT value FROM ${first.db.table('items')} WHERE id='a'`),
      ).toEqual({ value: 'updated' });
    } finally {
      await Promise.all([first.close(), second?.close()]);
    }
  }, 120_000);
});
