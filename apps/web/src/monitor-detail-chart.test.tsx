// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { describe, expect, it, vi } from 'vitest';
import type { Observation } from '@uptime/contracts';
import type { MonitorDetailResponse } from './api.js';

vi.mock('recharts', async () => {
  const { createElement: element } = await import('react');
  return {
    ResponsiveContainer: ({ children }: { children?: ReactNode }) => element('div', null, children),
    LineChart: ({ children }: { children?: ReactNode }) => element('div', null, children),
    Line: ({ strokeWidth, dataKey }: { strokeWidth?: number; dataKey?: string }) =>
      element('div', {
        'data-stroke-width': String(strokeWidth),
        'data-line-key': dataKey,
      }),
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
  LatencySampleNote,
  ResponseLatencyChart,
  aggregateLatencyBucketLabel,
  formatChartDate,
  formatChartTooltipDate,
  formatResponseLatencyTooltip,
  formatUpdateCountdown,
  findLatestMonitorUpdate,
  getLatestResultState,
  latencyBucketLabel,
  millisecondsUntilNextUpdate,
  monitorHostname,
  toChart,
} = await import('./monitor-detail.js');

const observation = { id: '00000000-0000-4000-8000-000000000001' } as Observation;

describe('response latency chart helpers', () => {
  it('explains a pending graph without presenting it as freshly computed', async () => {
    const { container, root, cleanup } = createTestRoot();
    await act(async () =>
      root.render(createElement(LatencySampleNote, { data: { pending: true } })),
    );
    expect(container.textContent).toContain('Latency graph is being prepared');
    expect(container.textContent).not.toContain('Computed');
    await cleanup();
  });

  it.each([
    ['https://public.api.bsky.app/xrpc/app.bsky.feed.getTimeline', 'public.api.bsky.app'],
    ['https://example.test:8443/health', 'example.test'],
    ['not a valid URL', 'not a valid URL'],
  ])('displays the hostname for %s as %s', (url, expected) => {
    expect(monitorHostname(url)).toBe(expected);
  });

  it.each([
    ['1h', '5 minutes'],
    ['24h', '15 minutes'],
    ['7d', '1 hour'],
    ['30d', '6 hours'],
  ] as const)('uses %s buckets for the %s range', (range, expectedLabel) => {
    expect(latencyBucketLabel(range)).toBe(expectedLabel);
  });

  it.each([
    ['1h', '1 minute'],
    ['24h', '5 minutes'],
    ['7d', '15 minutes'],
    ['30d', '1 hour'],
  ] as const)('uses finer %s all-region buckets of %s', (range, expectedLabel) => {
    expect(aggregateLatencyBucketLabel(range)).toBe(expectedLabel);
  });

  it('formats axis dates followed by time in the visitor local timezone', () => {
    const value = '2026-08-30T23:30:00.000Z';
    const expected = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));

    expect(formatChartDate(value)).toBe(expected);
  });

  it('formats tooltip dates in local time and names the visitor timezone', () => {
    const value = '2026-08-30T23:30:00.000Z';
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const expected = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));

    expect(formatChartTooltipDate(value)).toBe(`${expected} (${timeZone})`);
  });

  it('finds the newest worker update across latest results and latency history', () => {
    expect(
      findLatestMonitorUpdate(
        [
          {
            startedAt: '2026-08-30T10:00:00.000Z',
            completedAt: '2026-08-30T10:00:01.000Z',
          },
          null,
        ],
        [{ observedAt: '2026-08-30T10:05:00.000Z' }],
      ),
    ).toBe('2026-08-30T10:05:00.000Z');
  });

  it('counts down to the next UTC-aligned check boundary', () => {
    const now = new Date('2026-08-30T10:02:30.000Z').getTime();
    expect(millisecondsUntilNextUpdate(now, 300)).toBe(150_000);
    expect(formatUpdateCountdown(150_000)).toBe('2m 30s');
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

describe('response latency chart views', () => {
  it('defaults to a finer all-region average with summary metrics', async () => {
    const { container, root, cleanup } = createTestRoot();
    const data = {
      latency: {
        points: [],
        stats: [],
        aggregatePoints: [
          {
            observedAt: '2026-08-30T10:00:00.000Z',
            responseMs: 59,
            success: true,
          },
        ],
        aggregateStats: {
          averageResponseMs: 59,
          maximumResponseMs: 1_858,
          maximumResponseRegionId: 'eu-west',
          minimumResponseMs: 7,
        },
      },
    } as unknown as MonitorDetailResponse;

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
      'averages response-to-headers latency equally across regions, grouped every 1 hour',
    );
    expect(container.querySelector('[data-line-key="responseMs"]')).not.toBeNull();
    expect(container.textContent).toContain('59ms');
    expect(container.textContent).toContain('1858ms');
    expect(container.textContent).toContain('7ms');
    expect(container.textContent).toContain('Avg. response time');
    expect(container.textContent).toContain('Max. response time (eu-west)');
    expect(container.textContent).toContain('Min. response time');
    expect(container.querySelector('#latency-percentiles-title')).toBeNull();

    const perRegion = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Per-region',
    );
    await act(async () => perRegion?.click());

    expect(container.textContent).toContain(
      'average response-to-headers latency for a region, grouped every 6 hours',
    );
    expect(container.textContent).toContain(
      'Each row is a per-region average, grouped every 6 hours in the selected range.',
    );
    expect(container.querySelector('th')?.textContent).toBe('Bucket');
    expect(container.textContent).toContain('Average response latency');
    expect(container.querySelector('#latency-percentiles-title')?.textContent).toBe(
      'Latency percentiles',
    );

    await cleanup();
  });

  it('wraps chart text-alternative tables in a clipped visually-hidden element', async () => {
    const { container, root, cleanup } = createTestRoot();
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

    await cleanup();
  });

  it('toggles a region line and exposes the chart configuration', async () => {
    const { container, root, cleanup } = createTestRoot();
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
    const perRegion = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Per-region',
    );
    await act(async () => perRegion?.click());
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

    await cleanup();
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
