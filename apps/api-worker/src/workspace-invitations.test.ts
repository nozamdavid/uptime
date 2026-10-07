import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptWorkspaceInvitation,
  computeInvitationExpiresAt,
  computeInvitationStatus,
  createWorkspaceInvitation,
  INVITATION_EXPIRY_MS,
  listWorkspaceInvitations,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  WorkspaceInvitationError,
} from './workspace-invitations.js';
import { pgFirst, pgRun } from '@uptime/cloudflare/postgres';
import {
  createControlFixture,
  seedControlUser,
  seedControlWorkspace,
  type ControlTestFixture,
} from './testing/control-fixture.js';

let fixture: ControlTestFixture;

beforeAll(async () => {
  fixture = await createControlFixture();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

describe('workspace-invitations module', { timeout: 60_000 }, () => {
  describe('concurrency races with two independent connections', () => {
    it('handles last seat race under competing transactions: one succeeds, one rejected with 409', async () => {
      const conn2 = await fixture.openConnection();
      const wsId = 'race-last-seat-ws';
      const ownerDid = 'did:plc:race_owner_1';
      const member1Did = 'did:plc:race_m1';
      const invitee1Did = 'did:plc:race_inv1';
      const invitee2Did = 'did:plc:race_inv2';

      await seedControlUser(fixture.db, ownerDid, 'owner.race1');
      await seedControlUser(fixture.db, member1Did, 'm1.race1');
      await seedControlUser(fixture.db, invitee1Did, 'inv1.race1');
      await seedControlUser(fixture.db, invitee2Did, 'inv2.race1');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      // Add 2nd member -> 2 members total (free tier limit is 3, so exactly 1 seat left)
      await pgRun(
        fixture.db,
        `INSERT INTO ${fixture.db.table('memberships')} (workspace_id, did, role, created_at)
         VALUES ($1, $2, 'maintainer', $3)`,
        [wsId, member1Did, new Date().toISOString()],
      );

      // Two concurrent transactions attempt to claim the last remaining seat via invitation creation
      const [res1, res2] = await Promise.allSettled([
        createWorkspaceInvitation(fixture.db, {
          workspaceId: wsId,
          actorDid: ownerDid,
          inviteeDid: invitee1Did,
          role: 'viewer',
        }),
        createWorkspaceInvitation(conn2, {
          workspaceId: wsId,
          actorDid: ownerDid,
          inviteeDid: invitee2Did,
          role: 'viewer',
        }),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The rejected one must be 409 member_limit
      const rejection = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejection).toBeInstanceOf(WorkspaceInvitationError);
      expect(rejection.status).toBe(409);
      expect(rejection.code).toBe('member_limit');

      // The winning invitee can accept the invitation to fill the workspace
      const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
      await acceptWorkspaceInvitation(fixture.db, {
        invitationId: winner.invitation.id,
        principalDid: winner.invitation.inviteeDid,
      });

      // Total memberships must be exactly 3 (owner + member1 + winning invitee)
      const countRow = await pgFirst<{ count: string | number }>(
        fixture.db,
        `SELECT count(*) AS count FROM ${fixture.db.table('memberships')} WHERE workspace_id = $1`,
        [wsId],
      );
      expect(Number(countRow?.count)).toBe(3);

      // Exactly 1 invitation_accepted event recorded
      const eventsRow = await pgFirst<{ count: string | number }>(
        fixture.db,
        `SELECT count(*) AS count FROM ${fixture.db.table('workspace_events')}
         WHERE workspace_id = $1 AND event = 'invitation_accepted'`,
        [wsId],
      );
      expect(Number(eventsRow?.count)).toBe(1);
    });

    it('handles replay race under competing transactions: one succeeds, one rejected with 404', async () => {
      const conn2 = await fixture.openConnection();
      const wsId = 'race-replay-ws';
      const ownerDid = 'did:plc:race_owner_2';
      const inviteeDid = 'did:plc:race_inv_replay';

      await seedControlUser(fixture.db, ownerDid, 'owner.race2');
      await seedControlUser(fixture.db, inviteeDid, 'inv.race2');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      const { invitation } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
        inviteeDid,
        role: 'maintainer',
      });

      // Both connections attempt to accept the SAME invitation concurrently
      const [res1, res2] = await Promise.allSettled([
        acceptWorkspaceInvitation(fixture.db, {
          invitationId: invitation.id,
          principalDid: inviteeDid,
        }),
        acceptWorkspaceInvitation(conn2, {
          invitationId: invitation.id,
          principalDid: inviteeDid,
        }),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejection = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejection).toBeInstanceOf(WorkspaceInvitationError);
      expect(rejection.status).toBe(404);
      expect(rejection.code).toBe('not_found');

      // Only 1 membership created for invitee
      const memberCount = await pgFirst<{ count: string | number }>(
        fixture.db,
        `SELECT count(*) AS count FROM ${fixture.db.table('memberships')}
         WHERE workspace_id = $1 AND did = $2`,
        [wsId, inviteeDid],
      );
      expect(Number(memberCount?.count)).toBe(1);
    });

    it('handles revoke vs accept race under competing transactions: one succeeds, one rejected with 404', async () => {
      const conn2 = await fixture.openConnection();
      const wsId = 'race-revoke-accept-ws';
      const ownerDid = 'did:plc:race_owner_3';
      const inviteeDid = 'did:plc:race_inv_revoke';

      await seedControlUser(fixture.db, ownerDid, 'owner.race3');
      await seedControlUser(fixture.db, inviteeDid, 'inv.race3');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      const { invitation } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
        inviteeDid,
        role: 'maintainer',
      });

      // conn1 revokes, conn2 accepts
      const [revokeRes, acceptRes] = await Promise.allSettled([
        revokeWorkspaceInvitation(fixture.db, {
          workspaceId: wsId,
          invitationId: invitation.id,
          actorDid: ownerDid,
        }),
        acceptWorkspaceInvitation(conn2, {
          invitationId: invitation.id,
          principalDid: inviteeDid,
        }),
      ]);

      const fulfilled = [revokeRes, acceptRes].filter((r) => r.status === 'fulfilled');
      const rejected = [revokeRes, acceptRes].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejection = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejection).toBeInstanceOf(WorkspaceInvitationError);
      expect(rejection.status).toBe(404);
      expect(rejection.code).toBe('not_found');
    });
  });

  describe('changes()-based conditional audit semantics', () => {
    it('does not write audit event for failed mutation', async () => {
      const wsId = 'audit-ws';
      const ownerDid = 'did:plc:owner_audit';
      await seedControlUser(fixture.db, ownerDid, 'owner.audit');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      const eventsBefore = await pgFirst<{ count: string | number }>(
        fixture.db,
        `SELECT count(*) AS count FROM ${fixture.db.table('workspace_events')} WHERE workspace_id = $1`,
        [wsId],
      );

      // Attempt revoke on non-existent invitation
      await expect(
        revokeWorkspaceInvitation(fixture.db, {
          workspaceId: wsId,
          invitationId: 'non-existent-invitation-id',
          actorDid: ownerDid,
        }),
      ).rejects.toMatchObject({ status: 404, code: 'not_found' });

      const eventsAfter = await pgFirst<{ count: string | number }>(
        fixture.db,
        `SELECT count(*) AS count FROM ${fixture.db.table('workspace_events')} WHERE workspace_id = $1`,
        [wsId],
      );
      expect(Number(eventsAfter?.count)).toBe(Number(eventsBefore?.count));
    });

    it('rolls back mutations if lifecycle audit persistence fails', async () => {
      const wsId = 'audit-rollback-ws';
      const ownerDid = 'did:plc:owner_rollback';
      const inviteeDid = 'did:plc:inv_rollback';
      await seedControlUser(fixture.db, ownerDid, 'owner.rollback');
      await seedControlUser(fixture.db, inviteeDid, 'inv.rollback');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      // Install a trigger that fails inserts on workspace_events
      await fixture.fixture.adminDb.query(`
        CREATE OR REPLACE FUNCTION ${fixture.schema}.fail_workspace_events()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'audit unavailable';
        END;
        $$ LANGUAGE plpgsql;
      `);
      await fixture.fixture.adminDb.query(`
        CREATE TRIGGER test_fail_audit_trigger
        BEFORE INSERT ON ${fixture.db.table('workspace_events')}
        FOR EACH ROW EXECUTE FUNCTION ${fixture.schema}.fail_workspace_events();
      `);

      try {
        await expect(
          createWorkspaceInvitation(fixture.db, {
            workspaceId: wsId,
            actorDid: ownerDid,
            inviteeDid,
            role: 'viewer',
          }),
        ).rejects.toThrow('audit unavailable');

        // Mutation must be rolled back: no invitation row inserted!
        const invRow = await pgFirst<{ id: string }>(
          fixture.db,
          `SELECT id FROM ${fixture.db.table('workspace_invitations')} WHERE workspace_id = $1`,
          [wsId],
        );
        expect(invRow).toBeNull();
      } finally {
        await fixture.fixture.adminDb.query(`
          DROP TRIGGER IF EXISTS test_fail_audit_trigger ON ${fixture.db.table('workspace_events')};
        `);
        await fixture.fixture.adminDb.query(`
          DROP FUNCTION IF EXISTS ${fixture.schema}.fail_workspace_events();
        `);
      }
    });
  });

  describe('7-day expiry, quota, and authentication semantics', () => {
    it('exact 7-day expiry boundary calculation and enforcement', async () => {
      const wsId = '11111111-1111-4111-8111-111111111111';
      const ownerDid = 'did:plc:owner111';
      const inviteeDid = 'did:plc:invitee111';

      await seedControlUser(fixture.db, ownerDid, 'owner111.test');
      await seedControlUser(fixture.db, inviteeDid, 'invitee111.test');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      const baseTimeMs = 1700000000000;
      const baseIso = new Date(baseTimeMs).toISOString();

      expect(computeInvitationExpiresAt(baseIso)).toBe(
        new Date(baseTimeMs + INVITATION_EXPIRY_MS).toISOString(),
      );

      // 1ms before 7 days -> pending
      expect(computeInvitationStatus(baseIso, baseTimeMs + INVITATION_EXPIRY_MS - 1)).toBe(
        'pending',
      );
      // exact 7 days -> expired
      expect(computeInvitationStatus(baseIso, baseTimeMs + INVITATION_EXPIRY_MS)).toBe('expired');
      // 1ms after 7 days -> expired
      expect(computeInvitationStatus(baseIso, baseTimeMs + INVITATION_EXPIRY_MS + 1)).toBe(
        'expired',
      );

      // Create invitation at baseTime
      const { invitation } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
        inviteeDid,
        role: 'maintainer',
        now: baseTimeMs,
      });

      // Accepting at exact 7-day boundary must be denied
      await expect(
        acceptWorkspaceInvitation(fixture.db, {
          invitationId: invitation.id,
          principalDid: inviteeDid,
          now: baseTimeMs + INVITATION_EXPIRY_MS,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });

      // Accepting 1ms before 7-day boundary succeeds
      const result = await acceptWorkspaceInvitation(fixture.db, {
        invitationId: invitation.id,
        principalDid: inviteeDid,
        now: baseTimeMs + INVITATION_EXPIRY_MS - 1,
      });
      expect(result.workspaceId).toBe(wsId);
    });

    it('renewal (resend) rotates new invitation ID and createdAt so old link is invalid', async () => {
      const wsId = '22222222-2222-4222-8222-222222222222';
      const ownerDid = 'did:plc:owner222';
      const inviteeDid = 'did:plc:invitee222';

      await seedControlUser(fixture.db, ownerDid, 'owner222.test');
      await seedControlUser(fixture.db, inviteeDid, 'invitee222.test');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      const t0 = 1700000000000;
      const { invitation: original } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
        inviteeDid,
        role: 'viewer',
        now: t0,
      });

      // Advance 8 days (now expired)
      const t8Days = t0 + 8 * 86_400_000;

      // Resend / renew invitation
      const { invitation: renewed } = await resendWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        invitationId: original.id,
        actorDid: ownerDid,
        now: t8Days,
      });

      expect(renewed.id).not.toBe(original.id);
      expect(renewed.createdAt).toBe(new Date(t8Days).toISOString());
      expect(renewed.expiresAt).toBe(new Date(t8Days + INVITATION_EXPIRY_MS).toISOString());
      expect(renewed.status).toBe('pending');

      // Old link must fail
      await expect(
        acceptWorkspaceInvitation(fixture.db, {
          invitationId: original.id,
          principalDid: inviteeDid,
          now: t8Days + 1000,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });

      // New link must succeed
      const accepted = await acceptWorkspaceInvitation(fixture.db, {
        invitationId: renewed.id,
        principalDid: inviteeDid,
        now: t8Days + 1000,
      });
      expect(accepted.workspaceId).toBe(wsId);
    });

    it('repeated existing invite upserts work at full quota', async () => {
      const wsId = '33333333-3333-4333-8333-333333333333';
      const ownerDid = 'did:plc:owner333';
      const member1Did = 'did:plc:member333_1';
      const inviteeDid = 'did:plc:invitee333';
      const thirdUserDid = 'did:plc:user333_3';

      await seedControlUser(fixture.db, ownerDid, 'owner333.test');
      await seedControlUser(fixture.db, member1Did, 'member333_1.test');
      await seedControlUser(fixture.db, inviteeDid, 'invitee333.test');
      await seedControlUser(fixture.db, thirdUserDid, 'third333.test');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      // Add 2nd member -> 2 members total
      await pgRun(
        fixture.db,
        `INSERT INTO ${fixture.db.table('memberships')} (workspace_id, did, role, created_at)
         VALUES ($1, $2, 'maintainer', $3)`,
        [wsId, member1Did, new Date().toISOString()],
      );

      // Create pending invite for inviteeDid -> 2 members + 1 pending = 3 (full quota!)
      const { invitation: firstInvite } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
        inviteeDid,
        role: 'viewer',
      });
      expect(firstInvite.role).toBe('viewer');

      // Inviting a NEW user when quota is full (3) must be rejected
      await expect(
        createWorkspaceInvitation(fixture.db, {
          workspaceId: wsId,
          actorDid: ownerDid,
          inviteeDid: thirdUserDid,
          role: 'maintainer',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'member_limit',
      });

      // Upserting existing invite for inviteeDid at full quota must SUCCEED and rotate ID
      const { invitation: upsertedInvite } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
        inviteeDid,
        role: 'maintainer',
      });
      expect(upsertedInvite.id).not.toBe(firstInvite.id);
      expect(upsertedInvite.role).toBe('maintainer');

      // Resend for inviteeDid at full quota must also SUCCEED
      const { invitation: resentInvite } = await resendWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        invitationId: upsertedInvite.id,
        actorDid: ownerDid,
      });
      expect(resentInvite.id).not.toBe(upsertedInvite.id);
      expect(resentInvite.role).toBe('maintainer');
    });

    it('expired invites do not consume quota', async () => {
      const wsId = '44444444-4444-4444-8444-444444444444';
      const ownerDid = 'did:plc:owner444';
      const member1Did = 'did:plc:member444_1';
      const expiredInviteeDid = 'did:plc:expired444';
      const newInviteeDid = 'did:plc:new444';

      await seedControlUser(fixture.db, ownerDid, 'owner444.test');
      await seedControlUser(fixture.db, member1Did, 'member444.test');
      await seedControlUser(fixture.db, expiredInviteeDid, 'expired444.test');
      await seedControlUser(fixture.db, newInviteeDid, 'new444.test');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      // 2 members
      await pgRun(
        fixture.db,
        `INSERT INTO ${fixture.db.table('memberships')} (workspace_id, did, role, created_at)
         VALUES ($1, $2, 'maintainer', $3)`,
        [wsId, member1Did, new Date().toISOString()],
      );

      // 1 expired invite (created 10 days ago)
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      await pgRun(
        fixture.db,
        `INSERT INTO ${fixture.db.table('workspace_invitations')} (id, workspace_id, invitee_did, role, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        ['expired-id', wsId, expiredInviteeDid, 'viewer', tenDaysAgo],
      );

      // New invite must SUCCEED because expired invite does not consume quota
      const { invitation: newInvite } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
        inviteeDid: newInviteeDid,
        role: 'maintainer',
      });
      expect(newInvite.status).toBe('pending');

      // List shows both pending and expired status
      const { invitations } = await listWorkspaceInvitations(fixture.db, {
        workspaceId: wsId,
        actorDid: ownerDid,
      });
      expect(invitations).toHaveLength(2);
      expect(invitations.find((i) => i.inviteeDid === expiredInviteeDid)?.status).toBe('expired');
      expect(invitations.find((i) => i.inviteeDid === newInviteeDid)?.status).toBe('pending');
    });

    it('rejects inviting already-members explicitly', async () => {
      const wsId = '55555555-5555-4555-8555-555555555555';
      const ownerDid = 'did:plc:owner555';
      const memberDid = 'did:plc:member555';

      await seedControlUser(fixture.db, ownerDid, 'owner555.test');
      await seedControlUser(fixture.db, memberDid, 'member555.test');
      await seedControlWorkspace(fixture.db, { workspaceId: wsId, ownerDid });

      // Owner inviting self
      await expect(
        createWorkspaceInvitation(fixture.db, {
          workspaceId: wsId,
          actorDid: ownerDid,
          inviteeDid: ownerDid,
          role: 'maintainer',
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_invitation',
      });

      // Add member
      await pgRun(
        fixture.db,
        `INSERT INTO ${fixture.db.table('memberships')} (workspace_id, did, role, created_at)
         VALUES ($1, $2, 'maintainer', $3)`,
        [wsId, memberDid, new Date().toISOString()],
      );

      // Owner inviting existing member
      await expect(
        createWorkspaceInvitation(fixture.db, {
          workspaceId: wsId,
          actorDid: ownerDid,
          inviteeDid: memberDid,
          role: 'viewer',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'already_member',
      });
    });

    it('enforces owner-only authentication and prevents IDOR', async () => {
      const wsA = '77777777-7777-4777-8777-777777777771';
      const wsB = '77777777-7777-4777-8777-777777777772';
      const ownerA = 'did:plc:ownerA';
      const ownerB = 'did:plc:ownerB';
      const viewerA = 'did:plc:viewerA';
      const invitee = 'did:plc:invitee777';

      await seedControlUser(fixture.db, ownerA, 'ownerA.test');
      await seedControlUser(fixture.db, ownerB, 'ownerB.test');
      await seedControlUser(fixture.db, viewerA, 'viewerA.test');
      await seedControlUser(fixture.db, invitee, 'invitee777.test');

      await seedControlWorkspace(fixture.db, { workspaceId: wsA, ownerDid: ownerA });
      await seedControlWorkspace(fixture.db, { workspaceId: wsB, ownerDid: ownerB });

      // Add viewerA to wsA
      await pgRun(
        fixture.db,
        `INSERT INTO ${fixture.db.table('memberships')} (workspace_id, did, role, created_at)
         VALUES ($1, $2, 'viewer', $3)`,
        [wsA, viewerA, new Date().toISOString()],
      );

      // Viewer trying to create invite in wsA -> 403 forbidden
      await expect(
        createWorkspaceInvitation(fixture.db, {
          workspaceId: wsA,
          actorDid: viewerA,
          inviteeDid: invitee,
          role: 'viewer',
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });

      // Owner B trying to create invite in wsA (IDOR) -> 403 forbidden
      await expect(
        createWorkspaceInvitation(fixture.db, {
          workspaceId: wsA,
          actorDid: ownerB,
          inviteeDid: invitee,
          role: 'viewer',
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });

      // Create valid invite in wsA by ownerA
      const { invitation } = await createWorkspaceInvitation(fixture.db, {
        workspaceId: wsA,
        actorDid: ownerA,
        inviteeDid: invitee,
        role: 'viewer',
      });

      // Owner B trying to revoke wsA invite using wsB scope -> 404 not found
      await expect(
        revokeWorkspaceInvitation(fixture.db, {
          workspaceId: wsB,
          invitationId: invitation.id,
          actorDid: ownerB,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });

      // Owner B trying to revoke wsA invite using wsA scope -> 403 forbidden
      await expect(
        revokeWorkspaceInvitation(fixture.db, {
          workspaceId: wsA,
          invitationId: invitation.id,
          actorDid: ownerB,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    });
  });
});
