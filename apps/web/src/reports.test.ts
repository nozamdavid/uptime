import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorReportSnapshot, StatusPageReportSnapshot } from './reports.js';
import {
  assessFreshness,
  assessLatencySampling,
  formatAge,
  loadMonitorReport,
  loadStatusPageIndex,
  loadStatusPageReport,
  monitorReportUrl,
  monitorSnapshotToDetail,
  SnapshotPendingError,
  statusPageIndexUrl,
  statusPageReportUrl,
  statusPageSnapshotToPage,
} from './reports.js';

const monitorSnapshot: MonitorReportSnapshot = {
  schemaVersion: '1',
  generatedAt: '2026-09-20T12:00:00.000Z',
  latestObservationAt: '2026-09-20T11:59:30.000Z',
  staleAfterSeconds: 180,
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
      publicSlug: 'public-status',
      createdAt: '2026-08-30T09:00:00.000Z',
      updatedAt: '2026-08-30T09:00:00.000Z',
    },
    status: 'up',
    latestByRegion: {
      'us-east': {
        regionId: 'us-east',
        status: 'success',
        success: true,
        httpStatus: 200,
        responseMs: 120,
        totalMs: 130,
        errorCode: null,
        startedAt: '2026-09-20T11:59:30.000Z',
        completedAt: '2026-09-20T11:59:31.000Z',
      },
      'us-west': null,
      'canada-central': null,
      'eu-west': null,
      'eu-north': null,
      'eu-south': null,
      asia: null,
      'asia-east': null,
      'asia-south': null,
    } as MonitorReportSnapshot['summary']['latestByRegion'],
    targetChecksPerDay: 288,
  },
  uptime: {
    uptimePercentage: 99.5,
    status: 'up',
    days: [{ date: '2026-09-19', uptimePercentage: 100, averageResponseMs: 118 }],
  },
  latency: {
    points: [
      {
        observedAt: '2026-09-20T11:00:00.000Z',
        regionId: 'us-east',
        responseMs: 120,
        success: true,
      },
    ],
    stats: [
      {
        regionId: 'us-east',
        sampleCount: 1,
        successCount: 1,
        p50Ms: 120,
        p95Ms: 120,
        p99Ms: 120,
      },
    ],
    sampled: true,
    sampleLimit: 5_000,
    computedAt: '2026-09-20T11:58:00.000Z',
  },
  latencyByRange: {
    '7d': {
      points: [
        {
          observedAt: '2026-09-14T00:00:00.000Z',
          regionId: 'us-east',
          responseMs: 140,
          success: true,
        },
      ],
      stats: [],
      sampled: false,
      sampleLimit: 5_000,
      computedAt: '2026-09-20T11:30:00.000Z',
    },
  },
};

const statusPageSnapshot: StatusPageReportSnapshot = {
  schemaVersion: '1',
  generatedAt: '2026-09-20T12:00:00.000Z',
  latestObservationAt: '2026-09-20T11:59:30.000Z',
  staleAfterSeconds: 180,
  statusPage: {
    id: 'page-1',
    title: 'Service status',
    publicSlug: 'service-status',
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
};

describe('public report URLs', () => {
  it('uses slug-based object keys under the configured reports base', () => {
    expect(monitorReportUrl('public-status', 'https://reports.example.test')).toBe(
      'https://reports.example.test/public/monitors/public-status.json',
    );
    expect(statusPageReportUrl('service-status', 'https://reports.example.test')).toBe(
      'https://reports.example.test/public/status-pages/service-status.json',
    );
    expect(statusPageIndexUrl('https://reports.example.test')).toBe(
      'https://reports.example.test/public/status-pages.json',
    );
  });

  it('returns null URLs when report hosting is not configured', () => {
    expect(monitorReportUrl('public-status', null)).toBeNull();
    expect(statusPageReportUrl('service-status', null)).toBeNull();
    expect(statusPageIndexUrl(null)).toBeNull();
  });
});

describe('snapshot loading', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('loads monitor snapshots without credentials and preserves freshness fields', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => monitorSnapshot });
    const loaded = await loadMonitorReport('public-status', 'https://reports.example.test');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://reports.example.test/public/monitors/public-status.json',
      { credentials: 'omit', cache: 'no-cache' },
    );
    expect(loaded.schemaVersion).toBe('1');
    expect(loaded.generatedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(loaded.latestObservationAt).toBe('2026-09-20T11:59:30.000Z');
    expect(loaded.staleAfterSeconds).toBe(180);
  });

  it('surfaces 404 as a removed-report error state', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(loadMonitorReport('gone', 'https://reports.example.test')).rejects.toMatchObject({
      status: 404,
    });
  });

  it.each([
    [null, 1_000],
    ['invalid', 1_000],
    ['0', 1_000],
    ['-1', 1_000],
    ['2', 2_000],
    ['999999', 5_000],
  ])('bounds pending Retry-After %s to %s ms', async (value, expected) => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: 'Report refresh in progress' },
        {
          status: 503,
          headers: value === null ? {} : { 'Retry-After': value },
        },
      ),
    );
    const error = await loadMonitorReport('pending', 'https://reports.example.test').catch(
      (reason) => reason,
    );
    expect(error).toBeInstanceOf(SnapshotPendingError);
    expect(error.retryAfterMs).toBe(expected);
  });

  it('accepts an HTTP date Retry-After', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-05T12:00:00Z'));
    try {
      fetchMock.mockResolvedValue(
        Response.json(
          { error: 'Report refresh in progress' },
          {
            status: 503,
            headers: { 'Retry-After': 'Mon, 05 Oct 2026 12:00:03 GMT' },
          },
        ),
      );
      await expect(
        loadMonitorReport('pending', 'https://reports.example.test'),
      ).rejects.toMatchObject({ retryAfterMs: 3_000 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps a malformed 503 response as a genuine error', async () => {
    fetchMock.mockResolvedValue(new Response('Service unavailable', { status: 503 }));
    await expect(loadMonitorReport('broken', 'https://reports.example.test')).rejects.toMatchObject(
      {
        name: 'SnapshotError',
        status: 503,
        message: 'Report unavailable',
      },
    );
  });

  it('loads status page snapshots and the public index', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => statusPageSnapshot });
    const page = await loadStatusPageReport('service-status', 'https://reports.example.test');
    expect(page.statusPage.title).toBe('Service status');

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: '1',
        generatedAt: '2026-09-20T12:00:00.000Z',
        latestObservationAt: null,
        staleAfterSeconds: 180,
        statusPages: [{ id: 'page-1', title: 'Service status', publicSlug: 'service-status' }],
      }),
    });
    const index = await loadStatusPageIndex('https://reports.example.test');
    expect(index.statusPages).toHaveLength(1);
  });
});

