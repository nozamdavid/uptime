// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  workspaceBilling: vi.fn(),
  confirmMockBilling: vi.fn(),
  cancelMockBilling: vi.fn(),
}));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      workspaceBilling: apiMock.workspaceBilling,
      confirmMockBilling: apiMock.confirmMockBilling,
      cancelMockBilling: apiMock.cancelMockBilling,
    },
  };
});

const { MockBillingCheckoutPage } = await import('./mock-billing-checkout.js');

const validMockSession = {
  sessionId: 'mock_sess_123',
  nonce: 'nonce_abc',
  expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour in future
  tierId: 'pro',
  revision: 2,
  simulation: true,
  plan: {
    id: 'pro',
    revision: 2,
    name: 'Pro',
    description: 'Pro tier for growing teams',
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
    features: ['25 monitors', 'Up to 6 regions per check', 'Custom status domains'],
    active: true,
    published: true,
    preview: false,
  },
};

const mockBillingWithSession = {
  mode: 'mock',
  ready: true,
  setupReasons: [],
  simulation: true,
  legacyExempt: false,
  subscription: null,
  effectivePlan: {
    tierId: 'free',
    revision: 1,
    source: 'catalog' as const,
    active: true,
  },
  actions: {
    checkout: true,
    portal: false,
    cancel: false,
    resume: false,
    changePlan: true,
  },
  managementUrl: null,
  policy: {
    proration: true,
    gracePeriodDays: 3,
  },
  mockSession: validMockSession,
};

describe('MockBillingCheckoutPage', () => {
  let originalLocation: Location;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    assignMock = vi.fn();
    delete (window as any).location;
    window.location = {
      ...originalLocation,
      assign: assignMock,
      pathname: '/mock-billing/checkout',
      search: '?session_id=mock_sess_123',
    } as any;

    apiMock.workspaceBilling.mockResolvedValue(mockBillingWithSession);
  });

  afterEach(() => {
    (window as any).location = originalLocation;
    vi.restoreAllMocks();
  });

  it('rejects navigation when session_id query param is missing', async () => {
    window.location.search = '';
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Missing session_id in checkout URL.');
    expect(apiMock.workspaceBilling).not.toHaveBeenCalled();

    await view.cleanup();
  });

  it('renders network error when workspaceBilling API call fails, rather than derived no-session message', async () => {
    apiMock.workspaceBilling.mockRejectedValue(
      new Error('Gateway timeout fetching billing session'),
    );

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    const text = view.container.textContent ?? '';
    expect(text).toContain('Gateway timeout fetching billing session');
    expect(text).not.toContain('No active mock checkout session found');

    await view.cleanup();
  });

  it('rejects when query session_id does not match the active mock session', async () => {
    window.location.search = '?session_id=mismatched_id';
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain(
      'Mismatched or spoofed checkout session identifier.',
    );

    await view.cleanup();
  });

  it('rejects expired mock session', async () => {
    apiMock.workspaceBilling.mockResolvedValue({
      ...mockBillingWithSession,
      mockSession: {
        ...validMockSession,
        expiresAt: Math.floor(Date.now() / 1000) - 60, // expired 1 minute ago
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain(
      'This checkout session has expired. Please initiate checkout again from settings.',
    );

    await view.cleanup();
  });

  it('renders pinned plan snapshot details', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    const text = view.container.textContent ?? '';
    expect(text).toContain('Mock Billing Checkout');
    expect(text).toContain('Pro Plan');
    expect(text).toContain('REVISION 2');
    expect(text).toContain('$20');
    expect(text).toContain('25 monitors');
    expect(text).toContain('Up to 6 regions per check');
    expect(text).toContain('Confirm Purchase (Simulated)');
    expect(text).toContain('Simulate Payment Failure');
    expect(text).toContain('Cancel Checkout');

    await view.cleanup();
  });

  it('confirms purchase with explicit POST', async () => {
    apiMock.confirmMockBilling.mockResolvedValue({
      ...mockBillingWithSession,
      subscription: {
        status: 'active',
        tierId: 'pro',
        revision: 2,
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    const confirmBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Confirm Purchase (Simulated)'),
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiMock.confirmMockBilling).toHaveBeenCalledWith(
      'mock_sess_123',
      'nonce_abc',
      'purchase',
    );
    expect(view.container.textContent).toContain('Simulated purchase confirmed!');

    await view.cleanup();
  });

  it('synchronously guards against double-click concurrent submissions in handleOutcome', async () => {
    let resolveConfirm: (value: any) => void;
    const confirmPromise = new Promise((resolve) => {
      resolveConfirm = resolve;
    });
    apiMock.confirmMockBilling.mockReturnValue(confirmPromise);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    const confirmBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Confirm Purchase (Simulated)'),
    );
    expect(confirmBtn).toBeDefined();

    // Trigger two clicks synchronously before React re-render completes
    await act(async () => {
      confirmBtn!.click();
      confirmBtn!.click();
      await Promise.resolve();
    });

    // Synchronous guard must ensure confirmMockBilling was invoked only once
    expect(apiMock.confirmMockBilling).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConfirm!({
        ...mockBillingWithSession,
        subscription: { status: 'active', tierId: 'pro', revision: 2 },
      });
      await Promise.resolve();
    });

    await view.cleanup();
  });

  it('displays API mutation error when confirmMockBilling fails and keeps plan details interactive', async () => {
    apiMock.confirmMockBilling.mockRejectedValue(
      new Error('Checkout session already used or invalid nonce'),
    );

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    const confirmBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Confirm Purchase (Simulated)'),
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    // Error is rendered in the card alert
    expect(view.container.textContent).toContain('Checkout session already used or invalid nonce');
    // Plan card remains visible
    expect(view.container.textContent).toContain('Pro Plan');

    await view.cleanup();
  });

  it('simulates payment failure with explicit POST', async () => {
    apiMock.confirmMockBilling.mockResolvedValue({
      ...mockBillingWithSession,
      subscription: {
        status: 'past_due',
        tierId: 'pro',
        revision: 2,
        activationError: 'Payment simulation indicated insufficient funds',
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    const failBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Simulate Payment Failure'),
    );
    expect(failBtn).toBeDefined();

    await act(async () => {
      failBtn!.click();
      await Promise.resolve();
    });

    expect(apiMock.confirmMockBilling).toHaveBeenCalledWith(
      'mock_sess_123',
      'nonce_abc',
      'payment_failed',
    );
    expect(view.container.textContent).toContain('Simulated payment failure recorded.');

    await view.cleanup();
  });

  it('cancels mock checkout with explicit POST', async () => {
    apiMock.cancelMockBilling.mockResolvedValue({
      ...mockBillingWithSession,
      mockSession: null,
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MockBillingCheckoutPage));
      await Promise.resolve();
    });

    const cancelBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel Checkout'),
    );
    expect(cancelBtn).toBeDefined();

    await act(async () => {
      cancelBtn!.click();
      await Promise.resolve();
    });

    expect(apiMock.cancelMockBilling).toHaveBeenCalledWith('mock_sess_123', 'nonce_abc');
    expect(assignMock).toHaveBeenCalledWith('/settings#subscription');

    await view.cleanup();
  });
});
