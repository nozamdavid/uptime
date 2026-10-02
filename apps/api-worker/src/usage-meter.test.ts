import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { createD1Adapter, createTestDatabase } from '@uptime/cloudflare/testing';
import type { D1Database, D1Meta, D1PreparedStatement, D1Result } from '@uptime/cloudflare';

import { flushUsage, meterDatabase } from './usage-meter.js';

const databases: ReturnType<typeof createTestDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('meterDatabase', () => {
  it('captures first, all, and run metadata once while preserving native receivers', async () => {
    const source = new ReceiverDatabase();
    const meter = meterDatabase(source);
    await expect(meter.db.prepare('first').bind('a').first('value')).resolves.toBe('first');
    await meter.db.prepare('all').all();
    await meter.db.prepare('run').run();
    expect(source.firstCalls).toBe(0);
    expect(source.receiverErrors).toBe(0);
    expect(meter.usage).toEqual({ rowsRead: 6, rowsWritten: 3, storageBytes: 90 });
  });

  it('returns null for an empty first result and does not meter raw()', async () => {
    const source = new ReceiverDatabase();
    const meter = meterDatabase(source);
    await expect(meter.db.prepare('empty').first()).resolves.toBeNull();
    await meter.db.prepare('raw').raw();
    expect(meter.usage).toEqual({ rowsRead: 0, rowsWritten: 0, storageBytes: 0 });
  });

  it('unwraps statements for batch and records each returned metadata record once', async () => {
    const source = new ReceiverDatabase();
    const meter = meterDatabase(source);
    await meter.db.batch([meter.db.prepare('batch-one'), meter.db.prepare('batch-two')]);
    expect(source.batchReceivedNativeStatements).toBe(true);
    expect(meter.usage).toEqual({ rowsRead: 7, rowsWritten: 4, storageBytes: 80 });
  });
});

describe('flushUsage', () => {
  it('preserves late billable queries anonymously after workspace deletion', async () => {
    const sqlite = createTestDatabase();
    databases.push(sqlite);
    sqlite.exec(
      readFileSync(
        new URL(
          '../../../packages/cloudflare/src/control-migrations/0001_control.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const date = new Date('2026-10-02T12:00:00.000Z');
    const timestamp = date.toISOString();
    sqlite
      .prepare(
        `INSERT INTO users(did, handle, state, created_at, updated_at, last_seen_at)
      VALUES ('did:plc:deleted', 'deleted.test', 'active', ?, ?, ?)`,
      )
      .run(timestamp, timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO workspaces(id, owner_did, name, state, plan, created_at, updated_at)
      VALUES ('deleted-workspace', 'did:plc:deleted', 'Deleted', 'deleted', 'free', ?, ?)`,
      )
      .run(timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO workspace_usage_daily
      (workspace_id, day, checks, rows_read, rows_written, storage_bytes, updated_at)
      VALUES ('__deleted__', '2026-10-02', 2, 10, 5, 0, ?)`,
      )
      .run(timestamp);

    await flushUsage(
      createD1Adapter(sqlite),
      'deleted-workspace',
      { rowsRead: 4, rowsWritten: 3, storageBytes: 200 },
      date,
      1,
    );

    expect(
      sqlite
        .prepare(
          'SELECT workspace_id, checks, rows_read, rows_written, storage_bytes FROM workspace_usage_daily',
        )
        .all(),
    ).toEqual([
      { workspace_id: '__deleted__', checks: 3, rows_read: 14, rows_written: 8, storage_bytes: 0 },
    ]);
  });

  it('adds reads and writes while retaining the most recent positive storage snapshot', async () => {
    const sqlite = createTestDatabase();
    databases.push(sqlite);
    sqlite.exec(
      readFileSync(
        new URL(
          '../../../packages/cloudflare/src/control-migrations/0001_control.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const control = createD1Adapter(sqlite);
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
      sqlite
        .prepare('SELECT checks, rows_read, rows_written, storage_bytes FROM workspace_usage_daily')
        .get(),
    ).toEqual({
      checks: 0,
      rows_read: 8,
      rows_written: 8,
      storage_bytes: 200,
    });
  });
});

class ReceiverDatabase implements D1Database {
  firstCalls = 0;
  receiverErrors = 0;
  batchReceivedNativeStatements = false;
  private readonly nativeStatements = new Set<D1PreparedStatement>();

  prepare(query: string): D1PreparedStatement {
    const database = this;
    const statement: D1PreparedStatement = {
      bind(..._values) {
        if (this !== statement) database.receiverErrors += 1;
        return statement;
      },
      async first() {
        database.firstCalls += 1;
        return null;
      },
      async all<T>() {
        return resultFor<T>(query);
      },
      async run<T>() {
        return resultFor<T>(query);
      },
      async raw<T>() {
        return [] as T[];
      },
    };
    this.nativeStatements.add(statement);
    return statement;
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batchReceivedNativeStatements = statements.every((statement) =>
      this.nativeStatements.has(statement),
    );
    return statements.map((statement) =>
      resultFor<T>(statement === [...this.nativeStatements][0] ? 'batch-one' : 'batch-two'),
    );
  }

  async exec() {
    return { count: 0, duration: 0 };
  }
  async dump() {
    return new ArrayBuffer(0);
  }
}

function resultFor<T>(kind: string): D1Result<T> {
  const values: Record<string, { reads: number; writes: number; size: number; rows: unknown[] }> = {
    first: { reads: 1, writes: 0, size: 20, rows: [{ value: 'first' }] },
    all: { reads: 2, writes: 0, size: 90, rows: [] },
    run: { reads: 3, writes: 3, size: 30, rows: [] },
    empty: { reads: 0, writes: 0, size: 0, rows: [] },
    'batch-one': { reads: 3, writes: 1, size: 80, rows: [] },
    'batch-two': { reads: 4, writes: 3, size: 10, rows: [] },
  };
  const value = values[kind]!;
  return {
    results: value.rows as T[],
    success: true,
    meta: meta(value.reads, value.writes, value.size),
  };
}

function meta(
  rows_read: number,
  rows_written: number,
  size_after: number,
): D1Meta & Record<string, unknown> {
  return {
    rows_read,
    rows_written,
    size_after,
    duration: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
}
