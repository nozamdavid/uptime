// @vitest-environment jsdom
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';
import { regionById } from '@uptime/regions';

const apiMock = vi.hoisted(() => ({
  startAtProto: vi.fn(),
  interestSession: vi.fn(),
  usage: vi.fn(),
  workspaceMembers: vi.fn(),
  workspaceEntitlements: vi.fn(),
  operatorPlans: vi.fn(),
  saveOperatorPlans: vi.fn(),
  exportWorkspace: vi.fn(),
  operatorWorkspaces: vi.fn(),
  operatorSlots: vi.fn(),
  operatorInterest: vi.fn(),
  updateOperatorSlots: vi.fn(),
  setSlotAdmission: vi.fn(),
  updateOperatorControls: vi.fn(),
  setWorkspaceState: vi.fn(),
  updateOperatorWorkspaceLimits: vi.fn(),
  operatorHealth: vi.fn(),
  operatorScheduling: vi.fn(),
  operatorWorkspaceScheduling: vi.fn(),
  operatorWorkspaceLimitsPreview: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
  resendWorkspaceInvitation: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  inviteWorkspaceMember: vi.fn(),
  acceptWorkspaceInvitation: vi.fn(),
}));
vi.mock('./api.js', () => ({
  api: apiMock,
  isImportedWorkspaceKind: (value: unknown) =>
    value === 'staging_import' || value === 'legacy_import',
}));

const {
  AuthPage,
  InterestForm,
  InterestSignupPage,
  LandingPage,
  OperatorPage,
  OperatorWorkspaceEditPage,
  ProductSessionContext,
  SettingsPage,
} = await import('./product-shell.js');

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

beforeEach(() => {
  apiMock.workspaceEntitlements.mockResolvedValue({
    tierId: 'free',
    revision: 1,
    generation: 1,
    legacyExempt: false,
    entitlements: {
      monitors: 3,
      regions: 3,
      allowedRegionIds: ['us-east', 'eu-west', 'asia'],
      seats: 3,
      statusPages: 1,
      notificationDestinations: 3,
      customDomains: 0,
      intervalSeconds: 300,
      rawRetentionHours: 24,
      dailyRetentionDays: 90,
    },
    overrides: null,
    usage: {
      monitors: 1,
      statusPages: 0,
      notificationServices: 0,
    },
    downgrade: null,
  });
  apiMock.operatorPlans.mockResolvedValue({
    revision: 1,
    preview: true,
    billingMode: 'mock',
    plans: [],
  });
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
  apiMock.operatorHealth.mockResolvedValue({
    generatedAt: '2026-10-04T00:00:00.000Z',
    scheduling: {
      paused: false,
      manual: [],
      automatic: null,
      inFlightMayComplete: true,
      resumeConditions: [],
    },
    budget: { forecastUsd: 10, ceilingUsd: 20 },
    dispatch: {
      oldestPendingAt: null,
      pendingAgeSeconds: 0,
      failedCount: 0,
      truncated: false,
      deadLetterCount: null,
    },
    workspaces: [],
    nextCursor: null,
  });
  apiMock.operatorWorkspaceLimitsPreview.mockResolvedValue({
    capacity: {
      safe: true,
      intervalSeconds: 300,
      headroomPercent: 20,
      grant: { monitors: 3, regionalTasks: 9 },
      actual: { monitors: 1, regionalTasks: 3 },
      effectiveCaps: {
        monitorClaimsPerMinute: 60,
        regionalTasksPerMinute: 180,
        monitorsPerPeriod: 300,
        regionalTasksPerPeriod: 900,
      },
      utilization: {
        monitorClaims: 0.05,
        regionalTasks: 0.05,
      },
      actualUtilization: {
        monitorClaims: 0.02,
        regionalTasks: 0.02,
      },
      fleet: {
        dispatchesPerMinute: 10,
        configuredWorkspaces: 2,
        safe: true,
      },
      warnings: [],
    },
  });
});

