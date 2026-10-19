// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({ publicStatusPage: vi.fn() }));
vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api.js')>()),
  api: apiMock,
}));

const { PublicStatusPage } = await import('./status-pages.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('PublicStatusPage document metadata', () => {
  it('sets a noindex directive and page title, then removes the directive on unmount', async () => {
    const previousTitle = document.title;
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      publicSlug: null,
      groups: [],
    });
    const view = createTestRoot();

    await act(async () => {
      view.root.render(createElement(PublicStatusPage, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.title).toContain('Service status');
    expect(document.head.querySelector('meta[name="robots"]')?.content).toBe('noindex');

    await view.cleanup();

    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.title).toBe(previousTitle);
  });
});
