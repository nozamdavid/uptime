// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';
import type { ProductCatalog } from './api.js';

const apiMock = vi.hoisted(() => ({
  operatorPlans: vi.fn(),
  saveOperatorPlans: vi.fn(),
}));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      operatorPlans: apiMock.operatorPlans,
      saveOperatorPlans: apiMock.saveOperatorPlans,
    },
  };
});

const { OperatorTierCatalog } = await import('./operator-tier-catalog.js');

const initialCatalog: ProductCatalog = {
  revision: 1,
  preview: true,
  billingMode: 'mock',
  plans: [
    {
      id: 'free',
      revision: 1,
      name: 'Free',
      description: 'Essential monitoring.',
      price: { amount: 0, currency: 'usd', interval: 'month' },
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
        dailyRetentionDays: 30,
      },
      features: ['3 monitors', '300s check interval'],
      active: true,
      published: true,
      preview: true,
    },
    {
      id: 'pro',
      revision: 1,
      name: 'Pro',
      description: 'Advanced monitoring.',
      price: { amount: 1900, currency: 'usd', interval: 'month' },
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
        dailyRetentionDays: 30,
      },
      features: ['10 monitors', '300s check interval'],
      active: true,
      published: true,
      preview: true,
    },
  ],
  stripePriceIds: {},
};

describe('OperatorTierCatalog', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    apiMock.operatorPlans.mockResolvedValue(JSON.parse(JSON.stringify(initialCatalog)));
  });

  it('renders catalog editor with loaded plans and revision badge', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Product tier catalog');
    expect(view.container.textContent).toContain('REVISION 1 · NEXT: 2');
    expect(view.container.textContent).toContain('Configured Tiers (2)');
    expect(view.container.textContent).toContain('Free');
    expect(view.container.textContent).toContain('Pro');

    await view.cleanup();
  });

  it('requires a reason before saving', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    const submitBtn = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submitBtn.disabled).toBe(true);

    const reasonInput = view.container.querySelector<HTMLInputElement>('#catalog-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        reasonInput,
        'Update pro tier entitlements',
      );
      reasonInput.dispatchEvent(new Event('change', { bubbles: true }));
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(submitBtn.disabled).toBe(false);

    await view.cleanup();
  });

  it('saves catalog with incremented revision and derived features', async () => {
    apiMock.saveOperatorPlans.mockResolvedValue({
      ...initialCatalog,
      revision: 2,
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    const reasonInput = view.container.querySelector<HTMLInputElement>('#catalog-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        reasonInput,
        'Regular catalog revision check',
      );
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = view.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiMock.saveOperatorPlans).toHaveBeenCalledWith(
      1,
      'Regular catalog revision check',
      expect.objectContaining({
        revision: 2,
        plans: expect.arrayContaining([
          expect.objectContaining({ id: 'free', revision: 2 }),
          expect.objectContaining({ id: 'pro', revision: 2 }),
        ]),
      }),
    );

    expect(view.container.textContent).toContain(
      'Product tier catalog saved successfully as Revision 2.',
    );

    await view.cleanup();
  });

  it('enforces free tier price remains disabled and 0 cents', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    // Free tier is expanded by default
    const freePriceInput = view.container.querySelector<HTMLInputElement>('#plan-price-free')!;
    expect(freePriceInput).not.toBeNull();
    expect(freePriceInput.disabled).toBe(true);
    expect(freePriceInput.value).toBe('0');

    await view.cleanup();
  });

  it('allows adding a new custom tier', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    const addBtn = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Add custom tier'),
    )!;

    await act(async () => {
      addBtn.click();
    });

    expect(view.container.textContent).toContain('Configured Tiers (3)');
    expect(view.container.textContent).toContain('New Custom Tier');

    await view.cleanup();
  });

  it('handles 409 conflict and offers reload button', async () => {
    const conflictError = Object.assign(new Error('Revision conflict'), { status: 409 });
    apiMock.saveOperatorPlans.mockRejectedValueOnce(conflictError);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    const reasonInput = view.container.querySelector<HTMLInputElement>('#catalog-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        reasonInput,
        'Concurrent update attempt',
      );
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = view.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Catalog changed concurrently on the server.');
    const reloadBtn = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Reload latest server catalog'),
    );
    expect(reloadBtn).not.toBeUndefined();

    await act(async () => {
      reloadBtn?.click();
      await Promise.resolve();
    });

    expect(apiMock.operatorPlans).toHaveBeenCalledTimes(2);

    await view.cleanup();
  });

  it('rejects decimal input in numeric field and prevents API save call', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    const monitorsInput = view.container.querySelector<HTMLInputElement>('#plan-monitors-free')!;
    expect(monitorsInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        monitorsInput,
        '1.9',
      );
      monitorsInput.dispatchEvent(new Event('change', { bubbles: true }));
      monitorsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const reasonInput = view.container.querySelector<HTMLInputElement>('#catalog-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        reasonInput,
        'Decimal test',
      );
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = view.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiMock.saveOperatorPlans).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('cannot contain decimals or exponents');

    await view.cleanup();
  });

  it('rejects blank input in numeric field and prevents API save call', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    const monitorsInput = view.container.querySelector<HTMLInputElement>('#plan-monitors-free')!;
    expect(monitorsInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        monitorsInput,
        '',
      );
      monitorsInput.dispatchEvent(new Event('change', { bubbles: true }));
      monitorsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const reasonInput = view.container.querySelector<HTMLInputElement>('#catalog-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        reasonInput,
        'Blank test',
      );
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = view.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiMock.saveOperatorPlans).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('cannot be blank');

    await view.cleanup();
  });

  it('synchronously guards against double calls during saving', async () => {
    let resolveSave: ((value: any) => void) | undefined;
    const savePromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    apiMock.saveOperatorPlans.mockReturnValueOnce(savePromise);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorTierCatalog));
      await Promise.resolve();
    });

    const reasonInput = view.container.querySelector<HTMLInputElement>('#catalog-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        reasonInput,
        'Double click test',
      );
      reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = view.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(apiMock.saveOperatorPlans).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave!({ ...initialCatalog, revision: 2 });
      await Promise.resolve();
    });

    await view.cleanup();
  });
});
