// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicMonitorDetailResponse } from './api.js';
import type { MonitorReportSnapshot } from './reports.js';

const apiMock = vi.hoisted(() => ({
  session: vi.fn().mockResolvedValue({ admin: { email: 'admin@example.test' } }),
  signIn: vi.fn(),
  signOut: vi.fn(),
  monitors: vi.fn().mockResolvedValue({ monitors: [] }),
  publicMonitor: vi.fn(),
  monitor: vi.fn(),
  observations: vi.fn(),
  dnsDiagnostics: vi.fn(),
  deleteMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  createMonitor: vi.fn(),
}));

vi.mock('./api.js', () => ({
  api: apiMock,
  RequestError: class RequestError extends Error {},
}));
vi.mock('recharts', async () => {
  const { createElement: element } = await import('react');
  return {
    ResponsiveContainer: ({ children }: { children?: ReactNode }) => element('div', null, children),
    LineChart: ({ children }: { children?: ReactNode }) => element('div', null, children),
    Line: () => element('div'),
    XAxis: () => element('div'),
    YAxis: () => element('div'),
    Tooltip: () => element('div'),
    Bar: () => element('div'),
    BarChart: ({ children }: { children?: ReactNode }) => element('div', null, children),
  };
});

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const { MonitorDetail } = await import('./monitor-detail.js');

