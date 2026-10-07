import { pgAll, pgFirst, pgRun, type Database } from '@uptime/cloudflare/postgres';
import type { AtprotoPrincipal } from './atproto-auth.js';

export const interestReturnPath = '/?interest=joined';

interface InterestRow {
  did: string;
  handle: string;
  created_at: string;
  updated_at: string;
}

export async function recordInterest(db: Database, principal: AtprotoPrincipal, now = new Date()) {
  const timestamp = now.toISOString();
  await pgRun(
    db,
    `INSERT INTO ${db.table('interest_signups')}(did,handle,created_at,updated_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(did) DO UPDATE SET handle=excluded.handle,updated_at=excluded.updated_at`,
    [principal.did, principal.handle, timestamp, timestamp],
  );
}

function serialize(row: InterestRow) {
  return { did: row.did, handle: row.handle, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function interestSignup(db: Database, did: string) {
  const row = await pgFirst<InterestRow>(
    db,
    `SELECT * FROM ${db.table('interest_signups')} WHERE did=$1`,
    [did],
  );
  return row ? serialize(row) : null;
}

export async function interestList(db: Database) {
  const [count, rows] = await Promise.all([
    pgFirst<{ total: number }>(
      db,
      `SELECT count(*)::integer AS total FROM ${db.table('interest_signups')}`,
    ),
    pgAll<InterestRow>(
      db,
      `SELECT * FROM ${db.table('interest_signups')} ORDER BY created_at DESC,did LIMIT 500`,
    ),
  ]);
  return { total: count?.total ?? 0, signups: rows.map(serialize) };
}
