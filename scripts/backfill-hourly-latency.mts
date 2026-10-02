/** Backfill retained latency once, using Wrangler's existing authentication. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { hourlyLatencyAggregateSql } from '../apps/coordinator-worker/src/hourly-latency.js';

const { values } = parseArgs({
  options: {
    database: { type: 'string' },
    config: { type: 'string' },
    remote: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    shard: { type: 'string', default: '0' },
    shards: { type: 'string', default: '1' },
  },
});
if (!values.database || !values.config || !values.remote) {
  throw new Error('Required: --database NAME --config PATH --remote [--force]');
}

const execute = promisify(execFile);
const config = resolve(values.config);
const shard = Number(values.shard);
const shards = Number(values.shards);
if (
  !Number.isInteger(shards) ||
  shards < 1 ||
  shards > 4 ||
  !Number.isInteger(shard) ||
  shard < 0 ||
  shard >= shards
) {
  throw new Error('Expected 1–4 shards and a zero-based shard index');
}
const startedAt = new Date();
const since = new Date(startedAt.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
const today = startedAt.toISOString().slice(0, 10);
let rowsRead = 0;
let rowsWritten = 0;
let completedDays = 0;

function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('Unsupported SQL parameter');
}

function bind(sql: string, parameters: unknown[]): string {
  let position = 0;
  const result = sql.replace(/\?/g, () => literal(parameters[position++]));
  if (position !== parameters.length) throw new Error('SQL parameter count mismatch');
  return result;
}

interface QueryResult {
  success: boolean;
  results: Record<string, unknown>[];
  meta: { rows_read: number; rows_written: number };
}

async function query(sql: string): Promise<QueryResult[]> {
  let stdout = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      ({ stdout } = await execute(
        'pnpm',
        [
          '--filter',
          '@uptime/api-worker',
          'exec',
          'wrangler',
          'd1',
          'execute',
          values.database!,
          '--remote',
          '--config',
          config,
          '--command',
          sql,
          '--json',
        ],
        { maxBuffer: 4 * 1_024 * 1_024 },
      ));
      break;
    } catch {
      // All writes below are idempotent. An uncertain response can safely retry.
      if (attempt === 2) throw new Error('D1 backfill command failed after three attempts');
      console.log(JSON.stringify({ event: 'hourly_backfill_retry', attempt: attempt + 1 }));
      await delay((attempt + 1) * 1_000);
    }
  }
  const results = JSON.parse(stdout) as QueryResult[];
  if (!results.every((result) => result.success)) throw new Error('D1 backfill query failed');
  for (const result of results) {
    rowsRead += result.meta.rows_read;
    rowsWritten += result.meta.rows_written;
  }
  return results;
}

const [{ results: candidates }] = await query(
  bind(
    `SELECT m.id, (
     SELECT MIN(started_at) FROM observations WHERE monitor_id = m.id AND started_at >= ?
   ) AS first_at, EXISTS (
     SELECT 1 FROM monitor_latency_coverage c WHERE c.monitor_id = m.id
   ) AS covered FROM monitors m
   ORDER BY m.id`,
    [`${since}T00:00:00.000Z`],
  ),
);
const monitors = candidates.filter(
  (monitor) => String(monitor.id).charCodeAt(0) % shards === shard,
);

console.log(
  JSON.stringify({ event: 'hourly_backfill_start', monitors: monitors.length, since, today }),
);
for (const monitor of monitors) {
  const id = String(monitor.id);
  const firstDay =
    monitor.covered && !values.force
      ? today
      : monitor.first_at
        ? String(monitor.first_at).slice(0, 10)
        : today;
  // Include today: observations written before migration have no dirty keys.
  // Resuming also repairs today's coverage for already completed monitors.
  let day = firstDay;
  while (day <= today) {
    const statements: string[] = [];
    for (let count = 0; count < 8 && day <= today; count += 1) {
      const from = `${day}T00:00:00.000Z`;
      const until = new Date(Date.parse(from) + 86_400_000).toISOString();
      statements.push(
        bind(
          `${hourlyLatencyAggregateSql}
         ON CONFLICT (monitor_id, hour, region_id) DO UPDATE SET payload = excluded.payload`,
          [id, from, until, id],
        ),
      );
      day = until.slice(0, 10);
    }
    await query(statements.join(';\n'));
    completedDays += statements.length;
    console.log(
      JSON.stringify({
        event: 'hourly_backfill_progress',
        monitorId: id,
        through: day,
        completedDays,
        rowsRead,
        rowsWritten,
      }),
    );
  }
  // Keep dirty keys: writes concurrent with backfill still need ordinary repair.
  await query(
    bind(
      `INSERT INTO monitor_latency_coverage (monitor_id, since) VALUES (?, ?)
     ON CONFLICT (monitor_id) DO UPDATE SET since = MIN(since, excluded.since)`,
      [id, `${since}T00:00:00.000Z`],
    ),
  );
}
console.log(
  JSON.stringify({
    event: 'hourly_backfill_complete',
    monitors: monitors.length,
    completedDays,
    rowsRead,
    rowsWritten,
    durationMs: Date.now() - startedAt.getTime(),
  }),
);
