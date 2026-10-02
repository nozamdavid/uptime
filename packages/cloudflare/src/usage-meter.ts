import type { D1Database, D1PreparedStatement, D1Result } from './workers-types.js';

export interface DatabaseUsage {
  rowsRead: number;
  rowsWritten: number;
  storageBytes: number;
}

export interface MeteredDatabase {
  db: D1Database;
  usage: DatabaseUsage;
}

/** Preserve D1 metadata while keeping Worker binding calls on their native receiver. */
export function meterDatabase(source: D1Database): MeteredDatabase {
  const usage: DatabaseUsage = { rowsRead: 0, rowsWritten: 0, storageBytes: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const natives = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const record = (result: D1Result<unknown>) => {
    usage.rowsRead += Number(result.meta.rows_read ?? 0);
    usage.rowsWritten += Number(result.meta.rows_written ?? 0);
    usage.storageBytes = Math.max(usage.storageBytes, Number(result.meta.size_after ?? 0));
  };
  const wrap = (native: D1PreparedStatement): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind(...values) {
        return wrap(native.bind(...values));
      },
      async first<T>(columnName?: string) {
        const result = await native.all<Record<string, unknown>>();
        record(result);
        const row = result.results[0];
        return (row ? (columnName ? row[columnName] : row) : null) as T | null;
      },
      async all<T>() {
        const result = await native.all<T>();
        record(result as D1Result<unknown>);
        return result;
      },
      async run<T>() {
        const result = await native.run<T>();
        record(result as D1Result<unknown>);
        return result;
      },
      raw<T>(options?: { columnNames?: boolean }) {
        return native.raw<T>(options);
      },
    };
    natives.set(wrapped, native);
    return wrapped;
  };
  const db: D1Database = {
    prepare(query) {
      const native = source.prepare(query);
      const existing = originals.get(native);
      if (existing) return existing;
      const wrapped = wrap(native);
      originals.set(native, wrapped);
      return wrapped;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      const result = await source.batch<T>(
        statements.map((statement: D1PreparedStatement) => natives.get(statement) ?? statement),
      );
      for (const item of result) record(item as D1Result<unknown>);
      return result;
    },
    exec(query) {
      return source.exec(query);
    },
    dump() {
      return source.dump();
    },
  };
  return { db, usage };
}

export async function flushUsage(
  control: D1Database,
  workspaceId: string,
  usage: DatabaseUsage,
  now = new Date(),
  checks = 0,
): Promise<void> {
  await control
    .prepare(
      `INSERT INTO workspace_usage_daily
    (workspace_id, day, checks, rows_read, rows_written, storage_bytes, updated_at)
    VALUES (
      CASE WHEN (SELECT state FROM workspaces WHERE id = ?) = 'deleted' THEN '__deleted__' ELSE ? END,
      ?, ?, ?, ?,
      CASE WHEN (SELECT state FROM workspaces WHERE id = ?) = 'deleted' THEN 0 ELSE ? END,
      ?)
    ON CONFLICT(workspace_id, day) DO UPDATE SET
      checks = checks + excluded.checks,
      rows_read = rows_read + excluded.rows_read,
      rows_written = rows_written + excluded.rows_written,
      storage_bytes = MAX(storage_bytes, excluded.storage_bytes),
      updated_at = excluded.updated_at`,
    )
    .bind(
      workspaceId,
      workspaceId,
      now.toISOString().slice(0, 10),
      checks,
      usage.rowsRead,
      usage.rowsWritten,
      workspaceId,
      usage.storageBytes,
      now.toISOString(),
    )
    .run();
}
