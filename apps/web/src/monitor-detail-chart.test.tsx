// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Observation } from '@uptime/contracts';
import type { MonitorDetailResponse } from './api.js';

vi.mock('recharts', async () => {
  const { createElement: element } = await import('react');
  return {
    ResponsiveContainer: ({ children }: { children?: ReactNode }) => element('div', null, children),
    LineChart: ({ children }: { children?: ReactNode }) => element('div', null, children),
    Line: ({ strokeWidth }: { strokeWidth?: number }) =>
      element('div', { 'data-stroke-width': String(strokeWidth) }),
    XAxis: ({ angle }: { angle?: number }) => element('div', { 'data-angle': String(angle) }),
    YAxis: () => element('div'),
    Tooltip: () => element('div'),
    Bar: () => element('div'),
    BarChart: ({ children }: { children?: ReactNode }) => element('div', null, children),
  };
});

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const {
  LatencyPercentileChart,
  ResponseLatencyChart,
  formatChartDate,
  formatResponseLatencyTooltip,
  getLatestResultState,
  latencyBucketLabel,
  toChart,
} = await import('./monitor-detail.js');

const observation = { id: '00000000-0000-4000-8000-000000000001' } as Observation;

describe('response latency chart helpers', () => {
  it.each([
    ['1h', '5 minutes'],
    ['24h', '15 minutes'],
    ['7d', '1 hour'],
    ['30d', '6 hours'],
  ] as const)('uses %s buckets for the %s range', (range, expectedLabel) => {
    expect(latencyBucketLabel(range)).toBe(expectedLabel);
  });

  it('formats axis dates as a stable short UTC date', () => {
    expect(formatChartDate('2026-08-30T23:30:00.000Z')).toBe('30/08/26');
  });

  it.each([
    [191.33333333333334, '191.33ms'],
    [224, '224ms'],
    [191.3, '191.3ms'],
    [null, '—'],
    ['191.3333', '—'],
    [Number.NaN, '—'],
    [Number.POSITIVE_INFINITY, '—'],
  ])('formats tooltip latency values', (value, expected) => {
    expect(formatResponseLatencyTooltip(value)).toBe(expected);
  });

  it('groups region samples from the same second into one chart row', () => {
    const chart = toChart({
      latency: {
        points: [
          { observedAt: '2026-08-30T10:00:00.120Z', regionId: 'eu-west', responseMs: 120 },
          { observedAt: '2026-08-30T10:00:00.850Z', regionId: 'us-east', responseMs: 150 },
          { observedAt: '2026-08-30T10:00:01.010Z', regionId: 'eu-west', responseMs: 125 },
        ],
      },
    } as never);

    expect(chart).toEqual([
      { time: '2026-08-30T10:00:00.000Z', 'eu-west': 120, 'us-east': 150 },
      { time: '2026-08-30T10:00:01.000Z', 'eu-west': 125 },
    ]);
  });
});

describe('response latency chart legend', () => {
  it('describes points as regional averages for the selected bucket size', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const reactEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const data = { latency: { points: [], stats: [] } } as unknown as MonitorDetailResponse;

    await act(async () => {
      root.render(
        createElement(ResponseLatencyChart, {
          data,
          chartRegions: [],
          range: '30d',
        }),
      );
    });

    expect(container.textContent).toContain(
      'average response-to-headers latency for a region, grouped every 6 hours',
    );
    expect(container.textContent).toContain(
      'Each row is a per-region average, grouped every 6 hours in the selected range.',
    );
    expect(container.querySelector('th')?.textContent).toBe('Bucket');
    expect(container.textContent).toContain('Average response latency');

    await act(async () => root.unmount());
    if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it('wraps chart text-alternative tables in a clipped visually-hidden element', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const reactEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const data = {
      latency: {
        points: [
          {
            observedAt: '2026-08-30T10:00:00.000Z',
            regionId: 'eu-west',
            responseMs: 120,
            success: true,
          },
        ],
        stats: [
          {
            regionId: 'eu-west',
            sampleCount: 1,
            successCount: 1,
            p50Ms: 120,
            p95Ms: 120,
            p99Ms: 120,
          },
        ],
      },
    } as unknown as MonitorDetailResponse;

    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(ResponseLatencyChart, { data, chartRegions: ['eu-west'] }),
          createElement(LatencyPercentileChart, { data, chartRegions: ['eu-west'] }),
        ),
      );
    });

    const textAlternativeTables = [...container.querySelectorAll('caption')]
      .filter((caption) => caption.textContent?.startsWith('Text alternative for the'))
      .map((caption) => caption.closest('table'));
    expect(textAlternativeTables).toHaveLength(2);
    for (const table of textAlternativeTables) {
      expect(table).not.toBeNull();
      expect(table?.classList.contains('sr-only')).toBe(false);
      expect(table?.parentElement?.classList.contains('sr-only')).toBe(true);
    }

    await act(async () => root.unmount());
    if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it('toggles a region line and exposes the chart configuration', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const reactEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const data = {
      latency: {
        points: [
          {
            observedAt: '2026-08-30T10:00:00.000Z',
            regionId: 'eu-west',
            responseMs: 120,
            success: true,
          },
        ],
        stats: [],
      },
    } as unknown as MonitorDetailResponse;

    await act(async () => {
      root.render(createElement(ResponseLatencyChart, { data, chartRegions: ['eu-west'] }));
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Europe West (Ireland) response latency line"]',
    );
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-stroke-width="1.5"]')).not.toBeNull();
    expect(container.querySelector('[data-angle="-40"]')).not.toBeNull();

    await act(async () => {
      button?.click();
    });
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.classList.contains('is-hidden')).toBe(true);

    await act(async () => {
      root.unmount();
    });
    if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
});

describe('latest result state', () => {
  it('treats a complete current set as complete', () => {
    expect(
      getLatestResultState(true, ['eu-west', 'us-east'], {
        'eu-west': observation,
        'us-east': observation,
      }),
    ).toEqual({ kind: 'complete' });
  });

  it('only flags a partially missing current set', () => {
    expect(
      getLatestResultState(true, ['eu-west', 'us-east'], {
        'eu-west': observation,
        'us-east': null,
      }),
    ).toEqual({ kind: 'partial', missing: ['us-east'] });
  });

  it('treats an omitted configured region as missing', () => {
    expect(getLatestResultState(true, ['eu-west', 'us-east'], { 'eu-west': observation })).toEqual({
      kind: 'partial',
      missing: ['us-east'],
    });
  });

  it('awaits first results when every enabled region is currently empty', () => {
    expect(
      getLatestResultState(true, ['eu-west', 'us-east'], { 'eu-west': null, 'us-east': null }),
    ).toEqual({ kind: 'awaiting' });
  });

  it('does not warn for a disabled monitor', () => {
    expect(
      getLatestResultState(false, ['eu-west', 'us-east'], {
        'eu-west': observation,
        'us-east': null,
      }),
    ).toEqual({ kind: 'disabled' });
  });
});
