import type { D1Database, D1Meta, D1PreparedStatement, D1Result } from '@uptime/cloudflare';

export interface QueryWork {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  unmeasured: number;
}

export type QueryWorkByStage = Record<string, QueryWork>;

export class QueryBudgetExceeded extends Error {
  constructor() {
    super('Coordinator D1 statement budget exhausted');
  }
}

export function isQueryBudgetExceeded(error: unknown): boolean {
  return error instanceof QueryBudgetExceeded;
}

const empty = (): QueryWork => ({ statements: 0, rowsRead: 0, rowsWritten: 0, unmeasured: 0 });

/** Coordinator-local D1 wrapper that preserves native metadata by implementing first via all. */
export function meterDatabase(source: D1Database) {
  let stage = 'startup';
  let statementLimit: number | null = null;
  const work: QueryWorkByStage = {};
  let reserved = 0;
  const complete = (target: QueryWork, meta?: Partial<D1Meta>) => {
    if (meta?.rows_read === undefined || meta.rows_written === undefined) target.unmeasured += 1;
    else {
      target.rowsRead += Number(meta.rows_read);
      target.rowsWritten += Number(meta.rows_written);
    }
  };
  const reserve = (count = 1): QueryWork => {
    if (statementLimit !== null && reserved + count > statementLimit)
      throw new QueryBudgetExceeded();
    reserved += count;
    const target = (work[stage] ??= empty());
    target.statements += count;
    return target;
  };
  const wrap = (
    native: D1PreparedStatement,
  ): D1PreparedStatement & { native: D1PreparedStatement } => {
    const statement = {
      native,
      bind(...values: unknown[]) {
        return wrap(native.bind(...values));
      },
      async first<T>(columnName?: string): Promise<T | null> {
        const target = reserve();
        let result: D1Result<Record<string, unknown>>;
        try {
          result = await native.all<Record<string, unknown>>();
        } catch (error) {
          target.unmeasured += 1;
          throw error;
        }
        complete(target, result.meta);
        const row = result.results?.[0];
        if (!row) return null;
        return (columnName ? row[columnName] : row) as T;
      },
      async run<T>(): Promise<D1Result<T>> {
        const target = reserve();
        let result: D1Result<T>;
        try {
          result = await native.run<T>();
        } catch (error) {
          target.unmeasured += 1;
          throw error;
        }
        complete(target, result.meta);
        return result;
      },
      async all<T>(): Promise<D1Result<T>> {
        const target = reserve();
        let result: D1Result<T>;
        try {
          result = await native.all<T>();
        } catch (error) {
          target.unmeasured += 1;
          throw error;
        }
        complete(target, result.meta);
        return result;
      },
      async raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
        const target = reserve();
        let result: T[];
        try {
          result = await native.raw<T>(options);
        } catch (error) {
          target.unmeasured += 1;
          throw error;
        }
        complete(target);
        return result;
      },
    };
    return statement;
  };
  const db: D1Database = {
    prepare: (query) => wrap(source.prepare(query)),
    async batch<T>(statements: D1PreparedStatement[]) {
      const target = reserve(statements.length);
      let results: D1Result<T>[];
      try {
        results = await source.batch<T>(
          statements.map(
            (statement) => (statement as { native?: D1PreparedStatement }).native ?? statement,
          ),
        );
      } catch (error) {
        target.unmeasured += statements.length;
        throw error;
      }
      for (const result of results) complete(target, result.meta);
      return results;
    },
    async exec(query) {
      const target = reserve();
      let result: { count: number; duration: number };
      try {
        result = await source.exec(query);
      } catch (error) {
        target.unmeasured += 1;
        throw error;
      }
      complete(target);
      return result;
    },
    dump: () => source.dump(),
  };
  return {
    db,
    work,
    setStage: (value: string) => (stage = value),
    setStatementLimit: (value: number | null) => (statementLimit = value),
    statementCount: () => reserved,
  };
}