const detail = {
  summary: {
    monitor: {
      id: '60127b00-b86d-4e7a-8f43-63edb60b7abf',
      name: 'Public status',
      url: 'https://status.example.test/health',
      regionIds: ['us-east'],
      intervalSeconds: 300,
      timeoutMs: 10_000,
      enabled: true,
      isPublic: true,
      publicSlug: null,
      createdAt: '2026-08-30T09:00:00.000Z',
      updatedAt: '2026-08-30T09:00:00.000Z',
    },
    status: 'up',
    latestByRegion: {
      'us-east': null,
      'us-west': null,
      'canada-central': null,
      'eu-west': null,
      'eu-north': null,
      'eu-south': null,
      asia: null,
      'asia-east': null,
      'asia-south': null,
    },
    targetChecksPerDay: 288,
  },
  latency: {
    points: [
      {
        observedAt: '2026-08-30T10:00:00.000Z',
        regionId: 'us-east',
        responseMs: 120,
        success: true,
      },
    ],
    stats: [
      { regionId: 'us-east', sampleCount: 1, successCount: 1, p50Ms: 120, p95Ms: 120, p99Ms: 120 },
    ],
  },
  uptime: {
    uptimePercentage: 99.5,
    status: 'up',
    recoveryStatus: 'recovering',
    days: [
      { date: '2026-08-29', uptimePercentage: 99, averageResponseMs: 120 },
      { date: '2026-08-30', uptimePercentage: 100, averageResponseMs: 118.25 },
    ],
  },
} satisfies PublicMonitorDetailResponse;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('public monitor detail', () => {
  it('loads only public aggregate data and omits private/admin UI', async () => {
    apiMock.publicMonitor.mockResolvedValue(detail);
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(MonitorDetail, {
          monitorId: detail.summary.monitor.id,
          publicMode: true,
          statusPageId: 'page-1',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMock.publicMonitor).toHaveBeenCalledWith(detail.summary.monitor.id, '24h');
    expect(apiMock.monitor).not.toHaveBeenCalled();
    expect(apiMock.observations).not.toHaveBeenCalled();
    expect(apiMock.dnsDiagnostics).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Response latency');
    expect(container.textContent).not.toContain('Latency percentiles');
    expect(container.textContent).toContain('90-day uptime');
    expect(container.textContent).toContain('99.5%');
    expect(container.textContent).toContain('Recovering');
    expect(container.querySelector('.monitor-uptime__state--recovering')).not.toBeNull();
    expect(container.textContent).toContain('Last updated');
    expect(container.textContent).toContain('Next update in');
    expect(container.querySelectorAll('.uptime-day')).toHaveLength(2);
    expect(container.textContent).not.toContain('Exact requests');
    expect(container.textContent).not.toContain('DNS diagnostics');
    expect(container.textContent).not.toContain('Edit');
    expect(container.textContent).not.toContain('Delete');
    expect(container.textContent).not.toContain('← Monitors');
    expect(container.querySelector('.back-link')?.textContent).toBe('← Back to status page');
    expect(container.querySelector('.back-link')?.getAttribute('href')).toBe('/status/page-1');
    const targetLink = container.querySelector<HTMLAnchorElement>(
      `a[href="${detail.summary.monitor.url}"]`,
    );
    expect(targetLink?.textContent).toBe('status.example.test');
    expect(targetLink?.target).toBe('_blank');
    const latencyChart = container.querySelector('.chart-section');
    const percentileStats = container.querySelector('.stat-strip');
    expect(
      latencyChart && percentileStats
        ? latencyChart.compareDocumentPosition(percentileStats) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const sevenDayRange = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '7d',
    );
    await act(async () => {
      sevenDayRange?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.publicMonitor).toHaveBeenLastCalledWith(detail.summary.monitor.id, '7d');
    expect(container.textContent).toContain('grouped every 15 minutes in the selected range');

    await cleanup();
  });
});

describe('public monitor report loading through fetch and render', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let view: ReturnType<typeof createTestRoot>;
  const snapshot = (name = 'Fresh monitor', stale = false): MonitorReportSnapshot => ({
    ...detail,
    summary: { ...detail.summary, monitor: { ...detail.summary.monitor, name } },
    schemaVersion: '1',
    generatedAt: new Date(Date.now() - (stale ? 600_000 : 0)).toISOString(),
    latestObservationAt: null,
    staleAfterSeconds: 180,
  });
  const pending = (retryAfter = '1') =>
    Response.json(
      { error: 'Report refresh in progress' },
      {
        status: 503,
        headers: { 'Retry-After': retryAfter },
      },
    );
  const render = async (monitorId = 'first') => {
    await act(async () => {
      view.root.render(createElement(MonitorDetail, { monitorId, publicMode: true }));
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_REPORTS_BASE_URL', '/reports');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    view = createTestRoot();
  });
  afterEach(async () => {
    await view.cleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps cold 503 → 503 → 200 loading and honors Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(pending('2'))
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(Response.json(snapshot()));
    await render();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.querySelector('.monitor-detail-skeleton')).not.toBeNull();
    await advance(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain('Report unavailable');
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(view.container.textContent).toContain('Fresh monitor');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders stale cached data while retrying stale → pending → fresh promptly', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(snapshot('Cached monitor', true)))
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(Response.json(snapshot()));
    await render();
    expect(view.container.textContent).toContain('Cached monitor');
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Cached monitor');
    expect(view.container.textContent).not.toContain('Latest refresh failed');
    await advance(1_000);
    expect(view.container.textContent).toContain('Fresh monitor');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([404, 500, 503])('stops prompt retries for a genuine HTTP %s error', async (status) => {
    fetchMock.mockResolvedValue(Response.json({ error: 'Host failed' }, { status }));
    await render();
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.container.textContent).toContain(
      status === 404 ? 'no longer published' : 'Report unavailable',
    );
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds cold pending retries and offers a manual retry', async () => {
    fetchMock.mockImplementation(async () => pending('0'));
    await render();
    await advance(31_000);
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.container.textContent).toContain('still being prepared');
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(31);
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    fetchMock.mockResolvedValue(Response.json(snapshot()));
    await act(async () => {
      view.container.querySelector('button')?.click();
    });
    expect(view.container.textContent).toContain('Fresh monitor');
  });

  it('bounds stale recovery while retaining the cached report', async () => {
    fetchMock.mockImplementation(async () => Response.json(snapshot('Cached monitor', true)));
    await render();
    await advance(31_000);
    expect(fetchMock).toHaveBeenCalledTimes(30);
    expect(view.container.textContent).toContain('Cached monitor');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it('preserves existing data when a regular background refresh is pending', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(snapshot('Cached monitor')))
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(Response.json(snapshot()));
    await render();
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Cached monitor');
    expect(view.container.textContent).not.toContain('Latest refresh failed');
    await advance(1_000);
    expect(view.container.textContent).toContain('Fresh monitor');
  });

  it.each(['network', 'invalid snapshot'])(
    'stops recovery on an actual %s failure after pending',
    async (failure) => {
      fetchMock.mockResolvedValueOnce(pending());
      if (failure === 'network') fetchMock.mockRejectedValue(new TypeError('Network failed'));
      else fetchMock.mockResolvedValue(Response.json({}));
      await render();
      await advance(1_000);
      expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('cancels the previous monitor retry on navigation', async () => {
    fetchMock
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(Response.json(snapshot('Second monitor')));
    await render();
    await render('second');
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/second.json');
    expect(view.container.textContent).toContain('Second monitor');
  });

  it('ignores a previous monitor response that arrives after navigation', async () => {
    let resolve!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(Response.json(snapshot('Second monitor')));
    await render();
    await render('second');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      resolve(Response.json(snapshot('First monitor', true)));
    });
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Second monitor');
    expect(view.container.textContent).not.toContain('First monitor');
  });

  it('does not reuse the previous monitor cache for a cold monitor', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(snapshot('First monitor')))
      .mockImplementation(async () => pending());
    await render();
    await render('second');
    expect(view.container.textContent).not.toContain('First monitor');
    await advance(31_000);
    expect(view.container.textContent).not.toContain('First monitor');
    expect(view.container.textContent).toContain('still being prepared');
  });

  it('honors auto-refresh off for stale recovery and resumes when enabled', async () => {
    fetchMock.mockImplementation(async () => Response.json(snapshot('Cached monitor', true)));
    await render();
    const toggle = () =>
      [...view.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Auto-refresh'),
      );
    await act(async () => {
      toggle()?.click();
    });
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(Response.json(snapshot()));
    await act(async () => {
      toggle()?.click();
    });
    await advance(60_000);
    expect(view.container.textContent).toContain('Fresh monitor');
  });
});
