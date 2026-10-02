import { all, first, run, type D1Database } from '@uptime/cloudflare';
import type { AtprotoPrincipal } from './atproto-auth.js';

export const interestReturnPath = '/?interest=joined';

interface InterestRow {
  did: string;
  handle: string;
  created_at: string;
  updated_at: string;
}

export async function recordInterest(
  db: D1Database,
  principal: AtprotoPrincipal,
  now = new Date(),
) {
  const timestamp = now.toISOString();
  await run(
    db,
    `INSERT INTO interest_signups(did,handle,created_at,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(did) DO UPDATE SET handle=excluded.handle,updated_at=excluded.updated_at`,
    [principal.did, principal.handle, timestamp, timestamp],
  );
}

function serialize(row: InterestRow) {
  return { did: row.did, handle: row.handle, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function interestSignup(db: D1Database, did: string) {
  const row = await first<InterestRow>(db, 'SELECT * FROM interest_signups WHERE did=?', [did]);
  return row ? serialize(row) : null;
}

export async function interestList(db: D1Database) {
  const [count, rows] = await Promise.all([
    first<{ total: number }>(db, 'SELECT count(*) AS total FROM interest_signups'),
    all<InterestRow>(db, 'SELECT * FROM interest_signups ORDER BY created_at DESC,did LIMIT 500'),
  ]);
  return { total: count?.total ?? 0, signups: rows.map(serialize) };
}
