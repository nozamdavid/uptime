import { randomId } from '@uptime/cloudflare';
import { type Database, pgAll, pgFirst, pgRun } from '@uptime/cloudflare/postgres';

export const INVITATION_EXPIRY_MS = 7 * 86_400_000;
export const MAX_WORKSPACE_MEMBERS_AND_INVITES = 3;

async function workspaceSeatLimit(db: Database, workspaceId: string): Promise<number> {
  const row = await pgFirst<{ seats: number }>(
    db,
    `SELECT seats FROM ${db.table('workspace_seat_limits')} WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (!row || !Number.isInteger(row.seats) || row.seats < 1) {
    throw new WorkspaceInvitationError(
      409,
      'policy_unavailable',
      'Workspace seat policy is unavailable',
    );
  }
  return row.seats;
}

export type InvitationRole = 'maintainer' | 'viewer';
export type InvitationStatus = 'pending' | 'expired';

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  inviteeDid: string;
  role: InvitationRole;
  createdAt: string;
  expiresAt: string;
  status: InvitationStatus;
}

export interface WorkspaceInvitationListItem {
  id: string;
  inviteeDid: string;
  role: InvitationRole;
  createdAt: string;
  expiresAt: string;
  status: InvitationStatus;
}

export class WorkspaceInvitationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceInvitationError';
  }
}

export function computeInvitationExpiresAt(createdAtIso: string): string {
  const createdAtMs = new Date(createdAtIso).getTime();
  return new Date(createdAtMs + INVITATION_EXPIRY_MS).toISOString();
}

export function computeInvitationStatus(
  createdAtIso: string,
  now: Date | number = Date.now(),
): InvitationStatus {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const createdAtMs = new Date(createdAtIso).getTime();
  const expiresAtMs = createdAtMs + INVITATION_EXPIRY_MS;
  return nowMs >= expiresAtMs ? 'expired' : 'pending';
}

export function isInvitationExpired(
  createdAtIso: string,
  now: Date | number = Date.now(),
): boolean {
  return computeInvitationStatus(createdAtIso, now) === 'expired';
}

export async function verifyWorkspaceOwner(
  db: Database,
  workspaceId: string,
  actorDid: string,
  _callerRole?: string,
): Promise<void> {
  const workspace = await pgFirst<{ owner_did: string }>(
    db,
    `SELECT owner_did FROM ${db.table('workspaces')} WHERE id = $1`,
    [workspaceId],
  );
  if (workspace?.owner_did === actorDid) return;

  throw new WorkspaceInvitationError(403, 'forbidden', 'Workspace owner access required');
}

export interface ListInvitationsOptions {
  workspaceId: string;
  actorDid: string;
  callerRole?: string;
  now?: Date | number;
}

export async function listWorkspaceInvitations(
  db: Database,
  options: ListInvitationsOptions,
): Promise<{ invitations: WorkspaceInvitationListItem[] }> {
  await verifyWorkspaceOwner(db, options.workspaceId, options.actorDid, options.callerRole);

  const rows = await pgAll<{
    id: string;
    inviteeDid: string;
    role: string;
    createdAt: string;
  }>(
    db,
    `SELECT id, invitee_did AS "inviteeDid", role, created_at AS "createdAt"
     FROM ${db.table('workspace_invitations')}
     WHERE workspace_id = $1
     ORDER BY created_at ASC`,
    [options.workspaceId],
  );

  const now = options.now ?? Date.now();
  const invitations: WorkspaceInvitationListItem[] = rows.map((row) => ({
    id: row.id,
    inviteeDid: row.inviteeDid,
    role: row.role as InvitationRole,
    createdAt: row.createdAt,
    expiresAt: computeInvitationExpiresAt(row.createdAt),
    status: computeInvitationStatus(row.createdAt, now),
  }));

  return { invitations };
}

export interface CreateInvitationOptions {
  workspaceId: string;
  actorDid: string;
  inviteeDid: string;
  role: InvitationRole;
  callerRole?: string;
  now?: Date | number;
}

export async function createWorkspaceInvitation(
  db: Database,
  options: CreateInvitationOptions,
): Promise<{ invitation: WorkspaceInvitation }> {
  const { workspaceId, actorDid, inviteeDid, role, callerRole } = options;

  if (role !== 'maintainer' && role !== 'viewer') {
    throw new WorkspaceInvitationError(
      400,
      'invalid_invitation',
      'Role must be maintainer or viewer',
    );
  }

  return await db.transaction(async (tx) => {
    // Acquire row-level lock on workspace before seat/entitlement checks and mutations
    const ws = await pgFirst<{ id: string; owner_did: string; state: string }>(
      tx,
      `SELECT id, owner_did, state FROM ${tx.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`,
      [workspaceId],
    );
    if (!ws) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Workspace was not found');
    }
    if (ws.owner_did !== actorDid) {
      throw new WorkspaceInvitationError(403, 'forbidden', 'Workspace owner access required');
    }
    if (ws.state !== 'active') {
      throw new WorkspaceInvitationError(403, 'workspace_unavailable', 'Workspace is not active');
    }
    if (inviteeDid === actorDid || inviteeDid === ws.owner_did) {
      throw new WorkspaceInvitationError(400, 'invalid_invitation', 'Owner is already a member');
    }

    const existingMember = await pgFirst<{ did: string }>(
      tx,
      `SELECT did FROM ${tx.table('memberships')} WHERE workspace_id = $1 AND did = $2`,
      [workspaceId, inviteeDid],
    );
    if (existingMember) {
      throw new WorkspaceInvitationError(
        409,
        'already_member',
        'User is already a member of this workspace',
      );
    }

    const nowMs =
      typeof options.now === 'number' ? options.now : (options.now?.getTime() ?? Date.now());
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso = new Date(nowMs - INVITATION_EXPIRY_MS).toISOString();

    // Check quota: members + other pending invitations (excluding this invitee, excluding expired)
    const membersRow = await pgFirst<{ count: string | number }>(
      tx,
      `SELECT count(*) AS count FROM ${tx.table('memberships')} WHERE workspace_id = $1`,
      [workspaceId],
    );
    const membersCount = Number(membersRow?.count ?? 0);

    const otherPendingRow = await pgFirst<{ count: string | number }>(
      tx,
      `SELECT count(*) AS count FROM ${tx.table('workspace_invitations')}
       WHERE workspace_id = $1 AND invitee_did != $2 AND created_at > $3`,
      [workspaceId, inviteeDid, cutoffIso],
    );
    const otherPendingCount = Number(otherPendingRow?.count ?? 0);

    const seatLimit = await workspaceSeatLimit(tx, workspaceId);
    if (membersCount + otherPendingCount >= seatLimit) {
      throw new WorkspaceInvitationError(
        409,
        'member_limit',
        `This workspace allows ${seatLimit} members including pending invitations`,
      );
    }

    const newId = randomId();
    let insertRes;
    try {
      insertRes = await tx.query<{ id: string }>(
        `INSERT INTO ${tx.table('workspace_invitations')} (id, workspace_id, invitee_did, role, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, invitee_did) DO UPDATE SET
           id = EXCLUDED.id,
           role = EXCLUDED.role,
           created_at = EXCLUDED.created_at
         RETURNING id`,
        [newId, workspaceId, inviteeDid, role, nowIso],
      );
    } catch (error) {
      if (error instanceof Error && /workspace_seat_limit/.test(error.message)) {
        throw new WorkspaceInvitationError(
          409,
          'member_limit',
          `This workspace allows ${seatLimit} members including pending invitations`,
        );
      }
      throw error;
    }

    if (!insertRes.rowCount || insertRes.rowCount === 0) {
      throw new WorkspaceInvitationError(
        409,
        'member_limit',
        'Invitation could not be saved: workspace state, ownership, membership or quota changed',
      );
    }

    // Audit log conditional on successful mutation
    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomId(),
        workspaceId,
        'invitation_created',
        actorDid,
        nowIso,
        JSON.stringify({ did: inviteeDid, role }),
      ],
    );

    return {
      invitation: {
        id: newId,
        workspaceId,
        inviteeDid,
        role,
        createdAt: nowIso,
        expiresAt: computeInvitationExpiresAt(nowIso),
        status: 'pending',
      },
    };
  });
}

export interface ResendInvitationOptions {
  workspaceId: string;
  invitationId?: string;
  inviteeDid?: string;
  actorDid: string;
  callerRole?: string;
  now?: Date | number;
}

export async function resendWorkspaceInvitation(
  db: Database,
  options: ResendInvitationOptions,
): Promise<{ invitation: WorkspaceInvitation }> {
  const { workspaceId, invitationId, inviteeDid, actorDid } = options;

  if (!invitationId && !inviteeDid) {
    throw new WorkspaceInvitationError(
      400,
      'invalid_invitation',
      'Invitation ID or invitee DID is required',
    );
  }

  return await db.transaction(async (tx) => {
    // Acquire row-level lock on workspace before seat/entitlement checks and mutations
    const ws = await pgFirst<{ id: string; owner_did: string; state: string }>(
      tx,
      `SELECT id, owner_did, state FROM ${tx.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`,
      [workspaceId],
    );
    if (!ws) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Workspace was not found');
    }
    if (ws.owner_did !== actorDid) {
      throw new WorkspaceInvitationError(403, 'forbidden', 'Workspace owner access required');
    }
    if (ws.state !== 'active') {
      throw new WorkspaceInvitationError(403, 'workspace_unavailable', 'Workspace is not active');
    }

    const existing = await pgFirst<{
      id: string;
      workspace_id: string;
      invitee_did: string;
      role: InvitationRole;
      created_at: string;
    }>(
      tx,
      invitationId
        ? `SELECT id, workspace_id, invitee_did, role, created_at FROM ${tx.table('workspace_invitations')} WHERE id = $1 AND workspace_id = $2`
        : `SELECT id, workspace_id, invitee_did, role, created_at FROM ${tx.table('workspace_invitations')} WHERE invitee_did = $1 AND workspace_id = $2`,
      [invitationId ?? inviteeDid!, workspaceId],
    );

    if (!existing) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Invitation was not found');
    }

    const member = await pgFirst<{ did: string }>(
      tx,
      `SELECT did FROM ${tx.table('memberships')} WHERE workspace_id = $1 AND did = $2`,
      [workspaceId, existing.invitee_did],
    );
    if (member) {
      throw new WorkspaceInvitationError(
        409,
        'already_member',
        'User is already a member of this workspace',
      );
    }

    const nowMs =
      typeof options.now === 'number' ? options.now : (options.now?.getTime() ?? Date.now());
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso = new Date(nowMs - INVITATION_EXPIRY_MS).toISOString();

    // Check quota: members + other pending invitations (excluding this invitation)
    const membersRow = await pgFirst<{ count: string | number }>(
      tx,
      `SELECT count(*) AS count FROM ${tx.table('memberships')} WHERE workspace_id = $1`,
      [workspaceId],
    );
    const membersCount = Number(membersRow?.count ?? 0);

    const otherPendingRow = await pgFirst<{ count: string | number }>(
      tx,
      `SELECT count(*) AS count FROM ${tx.table('workspace_invitations')}
       WHERE workspace_id = $1 AND id != $2 AND created_at > $3`,
      [workspaceId, existing.id, cutoffIso],
    );
    const otherPendingCount = Number(otherPendingRow?.count ?? 0);

    const seatLimit = await workspaceSeatLimit(tx, workspaceId);
    if (membersCount + otherPendingCount >= seatLimit) {
      throw new WorkspaceInvitationError(
        409,
        'member_limit',
        `This workspace allows ${seatLimit} members including pending invitations`,
      );
    }

    const newId = randomId();
    let updateRes;
    try {
      updateRes = await tx.query<{ id: string }>(
        `UPDATE ${tx.table('workspace_invitations')}
         SET id = $1, created_at = $2
         WHERE id = $3 AND workspace_id = $4
         RETURNING id`,
        [newId, nowIso, existing.id, workspaceId],
      );
    } catch (error) {
      if (error instanceof Error && /workspace_seat_limit/.test(error.message)) {
        throw new WorkspaceInvitationError(
          409,
          'member_limit',
          `This workspace allows ${seatLimit} members including pending invitations`,
        );
      }
      throw error;
    }

    if (!updateRes.rowCount || updateRes.rowCount === 0) {
      throw new WorkspaceInvitationError(
        409,
        'invitation_conflict',
        'Invitation was revoked or workspace state, ownership, membership or quota changed',
      );
    }

    // Audit log conditional on successful mutation
    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomId(),
        workspaceId,
        'invitation_renewed',
        actorDid,
        nowIso,
        JSON.stringify({
          oldInvitationId: existing.id,
          newInvitationId: newId,
          did: existing.invitee_did,
        }),
      ],
    );

    return {
      invitation: {
        id: newId,
        workspaceId,
        inviteeDid: existing.invitee_did,
        role: existing.role,
        createdAt: nowIso,
        expiresAt: computeInvitationExpiresAt(nowIso),
        status: 'pending',
      },
    };
  });
}

export interface RevokeInvitationOptions {
  workspaceId: string;
  invitationId?: string;
  inviteeDid?: string;
  actorDid: string;
  callerRole?: string;
}

export async function revokeWorkspaceInvitation(
  db: Database,
  options: RevokeInvitationOptions,
): Promise<{ revoked: true; id: string }> {
  const { workspaceId, invitationId, inviteeDid, actorDid } = options;

  if (!invitationId && !inviteeDid) {
    throw new WorkspaceInvitationError(
      400,
      'invalid_invitation',
      'Invitation ID or invitee DID is required',
    );
  }

  return await db.transaction(async (tx) => {
    // Acquire row-level lock on workspace before mutations
    const ws = await pgFirst<{ id: string; owner_did: string; state: string }>(
      tx,
      `SELECT id, owner_did, state FROM ${tx.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`,
      [workspaceId],
    );
    if (!ws) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Workspace was not found');
    }
    if (ws.owner_did !== actorDid) {
      throw new WorkspaceInvitationError(403, 'forbidden', 'Workspace owner access required');
    }

    const existing = await pgFirst<{ id: string; invitee_did: string }>(
      tx,
      invitationId
        ? `SELECT id, invitee_did FROM ${tx.table('workspace_invitations')} WHERE id = $1 AND workspace_id = $2`
        : `SELECT id, invitee_did FROM ${tx.table('workspace_invitations')} WHERE invitee_did = $1 AND workspace_id = $2`,
      [invitationId ?? inviteeDid!, workspaceId],
    );

    if (!existing) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Invitation was not found');
    }

    const deleteRes = await tx.query<{ id: string }>(
      `DELETE FROM ${tx.table('workspace_invitations')} WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [existing.id, workspaceId],
    );

    if (!deleteRes.rowCount || deleteRes.rowCount === 0) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Invitation was not found');
    }

    // Audit log conditional on successful mutation
    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomId(),
        workspaceId,
        'invitation_revoked',
        actorDid,
        new Date().toISOString(),
        JSON.stringify({ invitationId: existing.id, did: existing.invitee_did }),
      ],
    );

    return { revoked: true, id: existing.id };
  });
}

