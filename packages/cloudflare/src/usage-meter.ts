import type { Database } from './postgres/database.js';
import { pgRun } from './postgres/query.js';

export interface DatabaseUsage {
  readonly rowsRead?: number | null;
  readonly rowsWritten?: number | null;
  readonly storageBytes?: number | null;
  statements?: number;
  durationMs?: number;
}

export interface MeteredDatabase<T = Database> {
  db: T;
  usage: DatabaseUsage;
}

export function meterDatabase(source: Database): MeteredDatabase<Database> {
  const usage: DatabaseUsage = {
    statements: 0,
    durationMs: 0,
    rowsRead: null,
    rowsWritten: null,
    storageBytes: null,
  };

  const wrapped: Database = {
    get schema() {
      return source.schema;
    },
    table(name: string) {
      return source.table(name);
    },
    async query<T extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const start = performance.now();
      try {
        const result = await source.query<T>(sql, values);
        usage.statements = (usage.statements ?? 0) + 1;
        usage.durationMs = (usage.durationMs ?? 0) + (performance.now() - start);
        return result;
      } catch (err) {
        usage.statements = (usage.statements ?? 0) + 1;
        usage.durationMs = (usage.durationMs ?? 0) + (performance.now() - start);
        throw err;
      }
    },
    async transaction<T>(callback: (tx: Database) => Promise<T>) {
      return source.transaction(async (tx) => {
        const meteredTx = meterDatabase(tx);
        try {
          return await callback(meteredTx.db);
        } finally {
          usage.statements = (usage.statements ?? 0) + (meteredTx.usage.statements ?? 0);
          usage.durationMs = (usage.durationMs ?? 0) + (meteredTx.usage.durationMs ?? 0);
        }
      });
    },
  };
  return { db: wrapped, usage };
}

export async function flushUsage(
  control: Database,
  workspaceId: string,
  usage: DatabaseUsage,
  now = new Date(),
  checks = 0,
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();
  const rowsRead = usage.rowsRead ?? 0;
  const rowsWritten = usage.rowsWritten ?? 0;
  const storageBytes = usage.storageBytes ?? 0;

  await pgRun(
    control,
    `INSERT INTO ${control.table('workspace_usage_daily')}
      (workspace_id, day, checks, rows_read, rows_written, storage_bytes, updated_at)
     VALUES (
       CASE WHEN (SELECT state FROM ${control.table('workspaces')} WHERE id = $1) = 'deleted' THEN '__deleted__' ELSE $1 END,
       $2, $3, $4, $5,
       CASE WHEN (SELECT state FROM ${control.table('workspaces')} WHERE id = $1) = 'deleted' THEN 0 ELSE $6 END,
       $7
     )
     ON CONFLICT (workspace_id, day) DO UPDATE SET
       checks = ${control.table('workspace_usage_daily')}.checks + excluded.checks,
       rows_read = ${control.table('workspace_usage_daily')}.rows_read + excluded.rows_read,
       rows_written = ${control.table('workspace_usage_daily')}.rows_written + excluded.rows_written,
       storage_bytes = CASE
         WHEN (SELECT state FROM ${control.table('workspaces')} WHERE id = $1) = 'deleted' THEN 0
         ELSE GREATEST(${control.table('workspace_usage_daily')}.storage_bytes, excluded.storage_bytes)
       END,
       updated_at = excluded.updated_at`,
    [workspaceId, day, checks, rowsRead, rowsWritten, storageBytes, timestamp],
  );
}
