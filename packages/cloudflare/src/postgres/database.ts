import pg from 'pg';

export interface QueryResult<T extends object> {
  readonly rows: T[];
  readonly rowCount: number | null;
}

export interface Database {
  readonly schema: string;
  query<T extends object = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  transaction<T>(callback: (db: Database) => Promise<T>): Promise<T>;
  table(name: string): string;
}

export interface DatabaseScope {
  readonly schema: string;
  readonly tables: readonly string[];
}

export interface StatementTelemetry {
  readonly durationMs: number;
  readonly rowCount: number | null;
  readonly success: boolean;
}

export interface PostgresOptions extends DatabaseScope {
  readonly connectionString: string;
  readonly onStatement?: (event: StatementTelemetry) => void;
}

export interface PostgresDatabase extends Database {
  close(): Promise<void>;
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error('Invalid trusted PostgreSQL identifier');
  }
  return `"${identifier}"`;
}

/** Preserve the existing TEXT/0-or-1 row contract without changing SQL dialect. */
export function normalizePostgresValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return value.map(normalizePostgresValue);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/** Scope identifiers only; the role's grants remain the database security boundary. */
export function scopePostgresDatabase(db: Database, scope: DatabaseScope): Database {
  const schema = quotePostgresIdentifier(scope.schema);
  const tables = new Set(scope.tables);
  for (const table of tables) quotePostgresIdentifier(table);
  return {
    schema: scope.schema,
    query: (sql, values) => db.query(sql, values),
    transaction: (callback) => db.transaction((tx) => callback(scopePostgresDatabase(tx, scope))),
    table(name) {
      if (!tables.has(name)) throw new Error('Table is outside the trusted PostgreSQL scope');
      return `${schema}.${quotePostgresIdentifier(name)}`;
    },
  };
}

/** One client per request. Parallel ordinary statements queue; transactions own the queue. */
export async function openPostgresDatabase(options: PostgresOptions): Promise<PostgresDatabase> {
  quotePostgresIdentifier(options.schema);
  for (const table of options.tables) quotePostgresIdentifier(table);
  const client = new pg.Client({
    connectionString: options.connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('PostgreSQL database is closed'));
    const pending = tail.then(operation);
    tail = pending.catch(() => undefined);
    return pending;
  }
  async function execute<T extends object>(sql: string, values: readonly unknown[] = []) {
    const started = performance.now();
    let rowCount: number | null = null;
    let success = false;
    try {
      const response = await client.query<T>(sql, values.map(normalizePostgresValue));
      // Native simple-protocol migration scripts return one result per statement.
      const result = Array.isArray(response) ? (response.at(-1) as pg.QueryResult<T>) : response;
      if (!result) return { rows: [], rowCount: null };
      rowCount = result.rowCount;
      success = true;
      return { rows: result.rows, rowCount };
    } finally {
      // Observers cannot break a successful transaction or reveal SQL/parameters.
      try {
        options.onStatement?.({ durationMs: performance.now() - started, rowCount, success });
      } catch {
        /* Telemetry is best effort. */
      }
    }
  }
  const base: Database = {
    schema: options.schema,
    table: () => {
      throw new Error('Unscoped PostgreSQL table');
    },
    query: (sql, values) => enqueue(() => execute(sql, values)),
    transaction: (callback) =>
      enqueue(async () => {
        await execute('BEGIN');
        let active = true;
        const tx = scopePostgresDatabase(
          {
            schema: options.schema,
            table: base.table,
            query: (sql, values) => {
              if (!active) return Promise.reject(new Error('PostgreSQL transaction has ended'));
              return execute(sql, values);
            },
            transaction: async () => {
              throw new Error('Nested PostgreSQL transactions are unsupported');
            },
          },
          options,
        );
        try {
          const result = await callback(tx);
          await execute('COMMIT');
          return result;
        } catch (error) {
          try {
            await execute('ROLLBACK');
          } catch {
            closed = true;
            await client.end();
          }
          throw error;
        } finally {
          active = false;
        }
      }),
  };
  return {
    ...scopePostgresDatabase(base, options),
    async close() {
      if (closed) return;
      closed = true;
      await tail;
      await client.end();
    },
  };
}

export interface HyperdriveBinding {
  readonly connectionString: string;
}

export async function withPostgresDatabase<T>(
  binding: HyperdriveBinding,
  scope: DatabaseScope,
  callback: (db: Database) => Promise<T>,
): Promise<T> {
  const db = await openPostgresDatabase({ ...scope, connectionString: binding.connectionString });
  try {
    return await callback(db);
  } finally {
    await db.close();
  }
}