describe('free product shell', () => {
  it('presents a modest identity-only interest signup', () => {
    const html = renderToStaticMarkup(createElement(LandingPage));
    expect(html).toContain('Simple uptime monitoring');
    expect(html).toContain('I&#x27;m interested!');
    expect(html).not.toContain('Free early access soon');
    expect(html).not.toContain('What we store');
    expect(html).toContain('href="https://bsky.app/profile/noz.am" target="_blank"');
    expect(html).toContain('href="/operator"');
    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('Only identification is requested');
    expect(html).not.toContain('Sign-in tokens are encrypted');
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
    expect(apiMock.updateOperatorWorkspaceLimits).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it('gates the direct workspace editor and handles a missing workspace', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: false } },
          createElement(OperatorWorkspaceEditPage, { workspaceId: 'missing' }),
        ),
      );
    });
    expect(view.container.textContent).toContain('Operator access required.');
    expect(apiMock.operatorWorkspaces).not.toHaveBeenCalled();

    apiMock.operatorWorkspaces.mockResolvedValue({
      workspaces: [],
      availableRegions: [],
      budget: { ceilingUsd: 20 },
    });
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: true } },
          createElement(OperatorWorkspaceEditPage, { workspaceId: 'missing' }),
        ),
      );
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('Workspace not found.');
    expect(view.container.querySelector('a[href="/operator"]')).not.toBeNull();
    await view.cleanup();
  });

  it('keeps member and export controls owner-only', async () => {
    apiMock.usage.mockResolvedValue({
      usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
      limits: {
        monitors: 3,
        regions: 3,
        allowedRegionIds: ['us-east', 'eu-west', 'asia'],
        intervalSeconds: 300,
        statusPages: 1,
        notificationServices: 3,
        rawRetentionDays: 1,
        dailyRetentionDays: 90,
      },
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
    expect(view.container.querySelector('.settings-facts dt')?.textContent).toBe('Signed in as');
    expect(view.container.querySelector('.settings-usage-grid')?.textContent).toContain('Monitors1 / 3');
    expect(view.container.textContent).toContain(
      'These limits are shared by everyone in the workspace. Each monitor can use up to 3 regions.',
    );
    expect(view.container.textContent).toContain(
      'US East (N. Virginia), Europe West (Ireland), Asia Southeast (Singapore)',
    );
    await view.cleanup();
  });

  it('shows imported staging usage without free quotas or deletion', async () => {
    apiMock.usage.mockResolvedValue({
      usage: { monitors: 107, statusPages: 1, notificationServices: 2 },
      limits: null,
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
              role: 'owner',
              user: { did: 'did:plc:owner', handle: 'owner.test' },
              workspace: {
                id: 'workspace-imported',
                name: 'Imported staging',
                plan: 'free',
                kind: 'staging_import',
                state: 'active',
              },
            },
          },
          createElement(SettingsPage),
        ),
      );
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('107 monitors');
    expect(view.container.textContent).toContain('1 status pages');
    expect(view.container.textContent).toContain('existing staging checks and history');
    expect(view.container.textContent).not.toContain('Free plan');
    expect(view.container.textContent).not.toContain(' / 3 monitors');
    expect(view.container.textContent).not.toContain('Delete workspace');
    await view.cleanup();
  });

  it('shows production legacy usage without free quotas or deletion', async () => {
    apiMock.usage.mockResolvedValue({
      usage: { monitors: 107, statusPages: 1, notificationServices: 2 },
      limits: null,
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
              role: 'owner',
              user: { did: 'did:plc:owner', handle: 'owner.test' },
              workspace: {
                id: 'workspace-legacy',
                name: 'Imported production',
                plan: 'free',
                kind: 'legacy_import',
                state: 'active',
              },
            },
          },
          createElement(SettingsPage),
        ),
      );
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('Imported production monitors');
    expect(view.container.textContent).toContain('107 monitors');
    expect(view.container.textContent).toContain('existing production checks and history');
    expect(view.container.textContent).not.toContain('Free plan');
    expect(view.container.textContent).not.toContain(' / 3 monitors');
    expect(view.container.textContent).not.toContain('Delete workspace');
    await view.cleanup();
  });

  it.each([null, undefined])(
    'keeps total forecasts and current PostgreSQL metrics without provider or historical counts (%s)',
    async (missing) => {
      apiMock.operatorWorkspaces.mockResolvedValue({
        availableRegions: [],
        budget: {
          ceilingUsd: 20,
          baseUsd: missing,
          forecastUsd: missing,
          admissionOpen: false,
        },
        workspaces: [
          {
            id: 'native-workspace',
            name: 'Native PostgreSQL',
            ownerDid: 'did:plc:owner',
            ownerHandle: 'owner.test',
            state: 'active',
            monitorCount: 2,
            limits: null,
            lastSeenAt: null,
            rowsRead: null,
            rowsWritten: null,
            storageBytes: null,
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
      const budget = view.container.querySelector('.operator-budget')!;
      expect(budget.textContent).toContain('Forecast: Unknown / unavailable');
      expect(budget.textContent).not.toContain('Base:');
      expect(budget.textContent).not.toContain('Cloudflare:');
      expect(budget.textContent).not.toContain('$0.00');
      const current = view.container.querySelector('.operator-row > div > small')!;
      expect(current.textContent).toContain('rows read unavailable');
      expect(current.textContent).toContain('rows written unavailable');
      expect(current.textContent).toContain('storage unavailable');
      await view.cleanup();
    },
  );

  it('renders measured zero costs and metrics as zero', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [],
      budget: { ceilingUsd: 20, baseUsd: 0, forecastUsd: 0 },
      workspaces: [
        {
          id: 'zero',
          name: 'Measured',
          ownerDid: 'did:plc:owner',
          ownerHandle: 'owner.test',
          state: 'active',
          monitorCount: 0,
          limits: null,
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
    const budget = view.container.querySelector('.operator-budget')!;
    expect(budget.textContent).toContain('Forecast $0.00/mo');
    expect(budget.textContent).not.toContain('Base:');
    expect(budget.textContent).not.toContain('Cloudflare:');
    expect(view.container.querySelector('.operator-row > div > small')?.textContent).toContain(
      '0 rows read · 0 rows written · 0 MiB',
    );
    expect(view.container.querySelector('.operator-historical-d1')).toBeNull();
    await view.cleanup();
  });

  it('shows operator budget controls and workspace usage', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [regionById['us-east'], regionById['eu-west'], regionById.asia],
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
          limits: {
            monitors: 3,
            regions: 3,
            allowedRegionIds: ['us-east', 'eu-west', 'asia'],
            intervalSeconds: 300,
            statusPages: 1,
            notificationServices: 3,
            rawRetentionDays: 1,
            dailyRetentionDays: 90,
          },
          rowsRead: 12,
          rowsWritten: 8,
          storageBytes: 2048,
          lastSeenAt: '2026-10-02T10:00:00.000Z',
        },
        {
          id: 'workspace-imported',
          name: 'Imported staging',
          ownerDid: 'did:plc:legacy',
          ownerHandle: 'legacy.test',
          state: 'active',
          monitorCount: 107,
          limits: null,
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
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
    expect(view.container.textContent).toContain(
      "Hosted limit editing is unavailable for this workspace's import or provisioning state.",
    );
    expect(view.container.querySelector('.operator-limits')).toBeNull();
    expect(view.container.querySelectorAll('.operator-workspaces .operator-limits__form')).toHaveLength(
      0,
    );
    expect(
      view.container.querySelector('.operator-row a[href="/operator/workspaces/workspace-1"]'),
    ).not.toBeNull();
    expect(view.container.textContent).toContain('Limit: 3 saved monitors');
    expect(view.container.textContent).toContain('up to 3 regions per monitor');
    expect(view.container.textContent).toContain('Edit workspace');
    expect(view.container.textContent).toContain('Admission open');
    expect(view.container.textContent).toContain('Interest list · 1');
    expect(view.container.textContent).toContain('@interested.test');
    expect(view.container.textContent).toContain('did:plc:interested');
    await view.cleanup();
  });

  it('validates operator quota bounds and region count before saving', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [regionById['us-east'], regionById['eu-west'], regionById.asia],
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Workspace',
          ownerDid: 'did:plc:owner',
          ownerHandle: 'owner.test',
          state: 'active',
          monitorCount: 2,
          limits: {
            monitors: 3,
            regions: 3,
            allowedRegionIds: ['us-east', 'eu-west', 'asia'],
            intervalSeconds: 300,
            statusPages: 1,
            notificationServices: 3,
            rawRetentionDays: 1,
            dailyRetentionDays: 90,
          },
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
          createElement(OperatorWorkspaceEditPage, { workspaceId: 'workspace-1' }),
        ),
      );
      await Promise.resolve();
    });
    const monitorInput = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Saved monitor limit for Workspace"]',
    )!;
    const regionInput = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Regions per monitor for Workspace"]',
    )!;
    expect(monitorInput.min).toBe('0');
    expect(monitorInput.max).toBe('1000');
    expect(regionInput.min).toBe('1');
    expect(regionInput.max).toBe('9');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      monitorInput,
      '1001',
    );
    await act(async () => {
      monitorInput.dispatchEvent(new Event('input', { bubbles: true }));
      view.container
        .querySelector('.operator-limits__form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'whole number from 0 to 1000',
    );
    expect(monitorInput.getAttribute('aria-invalid')).toBe('true');
    expect(monitorInput.getAttribute('aria-describedby')).toBe(
      view.container.querySelector('[role="alert"]')?.id,
    );
    expect(apiMock.updateOperatorWorkspaceLimits).not.toHaveBeenCalled();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        monitorInput,
        '3',
      );
      monitorInput.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        regionInput,
        '4',
      );
      regionInput.dispatchEvent(new Event('input', { bubbles: true }));
      view.container
        .querySelector('.operator-limits__form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'cannot exceed the number of allowed regions',
    );
    expect(apiMock.updateOperatorWorkspaceLimits).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it('saves operator workspace quotas with pending and success states', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [regionById['us-east'], regionById['eu-west'], regionById.asia],
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Workspace',
          ownerDid: 'did:plc:owner',
          ownerHandle: 'owner.test',
          state: 'active',
          monitorCount: 2,
          limits: {
            monitors: 3,
            regions: 3,
            allowedRegionIds: ['us-east', 'eu-west', 'asia'],
            intervalSeconds: 300,
            statusPages: 1,
            notificationServices: 3,
            rawRetentionDays: 1,
            dailyRetentionDays: 90,
          },
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
      ],
    });
    const updatedLimits = {
      monitors: 5,
      regions: 2,
      allowedRegionIds: ['us-east', 'eu-west'] as const,
      intervalSeconds: 300,
      statusPages: 1,
      notificationServices: 3,
      rawRetentionDays: 1,
      dailyRetentionDays: 90,
    };
    let resolve!: (value: { limits: typeof updatedLimits }) => void;
    apiMock.updateOperatorWorkspaceLimits.mockReturnValue(
      new Promise((complete) => (resolve = complete)),
    );
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: true } },
          createElement(OperatorWorkspaceEditPage, { workspaceId: 'workspace-1' }),
        ),
      );
      await Promise.resolve();
    });
    const monitorInput = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Saved monitor limit for Workspace"]',
    )!;
    const regionInput = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Regions per monitor for Workspace"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        monitorInput,
        '5',
      );
      monitorInput.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        regionInput,
        '2',
      );
      regionInput.dispatchEvent(new Event('input', { bubbles: true }));
      const asia = [
        ...view.container.querySelectorAll<HTMLInputElement>('.operator-limits__regions input'),
      ].find((input) => input.value === 'asia')!;
      asia.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    const save = [
      ...view.container.querySelectorAll<HTMLButtonElement>('.operator-limits__form button'),
    ][0]!;
    await act(async () => {
      view.container
        .querySelector('.operator-limits__form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(apiMock.updateOperatorWorkspaceLimits).toHaveBeenCalledWith('workspace-1', {
      monitors: 5,
      regions: 2,
      allowedRegionIds: ['us-east', 'eu-west'],
    });
    expect(save.disabled).toBe(true);
    expect(save.textContent).toBe('Saving…');
    await act(async () => resolve({ limits: updatedLimits }));
    expect(view.container.querySelector('.operator-limits [role="status"]')?.textContent).toBe(
      'Workspace limits saved.',
    );
    expect(view.container.querySelector('h1')?.textContent).toBe('Workspace');
    await view.cleanup();
  });

  it('shows server errors when a workspace quota change is rejected', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [regionById['us-east']],
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Workspace',
          ownerDid: 'did:plc:owner',
          ownerHandle: 'owner.test',
          state: 'active',
          monitorCount: 3,
          limits: {
            monitors: 3,
            regions: 1,
            allowedRegionIds: ['us-east'],
            intervalSeconds: 300,
            statusPages: 1,
            notificationServices: 3,
            rawRetentionDays: 1,
            dailyRetentionDays: 90,
          },
          rowsRead: 0,
          rowsWritten: 0,
          storageBytes: 0,
          lastSeenAt: null,
        },
      ],
    });
    apiMock.updateOperatorWorkspaceLimits.mockRejectedValue(
      new Error('Cannot lower the monitor limit while saved monitors exceed it.'),
    );
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: true } },
          createElement(OperatorWorkspaceEditPage, { workspaceId: 'workspace-1' }),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    await act(async () => {
      view.container
        .querySelector('.operator-limits__form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(view.container.querySelector('.operator-limits [role="alert"]')?.textContent).toContain(
      'Cannot lower the monitor limit',
    );
    await view.cleanup();
  });

  it('retries the operator workspace load after an initial error', async () => {
    apiMock.operatorWorkspaces
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValueOnce({
        availableRegions: [],
        budget: { baseUsd: 5, ceilingUsd: 20 },
        workspaces: [],
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
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('temporary network error');
    const retry = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Retry loading workspaces',
    )!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.operatorWorkspaces).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain('temporary network error');
    expect(view.container.textContent).not.toContain('Loading workspaces…');
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
      availableRegions: [],
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'active',
          name: 'Active',
          ownerDid: 'did:active',
          ownerHandle: 'active.test',
          state: 'active',
          monitorCount: 0,
          limits: null,
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
          limits: null,
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
          limits: null,
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
          limits: null,
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
      availableRegions: [],
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'waiting-for-capacity',
          name: 'Waiting',
          ownerDid: 'did:waiting',
          ownerHandle: 'waiting.test',
          state: 'waiting_for_capacity',
          monitorCount: 0,
          limits: null,
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
    expect(
      view.container.querySelector('.operator-workspaces .operator-row [role="alert"]')
        ?.textContent,
    ).toContain('Capacity is still unavailable');
    expect(
      view.container.querySelector('.operator-workspaces .operator-row')?.textContent,
    ).toContain('waiting_for_capacity');
    await view.cleanup();
  });

  it('prevents duplicate workspace actions while activation is pending', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [],
      budget: { baseUsd: 5, ceilingUsd: 20 },
      workspaces: [
        {
          id: 'waiting-for-capacity',
          name: 'Waiting',
          ownerDid: 'did:waiting',
          ownerHandle: 'waiting.test',
          state: 'waiting_for_capacity',
          monitorCount: 0,
          limits: null,
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
    expect(button.closest('.operator-row')?.querySelector('[role="status"]')?.textContent).toBe(
      'Activating workspace…',
    );
    await act(async () => resolve({ workspace: {} }));
    expect(button.closest('.operator-row')?.querySelector('[role="status"]')).toBeNull();
    await view.cleanup();
  });

  it('includes the signed-in operator interest signup in slot assignment', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [],
      budget: { ceilingUsd: 20 },
      workspaces: [],
    });
    apiMock.operatorInterest.mockResolvedValue({
      total: 1,
      signups: [{ did: 'did:plc:operator', handle: 'noz.am', createdAt: '2026-10-05T00:00:00Z' }],
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
          status: 'available',
          workspaceId: null,
          admissionEnabled: true,
        },
      ],
    });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(
          ProductSessionContext.Provider,
          { value: { isOperator: true, user: { did: 'did:plc:operator', handle: 'noz.am' } } },
          createElement(OperatorPage),
        ),
      );
      await Promise.resolve();
    });
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>('.slot-assignment button.ut-select')!.click(),
    );
    const option = view.container.querySelector('.slot-assignment [role="option"]');
    expect(option?.textContent).toBe('@noz.am');
    await view.cleanup();
  });

  it('updates the capacity limit and holds or reopens unused slots', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [],
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
      ...view.container.querySelectorAll('.operator-budget .operator-slot-card button'),
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

  it('shows quarantined slots without admission or assignment actions', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [],
      budget: { ceilingUsd: 20 },
      workspaces: [],
    });
    apiMock.operatorSlots.mockResolvedValue({
      maxWorkspaces: 1,
      configuredSlots: 1,
      assignedSlots: 0,
      availableSlots: 0,
      heldSlots: 0,
      quarantinedSlots: 1,
      slots: [
        {
          bindingName: 'QUARANTINED',
          databaseId: 'source',
          status: 'quarantined',
          admissionEnabled: true,
          workspaceId: null,
          ownerHandle: null,
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
    const slot = view.container.querySelector('.operator-slot-card')!;
    expect(slot.textContent).toContain('Quarantined');
    expect(slot.querySelector('button')).toBeNull();
    expect(slot.querySelector('.slot-assignment')).toBeNull();
    await view.cleanup();
  });

  it('shows slot control errors and prevents repeated clicks while pending', async () => {
    apiMock.operatorWorkspaces.mockResolvedValue({
      availableRegions: [],
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
