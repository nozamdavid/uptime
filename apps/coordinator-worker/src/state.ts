import { all, first, nowIso, run, type D1Database, type JobRow } from '@uptime/cloudflare';

export const reportLeaseSeconds = 120;

export async function readJob(db: D1Database, name: string): Promise<JobRow | null> {
  return first<JobRow>(db, 'SELECT * FROM jobs WHERE name = ? LIMIT 1', [name]);
}

/**
 * Acquire a named job lease. D1 has no row locks, so this is a compare-and-set
 * on `(lease_until, lease_token)` made safe by the `name` primary key. The
 * insert wins only when no live lease exists; concurrent updates serialize on
 * D1's single writer, so exactly one caller gets a token.
 */
export async function claimJob(
  db: D1Database,
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
    `INSERT INTO jobs (name, lease_token, lease_until, last_started_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       lease_token = excluded.lease_token,
       lease_until = excluded.lease_until,
       last_started_at = excluded.last_started_at,
       updated_at = excluded.updated_at
     WHERE jobs.lease_until IS NULL OR jobs.lease_until <= ?
     RETURNING lease_token`,
    [name, token, leaseUntil, timestamp, timestamp, timestamp],
  );
  return rows[0]?.lease_token === token ? token : null;
}

export async function saveJobState(
  db: D1Database,
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
    `UPDATE jobs SET
       cursor = CASE WHEN ? THEN ? ELSE cursor END,
       state_json = CASE WHEN ? THEN ? ELSE state_json END,
       lease_token = NULL,
       lease_until = NULL,
       last_completed_at = CASE WHEN ? THEN ? ELSE last_completed_at END,
       updated_at = ?
     WHERE name = ? AND lease_token = ?`,
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
  db: D1Database,
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
    `INSERT INTO jobs (name, cursor, state_json, last_started_at, last_completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       cursor = CASE WHEN ? THEN excluded.cursor ELSE COALESCE(excluded.cursor, jobs.cursor) END,
       state_json = CASE WHEN ? THEN excluded.state_json ELSE COALESCE(excluded.state_json, jobs.state_json) END,
       last_started_at = excluded.last_started_at,
       last_completed_at = CASE WHEN ? THEN excluded.last_completed_at ELSE jobs.last_completed_at END,
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
