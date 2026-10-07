import type { Database } from '@uptime/cloudflare/postgres';

export interface QueryWork {
  statements: number;
  durationMs: number;
  failures: number;
}

export type QueryWorkByStage = Record<string, QueryWork>;

export class QueryBudgetExceeded extends Error {
  constructor() {
    super('Coordinator statement budget exhausted');
  }
}

export function isQueryBudgetExceeded(error: unknown): boolean {
  return error instanceof QueryBudgetExceeded;
}

/** Count and time native statements, including those on the pinned transaction. */
export function meterDatabase(source: Database) {
  let stage = 'startup';
  let statementLimit: number | null = null;
  let reserved = 0;
  const work: QueryWorkByStage = {};
  const wrap = (native: Database): Database => ({
    schema: native.schema,
    table: (name) => native.table(name),
    async query<T extends object = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ) {
      if (statementLimit !== null && reserved + 1 > statementLimit) throw new QueryBudgetExceeded();
      reserved += 1;
      const target = (work[stage] ??= { statements: 0, durationMs: 0, failures: 0 });
      target.statements += 1;
      const started = performance.now();
      try {
        return await native.query<T>(sql, values);
      } catch (error) {
        target.failures += 1;
        throw error;
      } finally {
        target.durationMs += performance.now() - started;
      }
    },
    transaction: (callback) => native.transaction((tx) => callback(wrap(tx))),
  });
  return {
    db: wrap(source),
    work,
    setStage: (value: string) => (stage = value),
    setStatementLimit: (value: number | null) => (statementLimit = value),
    statementCount: () => reserved,
  };
}
