import {
  hashSessionToken,
  randomToken,
  verifyPassword,
} from '@uptime/cloudflare';
import {
  type Database,
  pgAll,
  pgFirst,
  pgRun,
} from '@uptime/cloudflare/postgres';

import type { ApiConfig } from './env.js';
import { isSupportedPasswordHash } from './password-hash.js';

export interface SessionAdmin {
  id: string;
  email?: string;
}

interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
}

/**
 * Idempotently create the single admin row.
 */
export async function ensureAdmin(db: Database, config: ApiConfig): Promise<void> {
  await pgRun(
    db,
    `INSERT INTO ${db.table('admins')} (id, singleton_key, email, password_hash)
     SELECT $1, 1, $2, $3
     WHERE NOT EXISTS (SELECT 1 FROM ${db.table('admins')})`,
    ['00000000-0000-4000-8000-000000000001', config.adminEmail, config.adminPasswordHash],
  );
}

export type PasswordVerification =
  | { hashIsValid: true; matches: boolean }
  | { hashIsValid: false; matches: false };

/**
 * Verify a stored admin password hash.
 *
 * LIMITATION: Workers cannot run Argon2, so only the PBKDF2 form supported by
 * `@uptime/cloudflare` is verifiable. A legacy Argon2 migration requires
 * rehashing the password hash out-of-band (the login response is the same
 * `auth_configuration_error` distinguishes unsupported hashes from invalid
 * passwords during migration and deployment.
 */
export async function verifyAdminPassword(
  hash: string,
  password: string,
): Promise<PasswordVerification> {
  if (!isSupportedPasswordHash(hash)) return { hashIsValid: false, matches: false };
  try {
    return { hashIsValid: true, matches: await verifyPassword(hash, password) };
  } catch {
    return { hashIsValid: false, matches: false };
  }
}

export async function findAdmin(db: Database): Promise<AdminRow | null> {
  return pgFirst<AdminRow>(db, `SELECT id, email, password_hash FROM ${db.table('admins')} LIMIT 1`);
}

export async function createSession(
  db: Database,
  config: ApiConfig,
  adminId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + config.sessionTtlSeconds * 1_000);
  await pgRun(
    db,
    `INSERT INTO ${db.table('sessions')} (admin_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      adminId,
      await hashSessionToken(token, config.sessionSecret),
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ],
  );
  return { token, expiresAt };
}

export async function deleteSession(
  db: Database,
  config: ApiConfig,
  token: string,
): Promise<void> {
  await pgRun(db, `DELETE FROM ${db.table('sessions')} WHERE token_hash = $1`, [
    await hashSessionToken(token, config.sessionSecret),
  ]);
}

export async function lookupSession(
  db: Database,
  config: ApiConfig,
  token: string,
  now: Date,
): Promise<SessionAdmin | null> {
  const rows = await pgAll<SessionAdmin>(
    db,
    `SELECT admins.id AS id, admins.email AS email
     FROM ${db.table('sessions')} sessions
     JOIN ${db.table('admins')} admins ON admins.id = sessions.admin_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > $2
     LIMIT 1`,
    [await hashSessionToken(token, config.sessionSecret), now.toISOString()],
  );
  return rows[0] ?? null;
}

/** Touch `last_seen_at` opportunistically; failure must not break a request. */
export async function touchSession(
  db: Database,
  config: ApiConfig,
  token: string,
  now: Date,
): Promise<void> {
  const touchBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  await pgRun(
    db,
    `UPDATE ${db.table('sessions')} SET last_seen_at = $1 WHERE token_hash = $2 AND last_seen_at <= $3`,
    [
      now.toISOString(),
      await hashSessionToken(token, config.sessionSecret),
      touchBefore,
    ],
  );
}

export async function pruneExpiredSessions(db: Database, now: Date): Promise<void> {
  // Login must not turn an accumulated session backlog into an unbounded write.
  // Later logins continue draining fixed-size batches.
  await pgRun(
    db,
    `DELETE FROM ${db.table('sessions')} WHERE id IN (
       SELECT id FROM ${db.table('sessions')} WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100
     )`,
    [now.toISOString()],
  );
}
