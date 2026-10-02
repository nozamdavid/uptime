// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  monitor: vi.fn(),
  observations: vi.fn(),
  dnsDiagnostics: vi.fn(),
  deleteMonitor: vi.fn(),
  updateMonitor: vi.fn(),
}));

vi.mock('./api.js', () => ({ api: apiMock, RequestError: class RequestError extends Error {} }));
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

const { MonitorDetail } = await import('./monitor-detail.js');
const reactEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;

function detail(id: string) {
  return {
    summary: {
      monitor: {
        id,
        name: id,
        url: 'https://example.test',
        regionIds: ['us-east'],
        intervalSeconds: 300,
        timeoutMs: 10_000,
        enabled: true,
        dnsDiagnosticsEnabled: true,
        isPublic: false,
        publicSlug: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      status: 'up',
      latestByRegion: { 'us-east': null },
      targetChecksPerDay: 288,
    },
    latency: { points: [], stats: [] },
    uptime: { uptimePercentage: 100, status: 'up', days: [] },
  };
}

function observation(marker: string) {
  return {
    id: crypto.randomUUID(),
    checkRunId: crypto.randomUUID(),
    monitorId: crypto.randomUUID(),
    regionId: 'us-east',
    status: 'http_failure',
    success: false,
    httpStatus: 500,
    responseMs: 10,
    totalMs: 12,
    errorCode: null,
    errorDetail: marker,
    placement: null,
    colo: null,
    finalUrl: 'https://example.test',
    endpointEvidence: null,
    dnsDiagnostic: null,
    redirectCount: 0,
    bodyBytes: 0,
    probeVersion: 'test',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.012Z',
  };
}

beforeEach(() => {
  previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.clearAllMocks();
  if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe('monitor detail pagination ownership', () => {
  it('discards an older observation page after switching monitors', async () => {
    let finishOlder: ((value: unknown) => void) | undefined;
    apiMock.monitor.mockImplementation((id: string) => Promise.resolve(detail(id)));
    apiMock.observations.mockImplementation((id: string, _range: string, cursor?: string) => {
      if (cursor) return new Promise((resolve) => (finishOlder = resolve));
      return Promise.resolve({ items: [observation(`${id}-current`)], nextCursor: 'older' });
    });
    apiMock.dnsDiagnostics.mockResolvedValue({ items: [], nextCursor: null });
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MonitorDetail, { monitorId: 'monitor-old' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const loadOlder = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load older requests',
    );
    await act(async () => loadOlder?.click());
    await act(async () => {
      root.render(createElement(MonitorDetail, { monitorId: 'monitor-new' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => finishOlder?.({ items: [observation('stale-older')], nextCursor: null }));

    expect(container.textContent).toContain('monitor-new-current');
    expect(container.textContent).not.toContain('stale-older');
    await act(async () => root.unmount());
  });

  it('discards an older DNS page failure after switching monitors', async () => {
    let failOlder: ((reason: Error) => void) | undefined;
    apiMock.monitor.mockImplementation((id: string) => Promise.resolve(detail(id)));
    apiMock.observations.mockResolvedValue({ items: [], nextCursor: null });
    apiMock.dnsDiagnostics.mockImplementation(
      (_id: string, _range: string, _region?: string, cursor?: string) => {
        if (cursor) return new Promise((_resolve, reject) => (failOlder = reject));
        return Promise.resolve({ items: [], nextCursor: 'older-dns' });
      },
    );
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MonitorDetail, { monitorId: 'monitor-old' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const loadOlder = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load older DNS snapshots',
    );
    await act(async () => loadOlder?.click());
    await act(async () => {
      root.render(createElement(MonitorDetail, { monitorId: 'monitor-new' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => failOlder?.(new Error('stale DNS failure')));

    expect(container.textContent).not.toContain('stale DNS failure');
    expect(container.textContent).toContain('monitor-new');
    await act(async () => root.unmount());
  });
});
