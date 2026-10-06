import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { api } = await import('./api.js');

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

describe('public monitor API', () => {
  it('uses unauthenticated detail, latency and uptime endpoints', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ summary: {} }) });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ summary: {} }) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ points: [], stats: [] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ uptime: { uptimePercentage: null, status: 'unknown', days: [] } }),
    });

    await api.publicMonitor('60127b00-b86d-4e7a-8f43-63edb60b7abf', '24h');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/monitors/public/60127b00-b86d-4e7a-8f43-63edb60b7abf',
      { credentials: 'omit' },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/monitors/public/60127b00-b86d-4e7a-8f43-63edb60b7abf/latency?range=24h',
      { credentials: 'omit' },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/monitors/public/60127b00-b86d-4e7a-8f43-63edb60b7abf/uptime',
      { credentials: 'omit' },
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
