// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  publicPlans: vi.fn(),
  session: vi.fn(),
  productWorkspaceId: vi.fn(),
}));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      publicPlans: apiMock.publicPlans,
      session: apiMock.session,
    },
    productWorkspaceId: apiMock.productWorkspaceId,
  };
});

const { PricingPage } = await import('./pricing.js');

const mockPlans = [
  {
    id: 'free',
    revision: 1,
    name: 'Free',
    description: 'Essential monitoring for personal projects and small sites.',
    price: { amount: 0, currency: 'usd' as const, interval: 'month' as const },
    entitlements: {
      monitors: 3,
      regions: 3,
      allowedRegionIds: ['us-east', 'eu-west', 'asia'] as any,
      seats: 3,
      statusPages: 1,
      notificationDestinations: 3,
      customDomains: 0,
      intervalSeconds: 300,
      rawRetentionHours: 24,
      dailyRetentionDays: 90,
    },
    features: [
      '3 monitors',
      'Up to 3 regions per monitor',
      '3 workspace seats',
      '1 public status page',
      '3 notification destinations',
      '300s check interval',
      '24h raw / 30d daily history',
      'Telegram & Discord alerts',
    ],
    active: true,
    published: true,
    preview: true,
  },
  {
    id: 'pro',
    revision: 1,
    name: 'Pro',
    description: 'Advanced monitoring and alerting for growing production apps.',
    price: { amount: 1900, currency: 'usd' as const, interval: 'month' as const },
    entitlements: {
      monitors: 10,
      regions: 3,
      allowedRegionIds: ['us-east', 'eu-west', 'asia'] as any,
      seats: 5,
      statusPages: 3,
      notificationDestinations: 5,
      customDomains: 1,
      intervalSeconds: 300,
      rawRetentionHours: 24,
      dailyRetentionDays: 90,
    },
    features: [
      '10 monitors',
      'Up to 3 regions per monitor',
      '5 workspace seats',
      '3 public status pages',
      '5 notification destinations',
      '1 custom status domain',
      '300s check interval',
      '24h raw / 30d daily history',
      'Telegram & Discord alerts',
    ],
    active: true,
    published: true,
    preview: true,
  },
  {
    id: 'team',
    revision: 1,
    name: 'Team',
    description: 'Expanded capacity and collaborative controls for engineering teams.',
    price: { amount: 4900, currency: 'usd' as const, interval: 'month' as const },
    entitlements: {
      monitors: 25,
      regions: 3,
      allowedRegionIds: ['us-east', 'eu-west', 'asia'] as any,
      seats: 15,
      statusPages: 10,
      notificationDestinations: 10,
      customDomains: 3,
      intervalSeconds: 300,
      rawRetentionHours: 24,
      dailyRetentionDays: 90,
    },
    features: [
      '25 monitors',
      'Up to 3 regions per monitor',
      '15 workspace seats',
      '10 public status pages',
      '10 notification destinations',
      '3 custom status domains',
      '300s check interval',
      '24h raw / 30d daily history',
      'Telegram & Discord alerts',
    ],
    active: true,
    published: true,
    preview: true,
  },
];

