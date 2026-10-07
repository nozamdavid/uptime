// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';
import type { PublicMonitorDetailResponse } from './api.js';

const apiMock = vi.hoisted(() => ({
  publicMonitor: vi.fn(),
  publicStatusPage: vi.fn(),
  monitor: vi.fn(),
  observations: vi.fn(),
  dnsDiagnostics: vi.fn(),
}));
vi.mock('./api.js', () => ({ api: apiMock, RequestError: class extends Error {} }));
vi.mock('./product-shell.js', () => ({ useProductSession: () => null }));
vi.mock('recharts', async () => {
  const { createElement: element } = await import('react');
  const container = ({ children }: { children?: ReactNode }) => element('div', null, children);
  return {
    ResponsiveContainer: container,
    LineChart: container,
    BarChart: container,
    Line: () => null,
    Bar: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
});
const { MonitorDetail } = await import('./monitor-detail.js');
const detail = {
  summary: {
    monitor: {
      id: 'example',
      name: 'Public monitor',
      url: 'https://example.test',
      regionIds: ['us-east'],
      intervalSeconds: 300,
      timeoutMs: 10_000,
      enabled: true,
      isPublic: true,
      publicSlug: null,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
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
  uptime: { days: [], uptimePercentage: 100, status: 'up', recoveryStatus: null },
  latency: { points: [], stats: [], aggregatePoints: [] },
} as PublicMonitorDetailResponse;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('public monitor direct retrieval', () => {
  it('inherits the font fetched from its status page', async () => {
    apiMock.publicMonitor.mockResolvedValue(detail);
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page', title: 'Service status', publicSlug: null, fontFamily: 'dm-sans', groups: [],
    });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MonitorDetail, {
        monitorId: 'example', publicMode: true, statusPageId: 'page',
      }));
      await Promise.resolve();
    });
    expect(apiMock.publicStatusPage).toHaveBeenCalledWith('page');
    expect(view.container.querySelector('.detail')?.getAttribute('data-font')).toBe('dm-sans');
    await view.cleanup();
  });
  it('uses the public API even with reports enabled and fetches each selected range', async () => {
    vi.stubEnv('VITE_REPORTS_BASE_URL', '/reports');
    apiMock.publicMonitor.mockResolvedValue(detail);
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(MonitorDetail, {
          monitorId: 'example',
          publicMode: true,
          statusPageId: 'page',
        }),
      );
    });
    expect(apiMock.publicMonitor).toHaveBeenCalledWith('example', '24h');
    expect(apiMock.monitor).not.toHaveBeenCalled();
    expect(apiMock.observations).not.toHaveBeenCalled();
    expect(apiMock.dnsDiagnostics).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Public monitor');
    expect(view.container.textContent).not.toContain('Edit');
    expect(view.container.textContent).not.toContain('Exact requests');
    expect(view.container.querySelector('.report-freshness')).toBeNull();
    const range = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === '7d',
    );
    await act(async () => {
      range?.click();
    });
    expect(apiMock.publicMonitor).toHaveBeenLastCalledWith('example', '7d');
    await view.cleanup();
  });

  it('refreshes every minute and stops when auto-refresh is disabled', async () => {
    vi.useFakeTimers();
    apiMock.publicMonitor.mockResolvedValue(detail);
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MonitorDetail, { monitorId: 'example', publicMode: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiMock.publicMonitor).toHaveBeenCalledTimes(2);
    const toggle = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Auto-refresh on',
    );
    await act(async () => {
      toggle?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(apiMock.publicMonitor).toHaveBeenCalledTimes(2);
    await view.cleanup();
  });

  it('ignores a previous monitor response after navigation', async () => {
    let resolve!: (value: PublicMonitorDetailResponse) => void;
    apiMock.publicMonitor
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce({
        ...detail,
        summary: { ...detail.summary, monitor: { ...detail.summary.monitor, name: 'Second' } },
      });
    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(MonitorDetail, { monitorId: 'first', publicMode: true }));
    });
    await act(async () => {
      view.root.render(createElement(MonitorDetail, { monitorId: 'second', publicMode: true }));
    });
    await act(async () => {
      resolve(detail);
    });
    expect(view.container.textContent).toContain('Second');
    expect(view.container.textContent).not.toContain('Public monitor');
    await view.cleanup();
  });
});
