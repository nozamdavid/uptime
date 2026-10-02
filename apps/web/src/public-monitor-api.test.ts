import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { api, apiUrl } = await import('./api.js');
const { normalizeBaseUrl } = await import('./config.js');

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

describe('api base URL', () => {
  it('defaults to the same-origin /api prefix', () => {
    expect(apiUrl('/monitors')).toBe('/api/monitors');
  });

  it('uses VITE_API_BASE_URL when configured', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://uptime-api.example.com/api');
    expect(apiUrl('/auth/session')).toBe('https://uptime-api.example.com/api/auth/session');
  });

  it('strips trailing slashes from the configured base', () => {
    expect(normalizeBaseUrl('https://uptime-api.example.com/api/')).toBe(
      'https://uptime-api.example.com/api',
    );
  });
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
