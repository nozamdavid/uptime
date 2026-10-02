// @vitest-environment jsdom
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  startAtProto: vi.fn(),
  interestSession: vi.fn(),
  usage: vi.fn(),
  workspaceMembers: vi.fn(),
  exportWorkspace: vi.fn(),
  operatorWorkspaces: vi.fn(),
  operatorSlots: vi.fn(),
  operatorInterest: vi.fn(),
  updateOperatorSlots: vi.fn(),
  setSlotAdmission: vi.fn(),
  updateOperatorControls: vi.fn(),
  setWorkspaceState: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: apiMock }));

const {
  AuthPage,
  InterestForm,
  InterestSignupPage,
  LandingPage,
  OperatorPage,
  ProductSessionContext,
  SettingsPage,
} = await import('./product-shell.js');

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

beforeEach(() => {
  apiMock.operatorSlots.mockResolvedValue({
    maxWorkspaces: 1,
    configuredSlots: 2,
    assignedSlots: 1,
    availableSlots: 1,
    heldSlots: 0,
    quarantinedSlots: 0,
    slots: [],
  });
  apiMock.operatorInterest.mockResolvedValue({ total: 0, signups: [] });
});

describe('free product shell', () => {
  it('presents a modest identity-only interest signup', () => {
    const html = renderToStaticMarkup(createElement(LandingPage));
    expect(html).toContain('Simple uptime monitoring for indie developers and small teams.');
    expect(html).toContain('Join interest list');
    expect(html).toContain('No password, posts, follows, or write permission.');
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

  it('normalizes the interest handle and sends the exact return path', async () => {
    apiMock.startAtProto.mockResolvedValue({ authorizationUrl: '' });
    const view = createTestRoot();
    await act(async () => view.root.render(createElement(InterestForm)));
    const input = view.container.querySelector<HTMLInputElement>('#interest-handle')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '  indie.test ',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await act(async () => {
      view.container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(apiMock.startAtProto).toHaveBeenCalledWith('indie.test', '/?interest=joined');
    await view.cleanup();
  });

  it('keeps signup as an interest form without workspace creation language', () => {
    const html = renderToStaticMarkup(createElement(InterestSignupPage));
    expect(html).toContain('Join the interest list.');
    expect(html).not.toContain('workspace automatically');
  });

  it('confirms the landing return only when the server has a signup', async () => {
    window.history.pushState({}, '', '/?interest=joined');
    apiMock.interestSession.mockResolvedValue({ signup: null });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(LandingPage));
      await Promise.resolve();
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'couldn’t confirm',
    );
    expect(view.container.querySelector('#interest-handle')).not.toBeNull();
    await view.cleanup();
    window.history.pushState({}, '', '/');
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
      budget: {
        baseUsd: 5,
        ceilingUsd: 20,
        externalMonthlyCostUsd: 3,
        forecastUsd: 11,
        admissionOpen: true,
      },
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
    apiMock.operatorInterest.mockResolvedValue({
      total: 1,
      signups: [
        {
          did: 'did:plc:interested',
          handle: 'interested.test',
          createdAt: '2026-10-02T10:00:00.000Z',
          updatedAt: '2026-10-02T10:00:00.000Z',
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
    expect(view.container.textContent).toContain('Forecast $11.00/mo');
    expect(view.container.textContent).toContain('12 rows read');
    expect(view.container.textContent).toContain('8 rows written');
    expect(view.container.textContent).toContain('did:plc:owner');
    expect(view.container.textContent).toContain('Admission open');
    expect(view.container.textContent).toContain('Interest list · 1');
    expect(view.container.textContent).toContain('@interested.test');
    expect(view.container.textContent).toContain('did:plc:interested');
    await view.cleanup();
  });

  it('offers suspend, resume, and activate controls for actionable workspace states', async () => {
    apiMock.setWorkspaceState.mockResolvedValue({ workspace: {} });
    apiMock.operatorSlots
      .mockResolvedValueOnce({
        maxWorkspaces: 1,
        configuredSlots: 2,
        assignedSlots: 1,
        availableSlots: 1,
        heldSlots: 0,
        quarantinedSlots: 0,
        slots: [],
      })
      .mockResolvedValueOnce({
        maxWorkspaces: 1,
        configuredSlots: 2,
        assignedSlots: 2,
        availableSlots: 0,
        heldSlots: 0,
        quarantinedSlots: 0,
        slots: [],
      });
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
          id: 'waiting-for-capacity',
          name: 'Waiting',
          ownerDid: 'did:waiting',
          ownerHandle: 'waiting.test',
          state: 'waiting_for_capacity',
          monitorCount: 0,
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
        {
          id: 'suspended',
          name: 'Suspended',
          ownerDid: 'did:suspended',
          ownerHandle: 'suspended.test',
          state: 'suspended',
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
    const buttons = [...view.container.querySelectorAll('.operator-row button')];
    expect(buttons.length).toBe(3);
    expect(buttons.map((button) => button.textContent)).toEqual(['Suspend', 'Activate', 'Resume']);
    await act(async () => {
      buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiMock.setWorkspaceState).toHaveBeenCalledWith(
      'waiting-for-capacity',
      'active',
      'Operator restored',
    );
    expect(buttons[1]!.closest('.operator-row')?.textContent).toContain('active');
    expect(apiMock.operatorSlots).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain(
      '0 available · 2 assigned · 0 held · 0 quarantined',
    );
    await act(async () => {
      buttons[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiMock.setWorkspaceState).toHaveBeenCalledWith(
      'suspended',
      'active',
      'Operator restored',
    );
    expect(buttons[2]!.closest('.operator-row')?.textContent).toContain('active');
    await view.cleanup();
  });

  it('shows an error when an operator state change fails', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'waiting-for-capacity',
          name: 'Waiting',
          ownerDid: 'did:waiting',
          ownerHandle: 'waiting.test',
          state: 'waiting_for_capacity',
          monitorCount: 0,
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
      ],
    });
    apiMock.setWorkspaceState.mockRejectedValue(new Error('Capacity is still unavailable'));
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
    await act(async () => {
      view.container
        .querySelector('.operator-row button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Capacity is still unavailable',
    );
    await view.cleanup();
  });

  it('prevents duplicate workspace actions while activation is pending', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'waiting-for-capacity',
          name: 'Waiting',
          ownerDid: 'did:waiting',
          ownerHandle: 'waiting.test',
          state: 'waiting_for_capacity',
          monitorCount: 0,
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
      ],
    });
    let resolve!: (value: { workspace: object }) => void;
    apiMock.setWorkspaceState.mockReturnValue(new Promise((complete) => (resolve = complete)));
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
    const button = view.container.querySelector('.operator-row button') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(apiMock.setWorkspaceState).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    await act(async () => resolve({ workspace: {} }));
    await view.cleanup();
  });

  it('updates the capacity limit and holds or reopens unused slots', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [],
    });
    const inventory = {
      maxWorkspaces: 1,
      configuredSlots: 3,
      assignedSlots: 1,
      availableSlots: 1,
      heldSlots: 1,
      quarantinedSlots: 1,
      slots: [
        {
          bindingName: 'DB_AVAILABLE',
          databaseId: 'db-available',
          status: 'available' as const,
          admissionEnabled: true,
          workspaceId: null,
          ownerHandle: null,
        },
        {
          bindingName: 'DB_HELD',
          databaseId: 'db-held',
          status: 'available' as const,
          admissionEnabled: false,
          workspaceId: null,
          ownerHandle: null,
        },
        {
          bindingName: 'DB_ASSIGNED',
          databaseId: 'db-assigned',
          status: 'assigned' as const,
          admissionEnabled: true,
          workspaceId: 'workspace-1',
          ownerHandle: 'owner.test',
        },
        {
          bindingName: 'DB_DELETING',
          databaseId: 'db-deleting',
          status: 'deleting' as const,
          admissionEnabled: false,
          workspaceId: 'workspace-2',
          ownerHandle: 'other.test',
        },
      ],
    };
    apiMock.operatorSlots.mockResolvedValue(inventory);
    apiMock.updateOperatorSlots.mockResolvedValue({ ...inventory, maxWorkspaces: 2 });
    apiMock.setSlotAdmission
      .mockResolvedValueOnce({ ...inventory, availableSlots: 0, heldSlots: 2 })
      .mockResolvedValueOnce({ ...inventory, availableSlots: 1, heldSlots: 1 });
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
    expect(view.container.textContent).toContain(
      '1 available · 1 assigned · 1 held · 1 quarantined',
    );
    expect(view.container.textContent).toContain('Assigned to owner.test');
    expect(view.container.textContent).toContain('Deleting');
    expect(view.container.textContent).toContain('Hold');
    expect(view.container.textContent).toContain('Make available');
    const limit = view.container.querySelector<HTMLInputElement>('input[name="maxWorkspaces"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(limit, '2');
    limit.dispatchEvent(new Event('change', { bubbles: true }));
    await act(async () => {
      limit
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(apiMock.updateOperatorSlots).toHaveBeenCalledWith(2);
    const slotButtons = [
      ...view.container.querySelectorAll('.operator-budget .operator-row button'),
    ].filter((button) => ['Hold', 'Make available'].includes(button.textContent?.trim() ?? ''));
    await act(async () => {
      slotButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiMock.setSlotAdmission).toHaveBeenCalledWith('DB_AVAILABLE', false);
    await act(async () => {
      slotButtons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiMock.setSlotAdmission).toHaveBeenCalledWith('DB_HELD', true);
    await view.cleanup();
  });

  it('shows slot control errors and prevents repeated clicks while pending', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [],
    });
    apiMock.operatorSlots.mockResolvedValue({
      maxWorkspaces: 1,
      configuredSlots: 1,
      assignedSlots: 0,
      availableSlots: 1,
      heldSlots: 0,
      quarantinedSlots: 0,
      slots: [
        {
          bindingName: 'DB_AVAILABLE',
          databaseId: 'db-available',
          status: 'available',
          admissionEnabled: true,
          workspaceId: null,
          ownerHandle: null,
        },
      ],
    });
    let reject!: (reason: Error) => void;
    apiMock.setSlotAdmission.mockReturnValue(new Promise((_, fail) => (reject = fail)));
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
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Hold',
    )!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(apiMock.setSlotAdmission).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('slot unavailable')));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'slot unavailable',
    );
    await view.cleanup();
  });
});
