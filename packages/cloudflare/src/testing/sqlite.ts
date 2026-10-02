import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '../workers-types.js';

const migrationsPath = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Apply the complete ordered D1 migration set, as Wrangler does. */
export function applyMigrations(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync(migrationsPath)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(stripSqlComments(readFileSync(`${migrationsPath}/${file}`, 'utf8')));
  }
}

export function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Create an in-memory SQLite database with the full D1 schema applied. */
export function createTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  return db;
}

/**
 * A thin D1Database-compatible adapter over `node:sqlite` so the shared helpers
 * can be exercised against the real migration in tests. It intentionally
 * implements only the surface `@uptime/cloudflare` uses.
 */
export interface TestD1Database extends D1Database {
  close(): void;
}

export function createD1Adapter(db: DatabaseSync): TestD1Database {
  function prepare(query: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        bound = values;
        return statement;
      },
      async first<T>(columnName?: string): Promise<T | null> {
        const row = db.prepare(query).get(...(bound as never[])) as
          Record<string, unknown> | undefined;
        if (!row) return null;
        if (columnName) return (row[columnName] ?? null) as T;
        return row as T;
      },
      async all<T>(): Promise<D1Result<T>> {
        const rows = db.prepare(query).all(...(bound as never[])) as T[];
        return { results: rows, success: true, meta: metaFor(rows.length) };
      },
      async run<T>(): Promise<D1Result<T>> {
        const info = db.prepare(query).run(...(bound as never[]));
        return {
          results: [],
          success: true,
          meta: {
            ...metaFor(0),
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid),
          },
        };
      },
      async raw<T>(): Promise<T[]> {
        return db.prepare(query).all(...(bound as never[])) as T[];
      },
    };
    return statement;
  }

  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      db.exec('BEGIN');
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements) results.push(await statement.all<T>());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
    close() {
      db.close();
    },
  };
}

function metaFor(rows: number) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: rows,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
}
