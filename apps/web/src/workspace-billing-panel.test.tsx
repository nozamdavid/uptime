// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  workspaceBilling: vi.fn(),
  workspaceEntitlements: vi.fn(),
  publicPlans: vi.fn(),
  usage: vi.fn(),
  startBillingCheckout: vi.fn(),
  createBillingPortal: vi.fn(),
  cancelBillingSubscription: vi.fn(),
  resumeBillingSubscription: vi.fn(),
  changeMockBillingPlan: vi.fn(),
}));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      workspaceBilling: apiMock.workspaceBilling,
      workspaceEntitlements: apiMock.workspaceEntitlements,
      publicPlans: apiMock.publicPlans,
      usage: apiMock.usage,
      startBillingCheckout: apiMock.startBillingCheckout,
      createBillingPortal: apiMock.createBillingPortal,
      cancelBillingSubscription: apiMock.cancelBillingSubscription,
      resumeBillingSubscription: apiMock.resumeBillingSubscription,
      changeMockBillingPlan: apiMock.changeMockBillingPlan,
    },
  };
});

const { WorkspaceBillingPanel, formatUnixSeconds } = await import('./workspace-billing-panel.js');

const mockCatalog = {
  revision: 1,
  preview: false,
  billingMode: 'mock' as const,
  capabilities: {
    checkout: true,
    customDomains: 'supported',
    notificationProviders: ['webhook', 'slack'],
  },
  plans: [
    {
      id: 'free',
      revision: 1,
      name: 'Free',
      description: 'Free tier',
      price: { amount: 0, currency: 'usd' as const, interval: 'month' as const },
      entitlements: {
        monitors: 3,
        regions: 3,
        allowedRegionIds: ['us-east', 'eu-west', 'asia'] as any,
        seats: 3,
        statusPages: 1,
        notificationDestinations: 3,
        customDomains: 0,
        intervalSeconds: 300 as const,
        rawRetentionHours: 24 as const,
        dailyRetentionDays: 90 as const,
      },
      features: ['Basic'],
      active: true,
      published: true,
      preview: false,
    },
    {
      id: 'pro',
      revision: 2,
      name: 'Pro',
      description: 'Pro tier',
      price: { amount: 2000, currency: 'usd' as const, interval: 'month' as const },
      entitlements: {
        monitors: 25,
        regions: 6,
        allowedRegionIds: ['us-east', 'eu-west', 'asia'] as any,
        seats: 10,
        statusPages: 5,
        notificationDestinations: 10,
        customDomains: 3,
        intervalSeconds: 300 as const,
        rawRetentionHours: 24 as const,
        dailyRetentionDays: 90 as const,
      },
      features: ['Pro features'],
      active: true,
      published: true,
      preview: false,
    },
  ],
};

const mockBillingData = {
  mode: 'mock',
  ready: true,
  setupReasons: [],
  simulation: true,
  legacyExempt: false,
  subscription: {
    status: 'active',
    tierId: 'pro',
    revision: 2,
    currentPeriodEnd: 1775000000,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    pendingReconciliation: false,
    activationError: null,
    plan: {
      id: 'pro',
      revision: 2,
      name: 'Pro',
      description: 'Pro tier',
      price: { amount: 2000, currency: 'usd' as const, interval: 'month' as const },
      entitlements: mockCatalog.plans[1]!.entitlements,
      features: ['Pro features'],
      active: true,
      published: true,
      preview: false,
    },
  },
  effectivePlan: {
    tierId: 'pro',
    revision: 2,
    source: 'subscription' as const,
    active: true,
  },
  actions: {
    checkout: true,
    portal: true,
    cancel: true,
    resume: false,
    changePlan: true,
  },
  managementUrl: null,
  policy: {
    proration: true,
    gracePeriodDays: 3,
  },
  mockSession: null,
};

