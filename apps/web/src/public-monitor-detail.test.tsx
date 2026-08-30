// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
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
} satisfies PublicMonitorDetailResponse;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('public monitor detail', () => {
  it('loads only public aggregate data and omits private/admin UI', async () => {
    apiMock.publicMonitor.mockResolvedValue(detail);
    const container = document.createElement('div');
    const root = createRoot(container);
    const reactEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => {
      root.render(
        createElement(MonitorDetail, { monitorId: detail.summary.monitor.id, publicMode: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMock.publicMonitor).toHaveBeenCalledWith(detail.summary.monitor.id, '24h');
    expect(apiMock.monitor).not.toHaveBeenCalled();
    expect(apiMock.observations).not.toHaveBeenCalled();
    expect(apiMock.dnsDiagnostics).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Response latency');
    expect(container.textContent).toContain('Latency percentiles');
    expect(container.textContent).not.toContain('Exact requests');
    expect(container.textContent).not.toContain('DNS diagnostics');
    expect(container.textContent).not.toContain('Edit');
    expect(container.textContent).not.toContain('Delete');
    expect(container.textContent).not.toContain('← Monitors');

    const sevenDayRange = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '7d',
    );
    await act(async () => {
      sevenDayRange?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.publicMonitor).toHaveBeenLastCalledWith(detail.summary.monitor.id, '7d');
    expect(container.textContent).toContain('grouped every 1 hour in the selected range');

    await act(async () => root.unmount());
    if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
});
