// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  workspaceMembers: vi.fn(),
  inviteWorkspaceMember: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
  resendWorkspaceInvitation: vi.fn(),
  removeWorkspaceMember: vi.fn(),
}));

vi.mock('./api.js', () => ({
  api: apiMock,
}));

const { WorkspaceSettingsMembers } = await import('./workspace-settings-members.js');

describe('WorkspaceSettingsMembers', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  const baseMembers = [
    { did: 'did:plc:owner', handle: 'owner.test', role: 'owner' as const },
    { did: 'did:plc:member1', handle: 'alice.test', role: 'viewer' as const },
  ];

  const pendingInvitation = {
    id: 'inv-1',
    workspaceId: 'workspace-1',
    inviteeDid: 'did:plc:bob',
    role: 'viewer' as const,
    createdAt: '2026-10-01T12:00:00.000Z',
    expiresAt: '2026-10-08T12:00:00.000Z',
  };

  const expiredInvitation = {
    id: 'inv-2',
    workspaceId: 'workspace-1',
    inviteeDid: 'did:plc:charlie',
    role: 'viewer' as const,
    createdAt: '2026-09-01T12:00:00.000Z',
    expiresAt: '2026-09-08T12:00:00.000Z',
  };

  it('displays pending invitation with exact local expiry and active invite link', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [pendingInvitation],
          },
          onMembersChanged: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('did:plc:bob');
    expect(view.container.textContent).toContain('Pending');
    expect(view.container.textContent).toContain('expires');
    expect(view.container.textContent).not.toContain('expires in 7 days');
    expect(view.container.textContent).toContain('Share accept link');

    await view.cleanup();
  });

  it('displays expired invitation with expired badge and no active link', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [expiredInvitation],
          },
          onMembersChanged: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('did:plc:charlie');
    expect(view.container.textContent).toContain('Expired');
    expect(view.container.textContent).toContain('expired');
    // Expired invitation should not render "Share accept link"
    expect(view.container.textContent).not.toContain('Share accept link');
    expect(view.container.textContent).toContain('Renew invitation / Get new link');

    await view.cleanup();
  });

  it('revokes an invitation and calls onMembersChanged with refreshed list', async () => {
    const refreshedData = {
      members: baseMembers,
      invitations: [],
    };
    apiMock.revokeWorkspaceInvitation.mockResolvedValue({ success: true });
    apiMock.workspaceMembers.mockResolvedValue(refreshedData);
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [pendingInvitation],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    const revokeButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.includes('Revoke'),
    )!;

    await act(async () => {
      revokeButton.click();
      await Promise.resolve();
    });

    expect(apiMock.revokeWorkspaceInvitation).toHaveBeenCalledWith('inv-1');
    expect(apiMock.workspaceMembers).toHaveBeenCalledTimes(1);
    expect(onMembersChanged).toHaveBeenCalledWith(refreshedData);
    expect(view.container.textContent).toContain('Invitation revoked.');

    await view.cleanup();
  });

  it('renews an expired invitation, rotating the link and updating list', async () => {
    const renewed = {
      ...expiredInvitation,
      id: 'inv-renewed',
      expiresAt: '2026-10-15T12:00:00.000Z',
    };
    const refreshedData = {
      members: baseMembers,
      invitations: [renewed],
    };
    apiMock.resendWorkspaceInvitation.mockResolvedValue({
      invitation: renewed,
      inviteUrl: 'https://uptime.test/invite?token=renewed',
    });
    apiMock.workspaceMembers.mockResolvedValue(refreshedData);
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [expiredInvitation],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    const renewButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.includes('Renew invitation'),
    )!;

    await act(async () => {
      renewButton.click();
      await Promise.resolve();
    });

    expect(apiMock.resendWorkspaceInvitation).toHaveBeenCalledWith('inv-2');
    expect(apiMock.workspaceMembers).toHaveBeenCalledTimes(1);
    expect(onMembersChanged).toHaveBeenCalledWith(refreshedData);
    expect(view.container.textContent).toContain('Invitation renewed with a new link');

    await view.cleanup();
  });

  it('hardens member removal: disables button while pending and removes only after refreshed confirmation', async () => {
    let deleteResolve!: (value: { success: boolean }) => void;
    apiMock.removeWorkspaceMember.mockReturnValue(new Promise((res) => (deleteResolve = res)));
    const refreshedData = {
      members: [baseMembers[0]!],
      invitations: [],
    };
    apiMock.workspaceMembers.mockResolvedValue(refreshedData);
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('alice.test');
    const removeButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.includes('Remove'),
    )!;

    await act(async () => {
      removeButton.click();
    });

    expect(removeButton.disabled).toBe(true);
    expect(removeButton.textContent).toBe('Removing…');
    expect(apiMock.removeWorkspaceMember).toHaveBeenCalledWith('did:plc:member1');

    await act(async () => {
      deleteResolve({ success: true });
      await Promise.resolve();
    });

    expect(apiMock.workspaceMembers).toHaveBeenCalledTimes(1);
    expect(onMembersChanged).toHaveBeenCalledWith(refreshedData);
    expect(view.container.textContent).toContain('Removed alice.test.');

    await view.cleanup();
  });

  it('member removal: shows warning explaining removal may have succeeded if refresh fails after deletion', async () => {
    apiMock.removeWorkspaceMember.mockResolvedValue({ success: true });
    apiMock.workspaceMembers.mockRejectedValue(new Error('Network disconnect on refresh'));
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    const removeButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.includes('Remove'),
    )!;

    await act(async () => {
      removeButton.click();
    });

    expect(onMembersChanged).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Removal request sent, but confirmation is unavailable because refreshing members failed',
    );

    await view.cleanup();
  });

  it('member removal: displays error when delete call rejects', async () => {
    apiMock.removeWorkspaceMember.mockRejectedValue(new Error('Cannot remove the last owner'));

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [],
          },
          onMembersChanged: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    const removeButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.includes('Remove'),
    )!;

    await act(async () => {
      removeButton.click();
    });

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Cannot remove the last owner',
    );

    await view.cleanup();
  });
  it('invitation revocation: shows warning when refresh fails after delete', async () => {
    const sampleInvite = {
      id: 'inv-1',
      inviteeDid: 'did:plc:pending1',
      role: 'viewer' as const,
      createdAt: '2026-10-04T12:00:00.000Z',
    };
    apiMock.revokeWorkspaceInvitation.mockResolvedValue({ revoked: true, id: 'inv-1' });
    apiMock.workspaceMembers.mockRejectedValue(new Error('Network drop'));
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [sampleInvite],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    const revokeBtn = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Revoke'),
    )!;

    await act(async () => {
      revokeBtn.click();
      await Promise.resolve();
    });

    expect(onMembersChanged).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Revocation request sent, but confirmation is unavailable because refreshing members failed',
    );

    await view.cleanup();
  });

  it('invitation revocation: shows error when refreshed list still contains old invitation', async () => {
    const sampleInvite = {
      id: 'inv-1',
      inviteeDid: 'did:plc:pending1',
      role: 'viewer' as const,
      createdAt: '2026-10-04T12:00:00.000Z',
    };
    apiMock.revokeWorkspaceInvitation.mockResolvedValue({ revoked: true, id: 'inv-1' });
    apiMock.workspaceMembers.mockResolvedValue({
      members: baseMembers,
      invitations: [sampleInvite], // Still present!
    });
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [sampleInvite],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    const revokeBtn = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Revoke'),
    )!;

    await act(async () => {
      revokeBtn.click();
      await Promise.resolve();
    });

    expect(onMembersChanged).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Invitation revocation was not confirmed by the server.',
    );

    await view.cleanup();
  });

  it('invitation renewal: shows warning when refresh fails after renew', async () => {
    const sampleInvite = {
      id: 'inv-1',
      inviteeDid: 'did:plc:pending1',
      role: 'viewer' as const,
      status: 'expired' as const,
      createdAt: '2026-10-04T12:00:00.000Z',
    };
    apiMock.resendWorkspaceInvitation.mockResolvedValue({
      invitation: { ...sampleInvite, id: 'inv-2', status: 'pending' as const },
    });
    apiMock.workspaceMembers.mockRejectedValue(new Error('Network drop'));
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [sampleInvite],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    const renewBtn = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Renew invitation'),
    )!;

    await act(async () => {
      renewBtn.click();
      await Promise.resolve();
    });

    expect(onMembersChanged).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Renewal request sent, but confirmation is unavailable because refreshing members failed',
    );

    await view.cleanup();
  });

  it('invitation renewal: shows error when refreshed list does not confirm new ID or still has old ID', async () => {
    const sampleInvite = {
      id: 'inv-1',
      inviteeDid: 'did:plc:pending1',
      role: 'viewer' as const,
      status: 'expired' as const,
      createdAt: '2026-10-04T12:00:00.000Z',
    };
    apiMock.resendWorkspaceInvitation.mockResolvedValue({
      invitation: { ...sampleInvite, id: 'inv-2', status: 'pending' as const },
    });
    apiMock.workspaceMembers.mockResolvedValue({
      members: baseMembers,
      invitations: [sampleInvite], // Still has old inv-1, missing inv-2!
    });
    const onMembersChanged = vi.fn();

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceSettingsMembers, {
          canManage: true,
          members: {
            members: baseMembers,
            invitations: [sampleInvite],
          },
          onMembersChanged,
        }),
      );
      await Promise.resolve();
    });

    const renewBtn = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Renew invitation'),
    )!;

    await act(async () => {
      renewBtn.click();
      await Promise.resolve();
    });

    expect(onMembersChanged).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Invitation renewal was not confirmed by the server.',
    );

    await view.cleanup();
  });
});
