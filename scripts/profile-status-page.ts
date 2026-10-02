import { loadEnvFile } from 'node:process';
import { performance } from 'node:perf_hooks';
import { PgDialect } from '../apps/api/node_modules/drizzle-orm/pg-core/index.js';
import { sql } from '../apps/api/node_modules/drizzle-orm/index.js';
import { createDatabase } from '../packages/database/src/index.js';
import { buildApi } from '../apps/api/src/server.js';

async function main() {
loadEnvFile('../../.env');
const database = createDatabase(process.env.DATABASE_URL!);
const dialect = new PgDialect();
let count = 0;
try {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`set local statement_timeout = '20s'`);
    const app = await buildApi(process.env, {
      db: {
        execute: async (query: Parameters<typeof tx.execute>[0]) => {
          const compiled = dialect.sqlToQuery(query as never);
          if (compiled.sql.includes('insert into admins')) return { rows: [] };
          const start = performance.now();
          const result = await tx.execute(query);
          console.log(`QUERY ${++count}: ${(performance.now() - start).toFixed(1)}ms, ${result.length} rows`);
          const plan = await tx.execute(sql`explain (analyze, buffers, format text) ${query}`);
          console.log(plan.map((row) => row['QUERY PLAN']).join('\n'));
          return result;
        },
      } as never,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/status-pages/public/bsky' });
      console.log(`HTTP ${response.statusCode}, ${response.body.length} bytes`);
    } finally {
      await app.close();
    }
  });
} finally {
  await database.close();
}
}

main().catch((error) => {
  console.error(error.code ?? error.name, 'Profiling failed');
  process.exitCode = 1;
});
