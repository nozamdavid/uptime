// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MonitorDetailResponse } from './api.js';

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const { LatencyPercentileChart, LatencySampleNote, toPercentileChart } =
  await import('./monitor-detail.js');
const data = {
  latency: {
    points: [],
    stats: [
      {
        regionId: 'eu-west',
        sampleCount: 10,
        successCount: 10,
        p50Ms: 120,
        p95Ms: 250,
        p99Ms: 350,
      },
      { regionId: 'asia', sampleCount: 3, successCount: 0, p50Ms: null, p95Ms: null, p99Ms: null },
    ],
  },
} as unknown as MonitorDetailResponse;

describe('latency percentile chart data', () => {
  it('uses chart region order and preserves unavailable percentile values', () => {
    const chart = toPercentileChart(data, ['us-east', 'eu-west', 'asia']);

    expect(chart).toEqual([
      {
        regionId: 'us-east',
        region: 'US East (N. Virginia)',
        chartLabel: 'US East',
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      },
      {
        regionId: 'eu-west',
        region: 'Europe West (Ireland)',
        chartLabel: 'Europe West',
        p50Ms: 120,
        p95Ms: 250,
        p99Ms: 350,
      },
      {
        regionId: 'asia',
        region: 'Asia Southeast (Singapore)',
        chartLabel: 'Asia Southeast',
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      },
    ]);
  });

  it('renders percentile names and an accessible text alternative', () => {
    const markup = renderToStaticMarkup(
      createElement(LatencyPercentileChart, {
        data,
        chartRegions: ['us-east', 'eu-west', 'asia'],
      }),
    );

    expect(markup).toContain('Latency percentiles');
    expect(markup).toContain('aria-label="Regional latency percentiles bar chart"');
    expect(markup).toContain('P50 (median)');
    expect(markup).toContain('P95');
    expect(markup).toContain('P99');
    expect(markup).toContain('Text alternative for the regional latency percentiles bar chart');
    expect(markup).toContain('Europe West (Ireland)');
    expect(markup).toContain('120ms');
    expect(markup).toContain('250ms');
    expect(markup).toContain('350ms');
    expect(markup).toContain('US East (N. Virginia)</td><td>—</td>');
  });

  it('describes the observation limit consistently alongside computed age', () => {
    const markup = renderToStaticMarkup(
      createElement(LatencySampleNote, {
        data: {
          sampled: true,
          sampleLimit: 5_000,
          computedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      }),
    );

    expect(markup).toContain(
      'Percentiles and chart points use up to the most recent 5,000 observations.',
    );
    expect(markup).toContain('Computed 10m ago.');

    const belowLimit = renderToStaticMarkup(
      createElement(LatencySampleNote, {
        data: {
          sampled: false,
          sampleLimit: 5_000,
          computedAt: new Date(Date.now() - 82 * 1000).toISOString(),
        },
      }),
    );
    expect(belowLimit).toContain(
      'Percentiles and chart points use up to the most recent 5,000 observations.',
    );
    expect(belowLimit).toContain('Computed 82s ago.');

    const exact = renderToStaticMarkup(createElement(LatencySampleNote, { data: {} }));
    expect(exact).toBe('');
  });
});
