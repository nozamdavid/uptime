// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = vi.fn();

const apiMock = vi.hoisted(() => ({
  session: vi.fn(),
  monitors: vi.fn(),
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
    ProductSessionContext,
    SettingsPage: page('Settings'),
  };
});

describe('private section navigation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
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
});
