// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = vi.fn();

const apiMock = vi.hoisted(() => ({
  session: vi.fn(),
  monitors: vi.fn(),
  workspaceEntitlements: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('./api.js', () => ({ api: apiMock }));
vi.mock('./monitor-detail.js', () => ({
  MonitorDetail: () => createElement('div', null, 'Monitor detail'),
}));
vi.mock('./monitor-form.js', () => ({
  MonitorForm: () => createElement('div', null, 'Monitor form'),
}));
vi.mock('./monitor-list.js', () => ({
  MonitorList: () => createElement('div', null, 'Monitor list'),
}));
vi.mock('./notifications.js', () => ({
  NotificationsPage: () => createElement('div', null, 'Notifications page'),
}));
vi.mock('./status-pages.js', () => ({
  PublicStatusPage: () => createElement('div', null, 'Public status page'),
  StatusPageEditor: () => createElement('div', null, 'Status page editor'),
  StatusPagesIndex: () => createElement('div', null, 'Status pages'),
}));
vi.mock('./workspace-state.js', () => ({
  WorkspaceState: () => createElement('div', null, 'Workspace state'),
}));
vi.mock('./product-shell.js', async () => {
  const { createContext } = await import('react');
  const ProductSessionContext = createContext(null);
  const page = (label: string) => () => createElement('div', null, label);
  return {
    AuthPage: page('Login'),
    InterestSignupPage: page('Signup'),
    LandingPage: page('Landing'),
    OperatorPage: page('Operator'),
    OperatorWorkspaceEditPage: ({ workspaceId }: { workspaceId: string }) =>
      createElement('div', null, `Editing ${workspaceId}`),
    ProductSessionContext,
    SettingsPage: page('Settings'),
  };
});

describe('private section navigation', () => {
  beforeEach(() => {
    apiMock.workspaceEntitlements.mockResolvedValue({ tierId: 'free', legacyExempt: false });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it.each([
    ['free', 'Free'],
    ['pro', 'Pro'],
    [null, 'Imported'],
  ])('shows the effective %s tier and no admin footer', async (tierId, label) => {
    window.history.replaceState({}, '', '/app');
    apiMock.workspaceEntitlements.mockResolvedValue({
      tierId,
      legacyExempt: tierId === null,
    });
    apiMock.session.mockResolvedValue({
      user: { did: 'did:plc:test', handle: 'test.example' },
      workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
      workspaces: [{ id: 'workspace-1', name: 'Test', state: 'active', role: 'owner' }],
      role: 'owner',
    });
    apiMock.monitors.mockResolvedValue({ monitors: [] });

    const { router } = await import('./main.js');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.ut-nav__workspace-label')?.textContent).toBe(
      `Workspace (${label})`,
    );
    expect(container.querySelector('#workspace-select')).not.toBeNull();
    expect(container.querySelector('.admin-main footer')).toBeNull();
    expect(container.textContent).not.toContain('Free monitoring');
    expect(apiMock.workspaceEntitlements).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('shows no tier while entitlements load or after they fail', async () => {
    window.history.replaceState({}, '', '/app');
    let rejectEntitlements!: (reason: Error) => void;
    apiMock.workspaceEntitlements.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectEntitlements = reject;
      }),
    );
    apiMock.session.mockResolvedValue({
      user: { did: 'did:plc:test', handle: 'test.example' },
      workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
      workspaces: [{ id: 'workspace-1', name: 'Test', state: 'active', role: 'owner' }],
      role: 'owner',
    });
    apiMock.monitors.mockResolvedValue({ monitors: [] });

    const { router } = await import('./main.js');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
      await Promise.resolve();
    });

    const workspaceLabel = () => container.querySelector('.ut-nav__workspace-label')?.textContent;
    expect(workspaceLabel()).toBe('Workspace');
    await act(async () => {
      rejectEntitlements(new Error('Unavailable'));
      await Promise.resolve();
    });
    expect(workspaceLabel()).toBe('Workspace');

    await act(async () => root.unmount());
  });

  it('navigates five sections in one session and marks nested routes active', async () => {
    window.history.replaceState({}, '', '/app');
    apiMock.session.mockResolvedValue({
      user: { did: 'did:plc:test', handle: 'test.example' },
      workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
      workspaces: [],
      isOperator: true,
      role: 'owner',
    });
    apiMock.monitors.mockResolvedValue({ monitors: [] });
    apiMock.signOut.mockResolvedValue(undefined);

    const { router } = await import('./main.js');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const link = (label: string) =>
      [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Admin sections"] a')].find(
        (candidate) => candidate.textContent?.trim() === label,
      )!;
    const click = async (label: string) => {
      await act(async () => {
        link(label).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(link(label).getAttribute('aria-current')).toBe('page');
    };

    await click('Monitors');
    await click('Status pages');
    await click('Notifications');
    await click('Settings');
    await click('Operator');
    expect(container.querySelector('.ut-nav__operator + .ut-nav__bottom')).not.toBeNull();
    await act(async () => {
      await router.navigate({
        to: '/operator/workspaces/$workspaceId',
        params: { workspaceId: 'workspace-2' },
      });
    });
    expect(container.textContent).toContain('Editing workspace-2');
    expect(link('Operator').getAttribute('aria-current')).toBe('page');
    await act(async () => {
      await router.navigate({ to: '/monitors/$monitorId', params: { monitorId: 'monitor-1' } });
    });
    expect(link('Monitors').getAttribute('aria-current')).toBe('page');
    expect(apiMock.session).toHaveBeenCalledTimes(1);

    window.sessionStorage.setItem('uptime.workspaceId', 'workspace-1');
    await act(async () => {
      window.dispatchEvent(new Event('uptime:session-expired'));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Login');
    expect(window.sessionStorage.getItem('uptime.workspaceId')).toBeNull();

    await act(async () => {
      await router.navigate({ to: '/' });
      await router.navigate({ to: '/app' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.session).toHaveBeenCalledTimes(2);
    window.sessionStorage.setItem('uptime.workspaceId', 'workspace-1');
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Sign out')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Login');
    expect(window.sessionStorage.getItem('uptime.workspaceId')).toBeNull();

    await act(async () => root.unmount());
  });

  it('controls mobile nav with toggle and Escape, and keeps monitor counts accurate without guessed 0', async () => {
    window.history.replaceState({}, '', '/app');
    apiMock.session.mockResolvedValue({
      user: { did: 'did:plc:test', handle: 'test.example' },
      workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
      workspaces: [],
      isOperator: false,
      role: 'owner',
    });
    apiMock.monitors.mockResolvedValue({
      monitors: [
        {
          monitor: { id: 'm1', name: 'API', url: 'https://api.example.com' },
          status: 'down',
        },
        {
          monitor: { id: 'm2', name: 'Web', url: 'https://web.example.com' },
          status: 'up',
        },
      ],
    });

    const { router } = await import('./main.js');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Overview renders exactly one primary Add monitor button and quiet refresh button
    const addButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (btn) => btn.textContent?.trim() === 'Add monitor',
    );
    expect(addButtons).toHaveLength(1);
    expect(addButtons[0]!.classList.contains('button--primary')).toBe(true);

    const refreshButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (btn) => btn.textContent?.trim() === 'Refresh',
    );
    expect(refreshButtons).toHaveLength(1);
    expect(refreshButtons[0]!.classList.contains('button--quiet')).toBe(true);

    const toggle = container.querySelector<HTMLButtonElement>('.admin-mobile-bar__toggle')!;
    const nav = container.querySelector<HTMLElement>('nav.ut-nav')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(nav.classList.contains('is-open')).toBe(false);

    // Open mobile nav via toggle
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(nav.classList.contains('is-open')).toBe(true);

    // Close via Escape
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(nav.classList.contains('is-open')).toBe(false);

    // Down count is accurate (1 down)
    const monitorItem = container.querySelector('.ut-nav__items li')!;
    expect(monitorItem.textContent).toContain('1 down');

    // Counts update when monitors change
    apiMock.monitors.mockResolvedValue({
      monitors: [
        {
          monitor: { id: 'm1', name: 'API', url: 'https://api.example.com' },
          status: 'up',
        },
      ],
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('uptime:monitors-changed'));
      await Promise.resolve();
    });
    expect(monitorItem.textContent).toContain('1');
    expect(monitorItem.textContent).not.toContain('down');

    // When monitor list is empty, never display guessed 0
    apiMock.monitors.mockResolvedValue({ monitors: [] });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('uptime:monitors-changed'));
      await Promise.resolve();
    });
    expect(monitorItem.querySelector('.ut-count')).toBeNull();

    // In empty state, exactly one primary Add monitor CTA remains
    const emptyAddButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (btn) => btn.textContent?.trim() === 'Add monitor',
    );
    expect(emptyAddButtons).toHaveLength(1);
    expect(emptyAddButtons[0]!.classList.contains('button--primary')).toBe(true);

    await act(async () => root.unmount());
  });
});