const mockEntitlementsData = {
  tierId: 'pro',
  revision: 2,
  generation: 1,
  legacyExempt: false,
  entitlements: {
    monitors: 25,
    regions: 6,
    allowedRegionIds: ['us-east', 'eu-west', 'asia'] as any,
    seats: 10,
    statusPages: 5,
    notificationDestinations: 10,
    customDomains: 3,
    intervalSeconds: 300 as const,
    rawRetentionHours: 24 as const,
    dailyRetentionDays: 90 as const,
  },
  overrides: null,
  usage: {
    monitors: 5,
    statusPages: 1,
    notificationDestinations: 2,
    notificationServices: 2,
    seats: 2,
  },
};

describe('WorkspaceBillingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.workspaceBilling.mockResolvedValue(mockBillingData);
    apiMock.workspaceEntitlements.mockResolvedValue(mockEntitlementsData);
    apiMock.publicPlans.mockResolvedValue(mockCatalog);
    apiMock.usage.mockResolvedValue({
      usage: { monitors: 5, statusPages: 1, notificationServices: 2 },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats unix timestamp in seconds correctly', () => {
    expect(formatUnixSeconds(null)).toBe('—');
    expect(formatUnixSeconds(undefined)).toBe('—');
    expect(formatUnixSeconds(0)).toBe('—');
    expect(formatUnixSeconds(1700000000)).toContain('2023');
  });

  it('renders owner view with plan name, revision badge, entitlements, and region labels', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    const text = view.container.textContent ?? '';
    expect(text).toContain('Pro');
    expect(text).toContain('Plan revision2');
    expect(text).toContain('Simulation mode');
    expect(text).toContain('Monitors5 / 25');
    expect(text).toContain(
      'These limits are shared by everyone in the workspace. Each monitor can use up to 6 regions.',
    );
    expect(text).toContain('Allowed regions');
    expect(text).toContain('Manage Payment Method & Invoices');
    expect(text).toContain('Cancel Subscription');

    await view.cleanup();
  });

  it('renders member read-only notice and hides management controls', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: false }));
      await Promise.resolve();
    });

    const text = view.container.textContent ?? '';
    expect(text).toContain('Only the workspace owner can manage subscriptions');
    expect(text).not.toContain('Manage Payment Method & Invoices');
    expect(text).not.toContain('Cancel Subscription');
    expect(text).not.toContain('Upgrade Workspace Plan');

    await view.cleanup();
  });

  it('renders imported workspace banner and omits billing actions', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceBillingPanel, {
          canManage: true,
          importedWorkspace: true,
          importedKind: 'staging_import',
        }),
      );
      await Promise.resolve();
    });

    const text = view.container.textContent ?? '';
    expect(text).toContain('Imported staging monitors');
    expect(text).toContain('This workspace keeps the existing staging checks and history.');
    expect(text).not.toContain('Manage Payment Method & Invoices');
    expect(text).not.toContain('Upgrade Workspace Plan');

    await view.cleanup();
  });

  it('initiates mock checkout and navigates to returned url', async () => {
    const originalLocation = window.location;
    const assignMock = vi.fn();
    delete (window as any).location;
    window.location = {
      ...originalLocation,
      origin: 'https://example.com',
      assign: assignMock,
    } as any;

    apiMock.startBillingCheckout.mockResolvedValue({
      sessionId: 'sess_123',
      url: 'https://example.com/mock-billing/checkout?session_id=sess_123',
      mode: 'mock',
      simulation: true,
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    const checkoutBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Proceed to checkout'),
    );
    expect(checkoutBtn).toBeDefined();

    await act(async () => {
      checkoutBtn!.click();
      await Promise.resolve();
    });

    expect(apiMock.startBillingCheckout).toHaveBeenCalledWith('pro', 2);
    expect(assignMock).toHaveBeenCalledWith(
      'https://example.com/mock-billing/checkout?session_id=sess_123',
    );

    (window as any).location = originalLocation;
    await view.cleanup();
  });

  it('switches plan in mock simulation mode', async () => {
    apiMock.changeMockBillingPlan.mockResolvedValue({
      ...mockBillingData,
      subscription: {
        ...mockBillingData.subscription,
        tierId: 'free',
        revision: 1,
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    const switchBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Switch to Free'),
    );
    expect(switchBtn).toBeDefined();

    await act(async () => {
      switchBtn!.click();
      await Promise.resolve();
    });

    expect(apiMock.changeMockBillingPlan).toHaveBeenCalledWith('free', 1);
    expect(view.container.textContent).toContain(
      'Plan switched to FREE (Revision 1) in simulation.',
    );

    await view.cleanup();
  });

  it('handles cancellation confirmation flow', async () => {
    apiMock.cancelBillingSubscription.mockResolvedValue({
      ...mockBillingData,
      subscription: {
        ...mockBillingData.subscription,
        cancelAtPeriodEnd: true,
      },
      actions: {
        ...mockBillingData.actions,
        cancel: false,
        resume: true,
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    const cancelBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel Subscription'),
    );
    expect(cancelBtn).toBeDefined();

    await act(async () => {
      cancelBtn!.click();
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain(
      'Are you sure you want to cancel your subscription?',
    );

    const confirmBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Yes, Cancel at End of Period'),
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiMock.cancelBillingSubscription).toHaveBeenCalled();
    expect(view.container.textContent).toContain(
      'Subscription set to cancel at the end of the billing period.',
    );

    await view.cleanup();
  });

  it('displays activation error and pending reconciliation badges', async () => {
    apiMock.workspaceBilling.mockResolvedValue({
      ...mockBillingData,
      subscription: {
        ...mockBillingData.subscription,
        activationError: 'Payment card was declined',
        pendingReconciliation: true,
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Payment card was declined');
    expect(view.container.textContent).toContain(
      'Subscription changes are pending reconciliation with the payment provider.',
    );

    await view.cleanup();
  });

  it('prevents redirect to unauthorized or malicious URLs on checkout', async () => {
    apiMock.startBillingCheckout.mockResolvedValue({
      sessionId: 'sess_123',
      url: 'https://evil-phishing.com/checkout',
      mode: 'stripe',
      simulation: false,
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    const checkoutBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Proceed to checkout'),
    );
    expect(checkoutBtn).toBeDefined();

    await act(async () => {
      checkoutBtn!.click();
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain(
      'Received an unsafe or unauthorized checkout redirect URL.',
    );

    await view.cleanup();
  });

  it('synchronously guards against double-click on checkout', async () => {
    const originalLocation = window.location;
    const assignMock = vi.fn();
    delete (window as any).location;
    window.location = {
      ...originalLocation,
      origin: 'https://example.com',
      assign: assignMock,
    } as any;

    let resolveCheckout: (value: any) => void;
    const checkoutPromise = new Promise((resolve) => {
      resolveCheckout = resolve;
    });
    apiMock.startBillingCheckout.mockReturnValue(checkoutPromise);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    const checkoutBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Proceed to checkout'),
    );
    expect(checkoutBtn).toBeDefined();

    // Trigger two clicks synchronously
    await act(async () => {
      checkoutBtn!.click();
      checkoutBtn!.click();
      await Promise.resolve();
    });

    expect(apiMock.startBillingCheckout).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCheckout!({
        sessionId: 'sess_1',
        url: 'https://example.com/mock-billing/checkout?session_id=sess_1',
        mode: 'mock',
        simulation: true,
      });
      await Promise.resolve();
    });

    (window as any).location = originalLocation;
    await view.cleanup();
  });

  it('disables action buttons when subscription has pendingReconciliation', async () => {
    apiMock.workspaceBilling.mockResolvedValue({
      ...mockBillingData,
      subscription: {
        ...mockBillingData.subscription,
        pendingReconciliation: true,
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(WorkspaceBillingPanel, { canManage: true }));
      await Promise.resolve();
    });

    const checkoutBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Proceed to checkout'),
    );
    expect(checkoutBtn).toBeDefined();
    expect(checkoutBtn!.disabled).toBe(true);

    const portalBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Manage Payment Method & Invoices'),
    );
    expect(portalBtn).toBeDefined();
    expect(portalBtn!.disabled).toBe(true);

    await view.cleanup();
  });
});
