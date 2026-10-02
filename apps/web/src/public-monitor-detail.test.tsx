// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicMonitorDetailResponse } from './api.js';

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
