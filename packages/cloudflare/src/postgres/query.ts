import type { Database, QueryResult } from './database.js';

export async function pgFirst<T extends object>(
  db: Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T | null> {
  return (await db.query<T>(sql, values)).rows[0] ?? null;
}

export async function pgAll<T extends object>(
  db: Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await db.query<T>(sql, values)).rows;
}

export async function pgRun<T extends object = Record<string, unknown>>(
  db: Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return db.query<T>(sql, values);
}

/** Atomic unconditional statements. Use a transaction callback for branching on rowCount. */
export async function pgBatch(
  db: Database,
  statements: readonly { sql: string; values?: readonly unknown[] }[],
): Promise<QueryResult<Record<string, unknown>>[]> {
  if (statements.length === 0) return [];
  return db.transaction(async (tx) => {
    const results: QueryResult<Record<string, unknown>>[] = [];
    for (const statement of statements) {
      results.push(await tx.query(statement.sql, statement.values ?? []));
    }
    return results;
  });
}
