import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPostgresUniqueViolation,
  normalizePostgresValue,
  openPostgresDatabase,
  quotePostgresIdentifier,
  scopePostgresDatabase,
  withPostgresDatabase,
  type Database,
} from './database.js';
import { resolvePostgresWorkspaceDatabase } from './tenancy.js';
import { applyPostgresMigrations } from './migrate.js';
import { pgBatch, pgFirst, pgRun } from './query.js';

const protocol = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  end: vi.fn(async () => undefined),
  query: vi.fn(async (_sql: string, _values?: unknown[]): Promise<unknown> => ({
    rows: [],
    rowCount: 0,
  })),
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = protocol.connect;
      end = protocol.end;
      query = protocol.query;
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  protocol.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const options = {
  connectionString: 'postgresql://test.invalid/disposable',
  schema: 'tenant_a',
  tables: ['items'],
};

describe('native PostgreSQL runtime', () => {
  it('keeps helper rowCount native and rolls back a failed atomic batch', async () => {
    const db = await openPostgresDatabase(options);
    protocol.query.mockImplementation(async (sql) => {
      if (sql === 'SELECT $1 AS "camelCase"') return { rows: [{ camelCase: 'a' }], rowCount: 1 };
      if (sql === 'UPDATE items') return { rows: [], rowCount: 2 };
      if (sql === 'FAIL') throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { rows: [], rowCount: null };
    });
    expect(await pgFirst(db, 'SELECT $1 AS "camelCase"', ['a'])).toEqual({ camelCase: 'a' });
    expect(await pgRun(db, 'UPDATE items')).toEqual({ rows: [], rowCount: 2 });
    await expect(pgBatch(db, [{ sql: 'UPDATE items' }, { sql: 'FAIL' }])).rejects.toMatchObject({
      code: '23505',
    });
    expect(protocol.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    await db.close();
  });
  it('validates and allowlists qualified identifiers', async () => {
    const db = await openPostgresDatabase(options);
    expect(db.table('items')).toBe('"tenant_a"."items"');
    expect(() => db.table('other')).toThrow('trusted');
    expect(() => quotePostgresIdentifier('tenant_a"; DROP SCHEMA control')).toThrow();
    expect(() => quotePostgresIdentifier('a'.repeat(64))).toThrow();
    await db.close();
  });

  it('binds values without rewriting native SQL and emits no SQL or credentials', async () => {
    const onStatement = vi.fn();
    const db = await openPostgresDatabase({ ...options, onStatement });
    protocol.query.mockResolvedValueOnce({ rows: [{ camelCase: 'id' }], rowCount: 1 });
    expect(await db.query('SELECT $1 AS "camelCase"', [true])).toEqual({
      rows: [{ camelCase: 'id' }],
      rowCount: 1,
    });
    expect(protocol.query).toHaveBeenCalledWith('SELECT $1 AS "camelCase"', [1]);
    expect(Object.keys(onStatement.mock.calls[0]![0]).sort()).toEqual([
      'durationMs',
      'rowCount',
      'success',
    ]);
    expect(normalizePostgresValue(new Date('2026-01-01Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(normalizePostgresValue({ nested: true })).toBe('{"nested":true}');
    expect(normalizePostgresValue(['a', 'b'])).toEqual(['a', 'b']);
    await db.close();
  });

  it('pins a transaction and keeps concurrent outside queries after commit', async () => {
    const db = await openPostgresDatabase(options);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let escaped: Database | undefined;
    const transaction = db.transaction(async (tx) => {
      escaped = tx;
      await tx.query('SELECT $1', ['inside']);
      await expect(tx.transaction(async () => undefined)).rejects.toThrow('Nested');
      entered();
      await gate;
      return 42;
    });
    await ready;
    const outside = db.query('SELECT $1', ['outside']);
    release();
    expect(await transaction).toBe(42);
    await outside;
    expect(protocol.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT $1',
      'COMMIT',
      'SELECT $1',
    ]);
    await expect(escaped!.query('SELECT 1')).rejects.toThrow('ended');
    await db.close();
    await expect(db.query('SELECT 1')).rejects.toThrow('closed');
  });

  it('rolls back conditional writes and preserves SQLSTATE', async () => {
    const error = Object.assign(new Error('duplicate'), { code: '23505' });
    const db = await openPostgresDatabase(options);
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO "tenant_a"."items" VALUES ($1)', ['first']);
        throw error;
      }),
    ).rejects.toBe(error);
    expect(protocol.query.mock.calls.map(([sql]) => sql).at(-1)).toBe('ROLLBACK');
    expect(isPostgresUniqueViolation(error)).toBe(true);
    expect(isPostgresUniqueViolation(new Error('duplicate'))).toBe(false);
    await db.close();
  });

  it('closes request clients even when handlers fail', async () => {
    await expect(
      withPostgresDatabase(options, options, async () => {
        throw new Error('handler');
      }),
    ).rejects.toThrow('handler');
    expect(protocol.end).toHaveBeenCalledOnce();
  });
});

