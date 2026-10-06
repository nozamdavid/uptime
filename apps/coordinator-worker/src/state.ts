import { nowIso, type JobRow } from '@uptime/cloudflare';
import {
  pgAll as all,
  pgFirst as first,
  pgRun as run,
  type Database,
} from '@uptime/cloudflare/postgres';

export const reportLeaseSeconds = 120;

export async function readJob(db: Database, name: string): Promise<JobRow | null> {
  return first<JobRow>(db, `SELECT * FROM ${db.table('jobs')} WHERE name = $1 LIMIT 1`, [name]);
}

/**
 * Acquire a named job lease. PostgreSQL serializes the conditional upsert on
 * the unique name; a losing caller receives no row or token.
 */
export async function claimJob(
  db: Database,
  name: string,
  now: Date,
  leaseSeconds: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const timestamp = nowIso(now);
  const leaseUntil = nowIso(new Date(now.getTime() + leaseSeconds * 1_000));
  // Single atomic upsert: the insert wins when no row exists, otherwise the
  // update applies only when the existing lease is free or expired. Comparing
  // the returned token tells the caller whether it won.
  const rows = await all<{ lease_token: string | null }>(
    db,
    `INSERT INTO ${db.table('jobs')} AS jobs (name, lease_token, lease_until, last_started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET
       lease_token = excluded.lease_token,
       lease_until = excluded.lease_until,
       last_started_at = excluded.last_started_at,
       updated_at = excluded.updated_at
     WHERE jobs.lease_until IS NULL OR jobs.lease_until <= $6
     RETURNING lease_token`,
    [name, token, leaseUntil, timestamp, timestamp, timestamp],
  );
  return rows[0]?.lease_token === token ? token : null;
}

export async function saveJobState(
  db: Database,
  name: string,
  options: {
    now: Date;
    leaseToken: string;
    cursor?: unknown;
    state?: unknown;
    completed?: boolean;
  },
): Promise<void> {
  await run(
    db,
    `UPDATE ${db.table('jobs')} SET
       cursor = CASE WHEN $1 = 1 THEN $2 ELSE cursor END,
       state_json = CASE WHEN $3 = 1 THEN $4 ELSE state_json END,
       lease_token = NULL,
       lease_until = NULL,
       last_completed_at = CASE WHEN $5 = 1 THEN $6 ELSE last_completed_at END,
       updated_at = $7
     WHERE name = $8 AND lease_token = $9`,
    [
      options.cursor !== undefined ? 1 : 0,
      options.cursor === undefined ? null : JSON.stringify(options.cursor),
      options.state !== undefined ? 1 : 0,
      options.state === undefined ? null : JSON.stringify(options.state),
      options.completed ? 1 : 0,
      nowIso(options.now),
      nowIso(options.now),
      name,
      options.leaseToken,
    ],
  );
}

/**
 * Upsert progress for a named job. The insert is conflict-safe and the update is
 * a plain last-writer-wins because every field is derived from the current
 * invocation; overlapping invocations only shorten/advance this metadata and
 * never touch scheduling state.
 */
export async function upsertJobState(
  db: Database,
  name: string,
  options: {
    now: Date;
    cursor?: unknown;
    state?: unknown;
    touchCompleted?: boolean;
    leaseToken?: string | null;
    leaseUntil?: Date | null;
  },
): Promise<JobRow | null> {
  const timestamp = nowIso(options.now);
  await run(
    db,
    `INSERT INTO ${db.table('jobs')} AS jobs (name, cursor, state_json, last_started_at, last_completed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET
       cursor = CASE WHEN $7 = 1 THEN excluded.cursor ELSE COALESCE(excluded.cursor, jobs.cursor) END,
       state_json = CASE WHEN $8 = 1 THEN excluded.state_json ELSE COALESCE(excluded.state_json, jobs.state_json) END,
       last_started_at = excluded.last_started_at,
       last_completed_at = CASE WHEN $9 = 1 THEN excluded.last_completed_at ELSE jobs.last_completed_at END,
       updated_at = excluded.updated_at`,
    [
      name,
      options.cursor === undefined ? null : JSON.stringify(options.cursor),
      options.state === undefined ? null : JSON.stringify(options.state),
      timestamp,
      options.touchCompleted ? timestamp : null,
      timestamp,
      options.cursor !== undefined ? 1 : 0,
      options.state !== undefined ? 1 : 0,
      options.touchCompleted ? 1 : 0,
    ],
  );
  return readJob(db, name);
}
