// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  publicMonitor: vi.fn(),
  monitor: vi.fn(),
  observations: vi.fn(),
  dnsDiagnostics: vi.fn(),
  deleteMonitor: vi.fn(),
  updateMonitor: vi.fn(),
}));
const chartRenderCounter = vi.hoisted(() => ({ count: 0 }));

vi.mock('./api.js', () => ({
  api: apiMock,
  RequestError: class RequestError extends Error {},
}));
vi.mock('recharts', async () => {
  const { createElement: element } = await import('react');
  return {
    ResponsiveContainer: ({ children }: { children?: ReactNode }) => element('div', null, children),
    LineChart: ({ children }: { children?: ReactNode }) => {
      chartRenderCounter.count += 1;
      return element('div', null, children);
    },
    Line: () => element('div'),
    XAxis: () => element('div'),
    YAxis: () => element('div'),
    Tooltip: () => element('div'),
    Bar: () => element('div'),
    BarChart: ({ children }: { children?: ReactNode }) => element('div', null, children),
  };
});

document.body.innerHTML = '<div id="root"></div>';
const { MonitorDetail } = await import('./monitor-detail.js');

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    latestObservationAt: '2026-09-20T11:59:30.000Z',
    staleAfterSeconds: 180,
    summary: {
      monitor: {
        id: 'monitor-1',
        name: 'Snapshot monitor',
        url: 'https://snapshot.example.test/health',
        regionIds: ['us-east'],
        intervalSeconds: 300,
        timeoutMs: 10_000,
        enabled: true,
        isPublic: true,
        publicSlug: 'snapshot-monitor',
        createdAt: '2026-08-30T09:00:00.000Z',
        updatedAt: '2026-08-30T09:00:00.000Z',
      },
      status: 'up',
      latestByRegion: { 'us-east': null },
      targetChecksPerDay: 288,
    },
    uptime: { uptimePercentage: 99.5, status: 'up', days: [] },
    latency: { points: [], stats: [] },
    ...overrides,
  };
}