describe('PricingPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    apiMock.productWorkspaceId.mockReturnValue(null);
    apiMock.session.mockResolvedValue({ user: null, workspace: null });
    apiMock.publicPlans.mockResolvedValue({
      revision: 1,
      preview: true,
      billingMode: 'mock',
      plans: mockPlans,
      capabilities: {
        checkout: false,
        portal: false,
      },
    });
  });

  it('renders all public plan cards with formatted prices', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Simple, transparent monitoring.');
    expect(view.container.textContent).toContain('Free');
    expect(view.container.textContent).toContain('$0');
    // Paid tiers show placeholders so their real details are not in the DOM.
    expect(view.container.textContent).not.toContain('$19 / month');
    expect(view.container.textContent).not.toContain('$49 / month');
    expect(view.container.textContent).toContain('$00 / month');

    await view.cleanup();
  });

  it('does not display unproven POPULAR badge or claim instant alerting', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    expect(view.container.querySelector('.pricing-card__badge')).toBeNull();
    expect(view.container.textContent).not.toContain('POPULAR');
    expect(view.container.textContent).not.toContain('instant alerting');
    expect(view.container.textContent).toContain(
      'Multi-region easy to use monitoring, alerts and 90-day history',
    );

    await view.cleanup();
  });

  it('shows no pricing banner or comparison table', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    expect(view.container.querySelector('.pricing-banner')).toBeNull();
    expect(view.container.textContent).not.toContain('DRAFT PRICING');
    expect(view.container.querySelector('.pricing-table')).toBeNull();

    await view.cleanup();
  });

  it('blurs and disables only the paid tiers', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    const blurred = (plan: string) =>
      view.container.querySelector(
        `.pricing-card[data-plan="${plan}"] .pricing-card__body--blurred`,
      );
    expect(blurred('free')).toBeNull();
    expect(blurred('pro')?.hasAttribute('inert')).toBe(true);
    expect(blurred('team')?.getAttribute('aria-hidden')).toBe('true');

    await view.cleanup();
  });

  it('clears stored workspaceId and resets isAuthenticated when session fails', async () => {
    sessionStorage.setItem('uptime.workspaceId', 'ws-test-saved');
    apiMock.productWorkspaceId.mockReturnValue('ws-test-saved');
    apiMock.session.mockRejectedValueOnce(new Error('Session expired'));

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sessionStorage.getItem('uptime.workspaceId')).toBeNull();
    const proCta = view.container.querySelector<HTMLAnchorElement>(
      '.pricing-card[data-plan="pro"] .pricing-card__cta',
    );
    expect(proCta?.getAttribute('href')).toBe('/signup');

    await view.cleanup();
  });

  it('indicates billing setup pending when capabilities.checkout is false', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    const pendingNotices = view.container.querySelectorAll('.pricing-card__setup-notice');
    expect(pendingNotices.length).toBe(3);
    expect(pendingNotices[0]?.textContent).toBe('Billing setup pending');

    await view.cleanup();
  });

  it('routes unauthenticated users to /signup', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    const freeCta = view.container.querySelector<HTMLAnchorElement>(
      '.pricing-card[data-plan="free"] .pricing-card__cta',
    );
    expect(freeCta?.getAttribute('href')).toBe('/signup');
    expect(freeCta?.textContent).toBe('Get started free');

    const proCta = view.container.querySelector<HTMLAnchorElement>(
      '.pricing-card[data-plan="pro"] .pricing-card__cta',
    );
    expect(proCta?.getAttribute('href')).toBe('/signup');
    expect(proCta?.textContent).toBe('Join interest list');

    await view.cleanup();
  });

  it('routes authenticated users to /settings#subscription', async () => {
    apiMock.session.mockResolvedValue({
      user: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
      workspace: { id: 'ws_123', name: 'Alice Team' },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
      await Promise.resolve();
    });

    const proCta = view.container.querySelector<HTMLAnchorElement>(
      '.pricing-card[data-plan="pro"] .pricing-card__cta',
    );
    expect(proCta?.getAttribute('href')).toBe('/settings#subscription');
    expect(proCta?.textContent).toBe('Manage subscription');

    await view.cleanup();
  });

  it('handles error state and provides retry button', async () => {
    apiMock.publicPlans.mockRejectedValueOnce(new Error('Network error loading plans'));

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Network error loading plans');
    const retryBtn = view.container.querySelector<HTMLButtonElement>('.state--error button');
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      retryBtn?.click();
      await Promise.resolve();
    });

    expect(apiMock.publicPlans).toHaveBeenCalledTimes(2);

    await view.cleanup();
  });

  it('renders plans safely when capabilities object is omitted', async () => {
    apiMock.publicPlans.mockResolvedValueOnce({
      revision: 1,
      preview: false,
      billingMode: 'mock',
      plans: mockPlans,
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(PricingPage));
      await Promise.resolve();
    });

    const cards = view.container.querySelectorAll('.pricing-card');
    expect(cards.length).toBe(3);

    await view.cleanup();
  });
});
