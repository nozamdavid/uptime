// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate }),
}));

const { AppLink } = await import('./app-link.js');

describe('AppLink', () => {
  afterEach(() => {
    navigate.mockReset();
    document.body.innerHTML = '';
  });

  it('keeps same-origin app links in the current document', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(AppLink, { href: '/settings' }, 'Settings')));
    const anchor = container.querySelector<HTMLAnchorElement>('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ href: '/settings' });
    expect(window.location.pathname).not.toBe('/settings');
    await act(async () => root.unmount());
  });

  it.each([
    ['modified click', { anchor: {}, event: { metaKey: true } }],
    ['new tab', { anchor: { target: '_blank' }, event: {} }],
    ['external URL', { anchor: { href: 'https://example.com' }, event: {} }],
  ])(
    'preserves browser behavior for %s',
    async (_label, { anchor: anchorProps, event: eventProps }) => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      await act(async () =>
        root.render(createElement(AppLink, { href: '/settings', ...anchorProps }, 'Settings')),
      );
      const anchor = container.querySelector<HTMLAnchorElement>('a')!;
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...eventProps,
      });
      let browserDefaultPreserved = false;
      container.addEventListener(
        'click',
        (click) => {
          browserDefaultPreserved = !click.defaultPrevented;
          // jsdom cannot follow links. Observe the app's decision before stopping navigation.
          click.preventDefault();
        },
        { once: true },
      );
      anchor.dispatchEvent(event);
      expect(browserDefaultPreserved).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    },
  );
});
