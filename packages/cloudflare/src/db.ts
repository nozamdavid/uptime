import type { D1Database, D1PreparedStatement, D1Result } from './workers-types.js';

/** Values D1 accepts after normalization. */
export type BindValue = string | number | null | ArrayBuffer | ArrayBufferView;

/** Convert app values (booleans, dates, undefined) into D1-safe bind values. */
export function normalizeBindValue(value: unknown): BindValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return value as BindValue;
  }
  return JSON.stringify(value);
}

export function bindAll(
  statement: D1PreparedStatement,
  values: readonly unknown[] = [],
): D1PreparedStatement {
  return values.length === 0 ? statement : statement.bind(...values.map(normalizeBindValue));
}

/** Run a query expected to return at most one row. */
export async function first<T extends object>(
  db: D1Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T | null> {
  return bindAll(db.prepare(sql), values).first<T>();
}

/** Run a query returning all rows. */
export async function all<T extends object>(
  db: D1Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result: D1Result<T> = await bindAll(db.prepare(sql), values).all<T>();
  return result.results ?? [];
}

/** Run a statement, returning D1 metadata (changes, last_row_id, ...). */
export async function run(
  db: D1Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<D1Result<Record<string, unknown>>> {
  return bindAll(db.prepare(sql), values).run();
}

/**
 * Execute a batch atomically. D1 batches are transactional and much faster than
 * sequential writes; related state changes should use this.
 */
export async function batch(
  db: D1Database,
  statements: readonly { sql: string; values?: readonly unknown[] }[],
): Promise<D1Result<Record<string, unknown>>[]> {
  if (statements.length === 0) return [];
  return db.batch(
    statements.map((statement) => bindAll(db.prepare(statement.sql), statement.values ?? [])),
  );
}

export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed:.*UNIQUE/i.test(
    message,
  );
}

/**
 * Exponential backoff with deterministic jitter, matching the notification
 * retry policy already used by the scheduler.
 */
export function jitteredBackoffSeconds(attempts: number, minimumSeconds = 30): number {
  const exponential = minimumSeconds * 2 ** Math.max(0, attempts - 1);
  return Math.min(3_600, exponential);
}

/** Split an array into bounded chunks for D1 parameter limits. */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