describe('snapshot to response mapping', () => {
  it('preserves the existing public monitor response fields', () => {
    const detail = monitorSnapshotToDetail(monitorSnapshot, '24h');
    expect(detail.summary.monitor.url).toBe('https://status.example.test/health');
    expect(detail.summary.latestByRegion['us-east']?.responseMs).toBe(120);
    expect(detail.uptime.uptimePercentage).toBe(99.5);
    expect(detail.latency.points).toHaveLength(1);
  });

  it('preserves latency sampling and computedAt metadata through range mapping', () => {
    expect(monitorSnapshotToDetail(monitorSnapshot, '24h').latency).toMatchObject({
      sampled: true,
      sampleLimit: 5_000,
      computedAt: '2026-09-20T11:58:00.000Z',
    });
    expect(monitorSnapshotToDetail(monitorSnapshot, '7d').latency).toMatchObject({
      sampled: false,
      computedAt: '2026-09-20T11:30:00.000Z',
    });
  });

  it('selects range-specific latency when published', () => {
    const detail = monitorSnapshotToDetail(monitorSnapshot, '7d');
    expect(detail.latency.points[0]?.responseMs).toBe(140);
  });

  it('preserves the existing public status page response fields', () => {
    const page = statusPageSnapshotToPage(statusPageSnapshot);
    expect(page.groups[0]?.monitors[0]?.affectedRegionIds).toEqual(['eu-west']);
    expect(page.groups[0]?.showBadges).toBe(true);
  });

  it('rejects snapshots that are missing required fields', () => {
    expect(() =>
      monitorSnapshotToDetail({ ...monitorSnapshot, summary: undefined as never }),
    ).toThrow(/missing the required/);
    expect(() =>
      statusPageSnapshotToPage({ ...statusPageSnapshot, statusPage: undefined as never }),
    ).toThrow(/missing the required/);
  });
});

describe('freshness assessment', () => {
  it('marks a snapshot fresh within the stale window', () => {
    const assessment = assessFreshness(monitorSnapshot, new Date('2026-09-20T12:02:00.000Z'));
    expect(assessment.state).toBe('fresh');
    expect(assessment.ageSeconds).toBe(120);
  });

  it('marks a snapshot stale beyond generatedAt + staleAfterSeconds', () => {
    const assessment = assessFreshness(monitorSnapshot, new Date('2026-09-20T12:05:00.000Z'));
    expect(assessment.state).toBe('stale');
    expect(assessment.detail).toContain('stale after');
  });

  it('reports unknown when freshness metadata is absent', () => {
    const assessment = assessFreshness({
      generatedAt: null,
      latestObservationAt: null,
      staleAfterSeconds: null,
    });
    expect(assessment.state).toBe('unknown');
  });

  it('reports unknown when the stale window is not published', () => {
    const assessment = assessFreshness({
      generatedAt: '2026-09-20T12:00:00.000Z',
      latestObservationAt: null,
      staleAfterSeconds: null,
    });
    expect(assessment.state).toBe('unknown');
  });

  it('formats ages for the UI', () => {
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(600)).toBe('10m');
    expect(formatAge(7_200)).toBe('2h');
    expect(formatAge(172_800)).toBe('2d');
  });
});

describe('latency sampling assessment', () => {
  it('flags a bounded sample with its limit and computed age', () => {
    const assessment = assessLatencySampling(
      { sampled: true, sampleLimit: 5_000, computedAt: '2026-09-20T11:58:00.000Z' },
      new Date('2026-09-20T12:00:00.000Z'),
    );
    expect(assessment).toEqual({
      sampled: true,
      sampleLimit: 5_000,
      computedAt: '2026-09-20T11:58:00.000Z',
      computedAgeSeconds: 120,
    });
  });

  it('does not treat missing or false metadata as sampled', () => {
    expect(assessLatencySampling({})).toMatchObject({
      sampled: false,
      sampleLimit: null,
      computedAt: null,
      computedAgeSeconds: null,
    });
    expect(assessLatencySampling({ sampled: false, sampleLimit: 5_000 })).toMatchObject({
      sampled: false,
      sampleLimit: 5_000,
    });
  });

  it('reports no computed age for an unreadable timestamp', () => {
    expect(assessLatencySampling({ computedAt: 'not-a-date' }).computedAgeSeconds).toBeNull();
  });
});