function render(monitorId: string, statusPageId?: string) {
  const { container, root, cleanup } = createTestRoot();
  return {
    container,
    root,
    async mount() {
      await act(async () => {
        root.render(
          createElement(MonitorDetail, {
            monitorId,
            publicMode: true,
            ...(statusPageId ? { statusPageId } : {}),
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async update(nextMonitorId: string, nextStatusPageId?: string) {
      await act(async () => {
        root.render(
          createElement(MonitorDetail, {
            monitorId: nextMonitorId,
            publicMode: true,
            ...(nextStatusPageId ? { statusPageId: nextStatusPageId } : {}),
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    cleanup,
  };
}

const originalReportsBase = process.env.VITE_REPORTS_BASE_URL;

describe('public monitor snapshot rendering', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  beforeEach(() => {
    fetchMock.mockReset();
    apiMock.publicMonitor.mockReset();
    vi.stubEnv('VITE_REPORTS_BASE_URL', 'https://reports.example.test');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (originalReportsBase !== undefined) {
      process.env.VITE_REPORTS_BASE_URL = originalReportsBase;
    }
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState({}, '', '/');
  });

  it('loads the public JSON snapshot instead of the authenticated API', async () => {
    const view = render('snapshot-monitor');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() });
    await view.mount();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://reports.example.test/public/monitors/snapshot-monitor.json',
      { credentials: 'omit', cache: 'no-cache', signal: expect.any(AbortSignal) },
    );
    expect(apiMock.publicMonitor).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Snapshot monitor');
    expect(view.container.querySelector('.report-freshness--fresh')).not.toBeNull();
    await view.cleanup();
  });

  it('updates report age without rerendering the monitor latency chart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T10:00:00.000Z'));
    chartRenderCounter.count = 0;
    const view = render('snapshot-monitor');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        snapshot({
          generatedAt: '2026-09-27T10:00:00.000Z',
          staleAfterSeconds: 600,
        }),
    });
    await view.mount();

    const chartRenders = chartRenderCounter.count;
    expect(chartRenders).toBeGreaterThan(0);
    expect(view.container.querySelector('.report-freshness__detail')?.textContent).toContain(
      'Generated 0s ago.',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(view.container.querySelector('.report-freshness__detail')?.textContent).toContain(
      'Generated 2s ago.',
    );
    expect(chartRenderCounter.count).toBe(chartRenders);
    await view.cleanup();
  });

  it('shows monitor skeleton charts until the initial snapshot resolves', async () => {
    const view = render('snapshot-monitor');
    let finishRequest!: (response: {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }) => void;
    const request = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>((resolve) => {
      finishRequest = resolve;
    });
    fetchMock.mockReturnValue(request);
    await view.mount();

    expect(
      view.container.querySelector('.monitor-detail-skeleton')?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(view.container.querySelector('.monitor-skeleton__plot')).not.toBeNull();
    expect(view.container.querySelector('.monitor-skeleton__uptime-days')).not.toBeNull();
    expect(view.container.querySelector('.state--loading')).toBeNull();

    await act(async () => {
      finishRequest({ ok: true, status: 200, json: async () => snapshot() });
      await request;
      await Promise.resolve();
    });
    expect(view.container.querySelector('.monitor-detail-skeleton')).toBeNull();
    expect(view.container.querySelector('.chart-section')).not.toBeNull();
    expect(view.container.textContent).toContain('Snapshot monitor');
    await view.cleanup();
  });

  it('shows latency skeletons while the snapshot is preparing charts, then real charts', async () => {
    vi.useFakeTimers();
    const view = render('snapshot-monitor');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => snapshot({ latency: { points: [], stats: [], pending: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          snapshot({
            latency: {
              points: [
                {
                  observedAt: '2026-09-20T11:45:00.000Z',
                  regionId: 'us-east',
                  responseMs: 42,
                  success: true,
                },
              ],
              stats: [
                {
                  regionId: 'us-east',
                  sampleCount: 1,
                  successCount: 1,
                  p50Ms: 42,
                  p95Ms: 42,
                  p99Ms: 42,
                },
              ],
              aggregatePoints: [{ observedAt: '2026-09-20T11:45:00.000Z', responseMs: 42 }],
              aggregateStats: {
                averageResponseMs: 42,
                maximumResponseMs: 42,
                maximumResponseRegionId: 'us-east',
                minimumResponseMs: 42,
              },
              pending: false,
            },
          }),
      });
    await view.mount();

    expect(
      view.container.querySelector('.monitor-latency-skeleton')?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(view.container.querySelectorAll('.monitor-skeleton__plot')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(view.container.querySelector('.monitor-latency-skeleton')).toBeNull();
    expect(
      view.container.querySelector('[aria-label="All-region average response latency chart"]'),
    ).not.toBeNull();
    expect(view.container.textContent).toContain('42ms');
    await view.cleanup();
  });

  it('refreshes by default and stops while the header toggle is disabled', async () => {
    vi.useFakeTimers();
    const view = render('snapshot-monitor');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() });
    await view.mount();

    const toggle = view.container.querySelector<HTMLButtonElement>(
      '.monitor-detail__refresh-toggle',
    )!;
    expect(toggle.textContent).toBe('Auto-refresh on');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('Auto-refresh off');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await view.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a linked status-page cohort and reads the independent monitor snapshot', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/monitor/snapshot-monitor?generation=linked-generation');
    const view = render('snapshot-monitor', 'status-page');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() });
    await view.mount();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://reports.example.test/public/monitors/snapshot-monitor.json',
      { credentials: 'omit', cache: 'no-cache', signal: expect.any(AbortSignal) },
    );
    expect(window.location.search).toBe('');
    expect(
      view.container.querySelector<HTMLAnchorElement>('.back-link')?.getAttribute('href'),
    ).toBe('/status/status-page');

    const range = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('.range-tabs button'),
    ).find((button) => button.textContent === '7d')!;
    await act(async () => range.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://reports.example.test/public/monitors/snapshot-monitor.json',
      { credentials: 'omit', cache: 'no-cache', signal: expect.any(AbortSignal) },
    );

    await view.cleanup();
  });

  it('ignores linked generations when the mounted component changes monitors', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/monitor/first?generation=first-generation');
    const view = render('first', 'status-page');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() });
    await view.mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://reports.example.test/public/monitors/first.json',
      { credentials: 'omit', cache: 'no-cache', signal: expect.any(AbortSignal) },
    );

    window.history.replaceState({}, '', '/monitor/second?generation=second-generation');
    await view.update('second', 'status-page');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://reports.example.test/public/monitors/second.json',
      { credentials: 'omit', cache: 'no-cache', signal: expect.any(AbortSignal) },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://reports.example.test/public/monitors/second.json',
      { credentials: 'omit', cache: 'no-cache', signal: expect.any(AbortSignal) },
    );

    await view.cleanup();
  });

  it('shows a stale state when the snapshot is older than its window', async () => {
    const view = render('snapshot-monitor');
    const stale = snapshot({
      generatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      staleAfterSeconds: 180,
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => stale });
    await view.mount();

    const banner = view.container.querySelector('.report-freshness--stale');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Stale snapshot');
    await view.cleanup();
  });

  it('marks an open snapshot stale as wall-clock time passes', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-20T12:00:00.000Z') });
    const view = render('snapshot-monitor');
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

  it('reports a removed snapshot as an error state', async () => {
    const view = render('gone-monitor');
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await view.mount();

    expect(view.container.querySelector('.state--error')).not.toBeNull();
    expect(view.container.textContent).toContain('no longer published');
    await view.cleanup();
  });
});