export interface AcceptInvitationOptions {
  invitationId: string;
  principalDid: string;
  now?: Date | number;
}

export async function acceptWorkspaceInvitation(
  db: Database,
  options: AcceptInvitationOptions,
): Promise<{ workspaceId: string }> {
  const { invitationId, principalDid } = options;

  return await db.transaction(async (tx) => {
    // Look up target invitation first to discover target workspace
    const target = await pgFirst<{ workspace_id: string }>(
      tx,
      `SELECT workspace_id FROM ${tx.table('workspace_invitations')} WHERE id = $1 AND invitee_did = $2`,
      [invitationId, principalDid],
    );
    if (!target) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Invitation was not found');
    }

    // Acquire row-level lock on workspace before seat/entitlement checks and mutations
    const ws = await pgFirst<{ id: string; state: string }>(
      tx,
      `SELECT id, state FROM ${tx.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`,
      [target.workspace_id],
    );
    if (!ws || ws.state !== 'active') {
      throw new WorkspaceInvitationError(403, 'workspace_unavailable', 'Workspace is not active');
    }

    // Re-verify invitation under workspace lock
    const invitation = await pgFirst<{
      id: string;
      workspace_id: string;
      role: InvitationRole;
      created_at: string;
    }>(
      tx,
      `SELECT id, workspace_id, role, created_at
       FROM ${tx.table('workspace_invitations')}
       WHERE id = $1 AND invitee_did = $2`,
      [invitationId, principalDid],
    );
    if (!invitation) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Invitation was not found');
    }

    const nowMs =
      typeof options.now === 'number' ? options.now : (options.now?.getTime() ?? Date.now());
    const nowIso = new Date(nowMs).toISOString();

    // Exact 7-day boundary: if nowMs >= expiresAtMs, it is expired
    if (computeInvitationStatus(invitation.created_at, nowMs) === 'expired') {
      throw new WorkspaceInvitationError(404, 'not_found', 'Invitation was not found');
    }

    // Check capacity against effective seat limits
    const membersRow = await pgFirst<{ count: string | number }>(
      tx,
      `SELECT count(*) AS count FROM ${tx.table('memberships')} WHERE workspace_id = $1`,
      [invitation.workspace_id],
    );
    const membersCount = Number(membersRow?.count ?? 0);

    const seatLimit = await workspaceSeatLimit(tx, invitation.workspace_id);
    if (membersCount >= seatLimit) {
      throw new WorkspaceInvitationError(409, 'member_limit', 'Workspace seat quota is full');
    }

    // Insert membership atomically
    try {
      await pgRun(
        tx,
        `INSERT INTO ${tx.table('memberships')} (workspace_id, did, role, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, did) DO NOTHING`,
        [invitation.workspace_id, principalDid, invitation.role, nowIso],
      );
    } catch (error) {
      if (error instanceof Error && /workspace_seat_limit/.test(error.message)) {
        throw new WorkspaceInvitationError(409, 'member_limit', 'Workspace seat quota is full');
      }
      throw error;
    }

    // Delete the consumed invitation
    const deleteRes = await tx.query<{ id: string }>(
      `DELETE FROM ${tx.table('workspace_invitations')} WHERE id = $1 RETURNING id`,
      [invitationId],
    );
    if (!deleteRes.rowCount || deleteRes.rowCount === 0) {
      throw new WorkspaceInvitationError(404, 'not_found', 'Invitation was not found');
    }

    // Audit log conditional on successful mutation
    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomId(), invitation.workspace_id, 'invitation_accepted', principalDid, nowIso, '{}'],
    );

    return { workspaceId: invitation.workspace_id };
  });
}
