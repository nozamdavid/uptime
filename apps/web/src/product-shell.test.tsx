// @vitest-environment jsdom
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  startAtProto: vi.fn(),
  usage: vi.fn(),
  workspaceMembers: vi.fn(),
  exportWorkspace: vi.fn(),
  operatorWorkspaces: vi.fn(),
  updateOperatorControls: vi.fn(),
  setWorkspaceState: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: apiMock }));

const { AuthPage, LandingPage, OperatorPage, ProductSessionContext, SettingsPage } =
  await import('./product-shell.js');

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('free product shell', () => {
  it('states the free limits on the public landing page', () => {
    const html = renderToStaticMarkup(createElement(LandingPage));
    expect(html).toContain('3 monitors');
    expect(html).toContain('5 minute checks');
    expect(html).toContain('up to 3 regions');
    expect(html).toContain('24h detailed history');
    expect(html).toContain('30d daily history');
    expect(html).toContain('1 status page');
    expect(html).toContain('https://bsky.app/signup');
  });

  it('starts an AT Protocol authorization request with the entered handle', async () => {
    apiMock.startAtProto.mockResolvedValue({ authorizationUrl: '' });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(AuthPage, { mode: 'signup', onAuthenticated: vi.fn() }));
    });
    const input = view.container.querySelector<HTMLInputElement>('#atproto-handle')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '  alice.bsky.social ',
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await act(async () => {
      view.container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.startAtProto).toHaveBeenCalledWith('alice.bsky.social');
    await view.cleanup();
  });

  it('gates operator workspaces for founder accounts', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: false } },
          createElement(OperatorPage),
        ),
      );
    });
    expect(view.container.textContent).toContain('Operator access required.');
    expect(apiMock.operatorWorkspaces).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it('keeps member and export controls owner-only', async () => {
    apiMock.usage.mockResolvedValue({
      usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
      limits: { monitors: 3, statusPages: 1, notificationServices: 3 },
      budget: { baseUsd: 5, ceilingUsd: 20 },
    });
    apiMock.workspaceMembers.mockResolvedValue({
      members: [{ did: 'did:plc:owner', handle: 'owner.test', role: 'owner' }],
      invitations: [],
    });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          {
            value: {
              role: 'viewer',
              user: { did: 'did:plc:viewer', handle: 'viewer.test' },
              workspace: { id: 'workspace-1', name: 'Workspace', plan: 'free', state: 'active' },
            },
          },
          createElement(SettingsPage),
        ),
      );
      await Promise.resolve();
    });
    expect(view.container.textContent).not.toContain('Invite member');
    expect(view.container.textContent).not.toContain('Download export');
    expect(view.container.textContent).not.toContain('Delete workspace');
    await view.cleanup();
  });

  it('shows operator budget controls and workspace usage', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      budget: { baseUsd: 5, ceilingUsd: 20, externalMonthlyCostUsd: 3, admissionOpen: true },
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Workspace',
          ownerDid: 'did:plc:owner',
          ownerHandle: 'owner.test',
          state: 'active',
          monitorCount: 2,
          rowsRead: 12,
          rowsWritten: 8,
          storageBytes: 2048,
          lastSeenAt: '2026-10-02T10:00:00.000Z',
        },
      ],
    });
    apiMock.updateOperatorControls.mockResolvedValue({
      budget: { baseUsd: 5, ceilingUsd: 20, externalMonthlyCostUsd: 4, admissionOpen: false },
    });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: true } },
          createElement(OperatorPage),
        ),
      );
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('Forecast $8.00/mo');
    expect(view.container.textContent).toContain('12 rows read');
    expect(view.container.textContent).toContain('8 rows written');
    expect(view.container.textContent).toContain('did:plc:owner');
    expect(view.container.textContent).toContain('Admission open');
    await view.cleanup();
  });

  it('only offers suspension controls for active and suspended workspaces', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'active',
          name: 'Active',
          ownerDid: 'did:active',
          ownerHandle: 'active.test',
          state: 'active',
          monitorCount: 0,
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
        {
          id: 'waiting',
          name: 'Waiting',
          ownerDid: 'did:waiting',
          ownerHandle: 'waiting.test',
          state: 'waiting',
          monitorCount: 0,
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
        {
          id: 'deleted',
          name: 'Deleted',
          ownerDid: 'did:deleted',
          ownerHandle: 'deleted.test',
          state: 'deleted',
          monitorCount: 0,
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
      ],
    });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: true } },
          createElement(OperatorPage),
        ),
      );
      await Promise.resolve();
    });
    expect(view.container.querySelectorAll('button').length).toBe(2);
    await view.cleanup();
  });
});
