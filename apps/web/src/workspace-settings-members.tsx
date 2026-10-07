import { useState } from 'react';
import type { FormEvent } from 'react';
import { AppLink } from './app-link.js';
import { api, type WorkspaceInvitation, type WorkspaceMember } from './api.js';
import { Select } from './select.js';

export interface WorkspaceSettingsMembersProps {
  canManage: boolean;
  members: {
    members: WorkspaceMember[];
    invitations: WorkspaceInvitation[];
  } | null;
  onMembersChanged: (data: {
    members: WorkspaceMember[];
    invitations: WorkspaceInvitation[];
  }) => void;
}

export function WorkspaceSettingsMembers({
  canManage,
  members,
  onMembersChanged,
}: WorkspaceSettingsMembersProps) {
  const [inviteDid, setInviteDid] = useState('');
  const [inviteRole, setInviteRole] = useState<'maintainer' | 'viewer'>('viewer');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');

  // Member removal state
  const [removingDid, setRemovingDid] = useState<string | null>(null);
  const [memberActionError, setMemberActionError] = useState('');
  const [memberActionNotice, setMemberActionNotice] = useState('');

  // Invitation action state (revoke/renew)
  const [actioningInviteId, setActioningInviteId] = useState<string | null>(null);
  const [inviteActionError, setInviteActionError] = useState('');

  async function handleRemoveMember(member: WorkspaceMember) {
    setMemberActionError('');
    setMemberActionNotice('');
    setRemovingDid(member.did);

    try {
      await api.removeWorkspaceMember(member.did);
    } catch (err) {
      setMemberActionError(
        err instanceof Error
          ? err.message
          : `Failed to remove member ${member.handle || member.did}.`,
      );
      setRemovingDid(null);
      return;
    }

    // Refresh to confirm removal
    try {
      const refreshed = await api.workspaceMembers();
      if (refreshed.members.some((m) => m.did === member.did)) {
        setMemberActionError('Member removal was not confirmed by the server.');
      } else {
        onMembersChanged(refreshed);
        setMemberActionNotice(`Removed ${member.handle || member.did}.`);
      }
    } catch {
      // Explain that removal may have succeeded on the server, but confirmation is unavailable
      setMemberActionError(
        'Removal request sent, but confirmation is unavailable because refreshing members failed. Please refresh the page to confirm.',
      );
    } finally {
      setRemovingDid(null);
    }
  }

  async function handleRevokeInvitation(invitationId: string) {
    setInviteActionError('');
    setInviteSuccess('');
    setActioningInviteId(invitationId);

    try {
      await api.revokeWorkspaceInvitation(invitationId);
    } catch (err) {
      setInviteActionError(err instanceof Error ? err.message : 'Failed to revoke invitation.');
      setActioningInviteId(null);
      return;
    }

    try {
      const refreshed = await api.workspaceMembers();
      if (refreshed.invitations.some((i) => i.id === invitationId)) {
        setInviteActionError('Invitation revocation was not confirmed by the server.');
      } else {
        onMembersChanged(refreshed);
        setInviteSuccess('Invitation revoked.');
      }
    } catch {
      setInviteActionError(
        'Revocation request sent, but confirmation is unavailable because refreshing members failed. Please refresh the page to confirm.',
      );
    } finally {
      setActioningInviteId(null);
    }
  }

  async function handleRenewInvitation(invitationId: string) {
    setInviteActionError('');
    setInviteSuccess('');
    setActioningInviteId(invitationId);

    let res: { invitation: WorkspaceInvitation };
    try {
      res = await api.resendWorkspaceInvitation(invitationId);
    } catch (err) {
      setInviteActionError(err instanceof Error ? err.message : 'Failed to renew invitation.');
      setActioningInviteId(null);
      return;
    }

    const newId = res.invitation?.id;

    try {
      const refreshed = await api.workspaceMembers();
      const oldStillPresent = refreshed.invitations.some((i) => i.id === invitationId);
      const newIsPresent = newId ? refreshed.invitations.some((i) => i.id === newId) : false;

      if (oldStillPresent || !newIsPresent) {
        setInviteActionError('Invitation renewal was not confirmed by the server.');
      } else {
        onMembersChanged(refreshed);
        setInviteSuccess(
          `Invitation renewed with a new link (ID: ${newId.slice(0, 8)}…). Old link is invalid.`,
        );
      }
    } catch {
      setInviteActionError(
        'Renewal request sent, but confirmation is unavailable because refreshing members failed. Please refresh the page to confirm.',
      );
    } finally {
      setActioningInviteId(null);
    }
  }

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (!inviteDid.trim()) return;

    setInviting(true);
    setInviteError('');
    setInviteSuccess('');

    try {
      await api.inviteWorkspaceMember(inviteDid.trim(), inviteRole);
      const refreshed = await api.workspaceMembers();
      onMembersChanged(refreshed);
      setInviteDid('');
      setInviteSuccess('Invitation created.');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Could not create invitation.');
    } finally {
      setInviting(false);
    }
  }

  function isExpired(invitation: WorkspaceInvitation) {
    if (invitation.status === 'expired') return true;
    if (invitation.expiresAt) {
      return Date.parse(invitation.expiresAt) <= Date.now();
    }
    return false;
  }

  function formatExpiry(invitation: WorkspaceInvitation) {
    if (!invitation.expiresAt) return null;
    const date = new Date(invitation.expiresAt);
    const expired = isExpired(invitation);
    return (
      <time dateTime={invitation.expiresAt} title={date.toISOString()}>
        {expired ? 'expired ' : 'expires '}
        {date.toLocaleDateString()} {date.toLocaleTimeString()}
      </time>
    );
  }

  return (
    <div className="settings-card">
      <h2>Members</h2>

      {memberActionError && (
        <p className="field-error" role="alert">
          {memberActionError}
        </p>
      )}
      {memberActionNotice && (
        <p className="settings-note" role="status">
          {memberActionNotice}
        </p>
      )}
      {inviteActionError && (
        <p className="field-error" role="alert">
          {inviteActionError}
        </p>
      )}
      {inviteSuccess && (
        <p className="settings-note" role="status">
          {inviteSuccess}
        </p>
      )}

      {members ? (
        <div className="member-list">
          {members.members.map((member) => {
            const isRemoving = removingDid === member.did;
            return (
              <div className="member-row" key={member.did}>
                <span>
                  <strong>{member.handle}</strong>
                  <small className="tnum">{member.did}</small>
                </span>
                <span>
                  {member.role}
                  {canManage && member.role !== 'owner' && (
                    <button
                      className="button button--quiet"
                      disabled={isRemoving || removingDid !== null}
                      onClick={() => void handleRemoveMember(member)}
                    >
                      {isRemoving ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </span>
              </div>
            );
          })}

          {members.invitations.map((invitation) => {
            const expired = isExpired(invitation);
            const isActioning = actioningInviteId === invitation.id;
            const expiryDisplay = formatExpiry(invitation);

            return (
              <div className="member-row" key={invitation.id}>
                <span>
                  Invitation to <span className="tnum">{invitation.inviteeDid}</span>
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                  }}
                >
                  <span>
                    {invitation.role} ·{' '}
                    {expired ? (
                      <strong style={{ color: 'var(--color-danger, #e53e3e)' }}>Expired</strong>
                    ) : (
                      'Pending'
                    )}
                    {expiryDisplay && <> ({expiryDisplay})</>}
                  </span>

                  {!expired && (
                    <AppLink href={`/settings?invite=${encodeURIComponent(invitation.id)}`}>
                      Share accept link
                    </AppLink>
                  )}

                  {canManage && (
                    <>
                      <button
                        className="button button--quiet"
                        style={{ padding: '2px 8px', fontSize: '12px' }}
                        disabled={isActioning || actioningInviteId !== null}
                        onClick={() => void handleRenewInvitation(invitation.id)}
                      >
                        {isActioning ? 'Renewing…' : 'Renew invitation / Get new link'}
                      </button>
                      <button
                        className="button button--quiet"
                        style={{ padding: '2px 8px', fontSize: '12px' }}
                        disabled={isActioning || actioningInviteId !== null}
                        onClick={() => void handleRevokeInvitation(invitation.id)}
                      >
                        {isActioning ? 'Revoking…' : 'Revoke'}
                      </button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p role="status">Loading members…</p>
      )}

      {canManage && (
        <form className="member-invite" onSubmit={(e) => void handleInvite(e)}>
          <label className="field">
            <span>Invite DID</span>
            <input
              value={inviteDid}
              onChange={(event) => setInviteDid(event.target.value)}
              placeholder="did:plc:…"
              required
              disabled={inviting}
            />
          </label>
          <div className="field">
            <label htmlFor="member-invite-role">Role</label>
            <Select<'maintainer' | 'viewer'>
              id="member-invite-role"
              value={inviteRole}
              onChange={setInviteRole}
              disabled={inviting}
              options={[
                { value: 'viewer', label: 'Viewer' },
                { value: 'maintainer', label: 'Maintainer' },
              ]}
            />
          </div>
          {inviteError && (
            <p className="field-error" role="alert">
              {inviteError}
            </p>
          )}
          <button className="button button--quiet" disabled={!inviteDid.trim() || inviting}>
            {inviting ? 'Inviting…' : 'Invite member'}
          </button>
        </form>
      )}
    </div>
  );
}