describe('trusted tenant identity', () => {
  const catalog = [
    {
      sourceDatabaseId: 'd1-a',
      schema: 'tenant_a',
      tables: ['workspace_metadata', 'items'],
    },
  ];
  it('accepts a new pool assignment and rejects reuse while holding identity locks', async () => {
    const control = await openPostgresDatabase({
      ...options,
      schema: 'control',
      tables: ['postgres_tenant_registry'],
    });
    let workspace = 'new-workspace';
    protocol.query.mockImplementation(async (sql) => {
      if (sql.includes('postgres_tenant_registry'))
        return {
          rows: [
            {
              workspace_id: workspace,
              source_database_id: 'd1-a',
              schema_name: 'tenant_a',
              status: 'assigned',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('workspace_metadata'))
        return {
          rows: [{ workspace_id: workspace, database_id: 'd1-a', marker_count: 1 }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    const tenant = await resolvePostgresWorkspaceDatabase(control, workspace, catalog);
    await tenant.query(`SELECT * FROM ${tenant.table('items')}`);
    expect(protocol.query.mock.calls.filter(([sql]) => sql.endsWith('FOR SHARE'))).toHaveLength(1);
    expect(
      protocol.query.mock.calls.filter(([sql]) => sql.endsWith('FOR NO KEY UPDATE')),
    ).toHaveLength(1);
    workspace = 'another-workspace';
    const previousCalls = protocol.query.mock.calls.length;
    await expect(tenant.query(`SELECT * FROM ${tenant.table('items')}`)).rejects.toThrow(
      'assigned',
    );
    expect(
      protocol.query.mock.calls.slice(previousCalls).some(([sql]) => sql.includes('."items"')),
    ).toBe(false);
    expect(protocol.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    await control.close();
  });
  it('rejects quarantined sources before touching tenant data', async () => {
    const control = await openPostgresDatabase({
      ...options,
      schema: 'control',
      tables: ['postgres_tenant_registry'],
    });
    protocol.query.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: 'workspace-a',
          source_database_id: 'd1-a',
          schema_name: 'tenant_a',
          status: 'quarantined',
        },
      ],
      rowCount: 1,
    });
    await expect(resolvePostgresWorkspaceDatabase(control, 'workspace-a', catalog)).rejects.toThrow(
      'assigned',
    );
    expect(protocol.query).toHaveBeenCalledTimes(1);
    await control.close();
  });
  it('checks catalog, registry and historical database identity before routing', async () => {
    const control = await openPostgresDatabase({
      ...options,
      schema: 'control',
      tables: ['postgres_tenant_registry'],
    });
    protocol.query.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: 'workspace-a',
          source_database_id: 'd1-a',
          schema_name: 'tenant_a',
          status: 'assigned',
        },
      ],
      rowCount: 1,
    });
    protocol.query.mockResolvedValueOnce({
      rows: [{ workspace_id: 'workspace-a', database_id: 'd1-a', marker_count: 1 }],
      rowCount: 1,
    });
    const tenant = await resolvePostgresWorkspaceDatabase(control, 'workspace-a', catalog);
    expect(tenant.table('items')).toBe('"tenant_a"."items"');
    await expect(resolvePostgresWorkspaceDatabase(control, 'workspace-b', catalog)).rejects.toThrow(
      'assigned',
    );
    expect(() => scopePostgresDatabase(control, { schema: 'bad.schema', tables: [] })).toThrow();
    await control.close();
  });
  it('rejects a registry that points at another workspace schema', async () => {
    const control = await openPostgresDatabase({
      ...options,
      schema: 'control',
      tables: ['postgres_tenant_registry'],
    });
    protocol.query.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: 'workspace-a',
          source_database_id: 'd1-a',
          schema_name: 'tenant_b',
          status: 'assigned',
        },
      ],
      rowCount: 1,
    });
    await expect(resolvePostgresWorkspaceDatabase(control, 'workspace-a', catalog)).rejects.toThrow(
      'identity',
    );
    expect(protocol.query).toHaveBeenCalledTimes(1);
    await control.close();
  });
});

describe('migration runner', () => {
  it('applies native templates intact and records distinct profile IDs', async () => {
    const db = await openPostgresDatabase(options);
    await applyPostgresMigrations(
      db,
      [
        {
          id: '0013_a.sql',
          sql: 'CREATE TABLE {{schema}}.a(id TEXT); CREATE TABLE {{schema}}.b(id TEXT);',
        },
      ],
      'legacy-import',
    );
    expect(protocol.query).toHaveBeenCalledWith(
      'CREATE TABLE "tenant_a".a(id TEXT); CREATE TABLE "tenant_a".b(id TEXT);',
      [],
    );
    expect(
      protocol.query.mock.calls.some(
        ([, values]) => values?.[0] === 'legacy-import' && values?.[1] === '0013_a.sql',
      ),
    ).toBe(true);
    await db.close();
  });
  it('rejects edited applied migrations and rolls back', async () => {
    const db = await openPostgresDatabase(options);
    protocol.query.mockImplementation(async (sql) => ({
      rows: sql.startsWith('SELECT id, checksum') ? [{ id: '0001.sql', checksum: 'changed' }] : [],
      rowCount: 0,
    }));
    await expect(
      applyPostgresMigrations(db, [{ id: '0001.sql', sql: 'SELECT 1' }], 'full-hosted'),
    ).rejects.toThrow('changed');
    expect(protocol.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    await db.close();
  });
});
