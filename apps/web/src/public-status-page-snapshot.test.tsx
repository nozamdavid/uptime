// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  publicStatusPage: vi.fn(),
}));

vi.mock('./api.js', () => ({ api: apiMock }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const { PublicStatusPage } = await import('./status-pages.js');

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    latestObservationAt: '2026-09-20T11:59:30.000Z',
    staleAfterSeconds: 180,
    statusPage: {
      id: 'page-1',
      title: 'Snapshot status',
      publicSlug: 'snapshot-status',
      groups: [
        {
          id: 'group-1',
          title: 'Services',
          width: 'full',
          showBadges: true,
          monitors: [
            {
              id: 'monitor-1',
              name: 'Unavailable',
              url: 'https://down.example.test',
              publicSlug: 'unavailable',
              uptimePercentage: 0,
              status: 'down',
              configuredRegionCount: 1,
              affectedRegionIds: ['eu-west'],
              recoveryStatus: null,
              days: [],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function render(statusPageId: string) {
  const { container, root, cleanup } = createTestRoot();
  return {
    container,
    async rerender(nextStatusPageId: string) {
      await act(async () => {
        root.render(createElement(PublicStatusPage, { statusPageId: nextStatusPageId }));
        await Promise.resolve();
      });
    },
    async mount() {
      await act(async () => {
        root.render(createElement(PublicStatusPage, { statusPageId }));
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    cleanup,
  };
}

describe('public status page snapshots', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  beforeEach(() => {
    fetchMock.mockReset();
    apiMock.publicStatusPage.mockReset();
    vi.stubEnv('VITE_REPORTS_BASE_URL', 'https://reports.example.test');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    document.body.innerHTML = '';
  });

  it('renders the published snapshot and its freshness', async () => {
    const view = render('snapshot-status');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() });
    await view.mount();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://reports.example.test/public/status-pages/snapshot-status.json',
      { credentials: 'omit', cache: 'no-cache' },
    );
    expect(apiMock.publicStatusPage).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Snapshot status');
    expect(view.container.querySelector('.report-freshness--fresh')).not.toBeNull();
    // Existing response fields are preserved.
    expect(view.container.querySelector('.public-status-monitor__state')?.textContent).toBe(
      'Issues',
    );
    expect(view.container.querySelector('.status-problem-summary__list span')?.textContent).toBe(
      'Currently down',
    );
    await view.cleanup();
  });

  it('shows stale snapshots distinctly', async () => {
    const view = render('snapshot-status');
    const stale = snapshot({
      generatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      staleAfterSeconds: 180,
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => stale });
    await view.mount();

    expect(view.container.querySelector('.report-freshness--stale')).not.toBeNull();
    expect(view.container.textContent).toContain('Stale snapshot');
    await view.cleanup();
  });

  it('marks an open snapshot stale without enabling auto-refresh', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-20T12:00:00.000Z') });
    const view = render('snapshot-status');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        snapshot({
          generatedAt: '2026-09-20T12:00:00.000Z',
          staleAfterSeconds: 2,
        }),
    });
    await view.mount();

    expect(view.container.querySelector('.report-freshness--fresh')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(view.container.querySelector('.report-freshness--stale')).not.toBeNull();

    await view.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps aging the last report when an automatic refresh fails', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-20T12:00:00.000Z') });
    const view = render('snapshot-status');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          snapshot({
            generatedAt: '2026-09-20T12:00:00.000Z',
            staleAfterSeconds: 30,
          }),
      })
      .mockRejectedValueOnce(new Error('offline'));
    await view.mount();

    const toggle = view.container.querySelector<HTMLButtonElement>(
      '.public-status-page__refresh-toggle',
    )!;
    await act(async () => toggle.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(view.container.textContent).toContain('Snapshot status');
    expect(view.container.textContent).toContain('Latest refresh failed');
    expect(view.container.querySelector('.report-freshness--stale')).not.toBeNull();

    await view.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an automatic refresh to settle before scheduling another', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-20T12:00:00.000Z') });
    const view = render('snapshot-status');
    let finishRefresh: (() => void) | undefined;
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => snapshot() })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = () => resolve({ ok: true, status: 200, json: async () => snapshot() });
          }),
      )
      .mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() });
    await view.mount();

    const toggle = view.container.querySelector<HTMLButtonElement>(
      '.public-status-page__refresh-toggle',
    )!;
    await act(async () => toggle.click());
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => toggle.click());
    await act(async () => toggle.click());
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => finishRefresh?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await view.cleanup();
  });

  it('does not let a pending page request overwrite a newer page', async () => {
    const view = render('old-page');
    let finishOld: (() => void) | undefined;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('old-page')) {
        return new Promise((resolve) => {
          finishOld = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () =>
                snapshot({ statusPage: { ...snapshot().statusPage, title: 'Old page' } }),
            });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => snapshot({ statusPage: { ...snapshot().statusPage, title: 'New page' } }),
      });
    });
    await view.mount();
    await view.rerender('new-page');
    expect(view.container.textContent).toContain('New page');

    await act(async () => finishOld?.());
    expect(view.container.textContent).toContain('New page');
    expect(view.container.textContent).not.toContain('Old page');
    await view.cleanup();
  });

  it('shows a removed page as an error state', async () => {
    const view = render('deleted-page');
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await view.mount();

    expect(view.container.querySelector('.state--error')).not.toBeNull();
    expect(view.container.textContent).toContain('no longer published');
    await view.cleanup();
  });
});
