import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAll, pgFirst, pgRun } from '@uptime/cloudflare/postgres';
import {
  createControlFixture,
  seedControlUser,
  seedControlWorkspace,
  type ControlTestFixture,
} from './testing/control-fixture.js';
import { flushUsage, meterDatabase } from './usage-meter.js';

let fixture: ControlTestFixture;
beforeAll(async () => {
  fixture = await createControlFixture();
}, 120_000);
afterAll(async () => {
  await fixture?.close();
}, 120_000);

describe('meterDatabase', () => {
  it('captures first, all, and run once while preserving native query receivers', async () => {
    const meter = meterDatabase(fixture.db);
    expect(await pgFirst(meter.db, 'SELECT $1::text AS value', ['first'])).toEqual({
      value: 'first',
    });
    expect(await pgAll(meter.db, 'SELECT 1 AS value')).toEqual([{ value: 1 }]);
    await pgRun(meter.db, 'SELECT 2 AS value');
    expect(meter.usage).toMatchObject({
      statements: 3,
      rowsRead: null,
      rowsWritten: null,
      storageBytes: null,
    });
    expect(meter.usage.durationMs).toBeGreaterThan(0);
  });

  it('returns null for an empty first result and records failed native statements', async () => {
    const meter = meterDatabase(fixture.db);
    expect(await pgFirst(meter.db, 'SELECT 1 WHERE false')).toBeNull();
    await expect(meter.db.query('SELECT 1/0')).rejects.toThrow();
    expect(meter.usage).toMatchObject({
      statements: 2,
      rowsRead: null,
      rowsWritten: null,
      storageBytes: null,
    });
  });

  it('meters transaction statements once and preserves atomic rollback', async () => {
    const meter = meterDatabase(fixture.db);
    await expect(
      meter.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ${tx.table('interest_signups')}(did,handle,created_at,updated_at) VALUES('rollback','test','now','now')`,
        );
        await tx.query('SELECT 1/0');
      }),
    ).rejects.toThrow();
    expect(meter.usage.statements).toBe(2);
    expect(
      await pgFirst(
        fixture.db,
        `SELECT did FROM ${fixture.db.table('interest_signups')} WHERE did='rollback'`,
      ),
    ).toBeNull();
  });
});

describe('flushUsage historical D1 measurements', () => {
  it('preserves late measured queries anonymously after workspace deletion', async () => {
    const control = fixture.db;
    const date = new Date('2026-10-02T12:00:00.000Z');
    await seedControlUser(control, 'did:plc:deleted', 'deleted.test');
    await seedControlWorkspace(control, {
      workspaceId: 'deleted-workspace',
      ownerDid: 'did:plc:deleted',
      state: 'deleted',
    });
    await flushUsage(
      control,
      'deleted-workspace',
      { rowsRead: 10, rowsWritten: 5, storageBytes: 0 },
      date,
      2,
    );
    await flushUsage(
      control,
      'deleted-workspace',
      { rowsRead: 4, rowsWritten: 3, storageBytes: 200 },
      date,
      1,
    );
    expect(
      await pgFirst(
        control,
        `SELECT workspace_id,checks::integer,rows_read::integer,rows_written::integer,storage_bytes::integer FROM ${control.table('workspace_usage_daily')} WHERE workspace_id='__deleted__'`,
      ),
    ).toEqual({
      workspace_id: '__deleted__',
      checks: 3,
      rows_read: 14,
      rows_written: 8,
      storage_bytes: 0,
    });
  });

  it('adds historical reads and writes while retaining the largest positive storage snapshot', async () => {
    const control = fixture.db;
    const date = new Date('2026-10-02T12:00:00.000Z');
    await flushUsage(
      control,
      'workspace-1',
      { rowsRead: 4, rowsWritten: 2, storageBytes: 200 },
      date,
    );
    await flushUsage(
      control,
      'workspace-1',
      { rowsRead: 3, rowsWritten: 5, storageBytes: 0 },
      date,
    );
    await flushUsage(
      control,
      'workspace-1',
      { rowsRead: 1, rowsWritten: 1, storageBytes: 150 },
      date,
    );
    expect(
      await pgFirst(
        control,
        `SELECT checks::integer,rows_read::integer,rows_written::integer,storage_bytes::integer FROM ${control.table('workspace_usage_daily')} WHERE workspace_id='workspace-1'`,
      ),
    ).toEqual({ checks: 0, rows_read: 8, rows_written: 8, storage_bytes: 200 });
  });
});
