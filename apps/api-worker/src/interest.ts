import { randomId } from '@uptime/cloudflare';
import { pgAll, pgFirst, pgRun, type Database } from '@uptime/cloudflare/postgres';
import type { AtprotoPrincipal } from './atproto-auth.js';

export const interestReturnPath = '/?interest=joined';

export function normalizeChannel(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase().slice(0, 64);
    if (/^[a-z0-9_-]+$/.test(trimmed)) {
      return trimmed;
    }
  }
  return 'direct';
}

interface InterestRow {
  did: string;
  handle: string;
  created_at: string;
  updated_at: string;
  channel?: string | null;
}

export async function recordInterestSignupStart(
  db: Database,
  channel?: string | null,
  now = new Date(),
) {
  const timestamp = now.toISOString();
  const normalizedChannel = normalizeChannel(channel);
  await pgRun(
    db,
    `INSERT INTO ${db.table('workspace_events')}(id,workspace_id,event,actor_did,created_at,details)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      randomId(),
      null,
      'signup_started',
      null,
      timestamp,
      JSON.stringify({ channel: normalizedChannel }),
    ],
  );
}

export async function recordInterest(
  db: Database,
  principal: AtprotoPrincipal,
  now = new Date(),
  channel?: string | null,
) {
  const timestamp = now.toISOString();
  const normalizedChannel = channel ? normalizeChannel(channel) : null;
  await pgRun(
    db,
    `INSERT INTO ${db.table('interest_signups')}(did,handle,created_at,updated_at,channel) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(did) DO UPDATE SET handle=excluded.handle,updated_at=excluded.updated_at,channel=COALESCE(excluded.channel, ${db.table('interest_signups')}.channel)`,
    [principal.did, principal.handle, timestamp, timestamp, normalizedChannel],
  );

  const existingEvent = await pgFirst<{ id: string }>(
    db,
    `SELECT id FROM ${db.table('workspace_events')} WHERE actor_did=$1 AND event='signup_completed'`,
    [principal.did],
  );
  if (!existingEvent) {
    await pgRun(
      db,
      `INSERT INTO ${db.table('workspace_events')}(id,workspace_id,event,actor_did,created_at,details)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        randomId(),
        null,
        'signup_completed',
        principal.did,
        timestamp,
        JSON.stringify({ channel: normalizeChannel(channel) }),
      ],
    );
  }
}

export async function recordWorkspaceActivation(
  db: Database,
  workspaceId: string,
  ownerDid: string,
  now = new Date(),
  channel?: string | null,
) {
  const existing = await pgFirst<{ id: string }>(
    db,
    `SELECT id FROM ${db.table('workspace_events')} WHERE workspace_id=$1 AND event='workspace_activation'`,
    [workspaceId],
  );
  if (existing) return;

  let resolvedChannel = channel ? normalizeChannel(channel) : null;
  if (!resolvedChannel) {
    const signup = await pgFirst<{ channel: string | null }>(
      db,
      `SELECT channel FROM ${db.table('interest_signups')} WHERE did=$1`,
      [ownerDid],
    );
    resolvedChannel = normalizeChannel(signup?.channel);
  }

  const timestamp = now.toISOString();
  await pgRun(
    db,
    `INSERT INTO ${db.table('workspace_events')}(id,workspace_id,event,actor_did,created_at,details)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      randomId(),
      workspaceId,
      'workspace_activation',
      ownerDid,
      timestamp,
      JSON.stringify({ channel: resolvedChannel }),
    ],
  );
}

function serialize(row: InterestRow) {
  const result: {
    did: string;
    handle: string;
    createdAt: string;
    updatedAt: string;
    channel?: string;
  } = {
    did: row.did,
    handle: row.handle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.channel) {
    result.channel = row.channel;
  }
  return result;
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

export async function interestAttributionSummary(db: Database) {
  const rows = await pgAll<{ event: string; details: string }>(
    db,
    `SELECT event, details FROM ${db.table('workspace_events')}
     WHERE event IN ('signup_started', 'signup_completed', 'workspace_activation')`,
  );
  const summary: Record<string, { started: number; completed: number; activated: number }> = {};
  for (const row of rows) {
    try {
      const details = JSON.parse(row.details) as { channel?: string };
      const channel = normalizeChannel(details.channel);
      if (!summary[channel]) {
        summary[channel] = { started: 0, completed: 0, activated: 0 };
      }
      if (row.event === 'signup_started') summary[channel]!.started++;
      else if (row.event === 'signup_completed') summary[channel]!.completed++;
      else if (row.event === 'workspace_activation') summary[channel]!.activated++;
    } catch {
      // ignore malformed details
    }
  }
  return summary;
}
