import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatusPageSave } from '@uptime/contracts';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { api } = await import('./api.js');

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

describe('status page API contract', () => {
  it('updates status page via PUT /api/status-pages/:id', async () => {
    const pageId = '0a752255-f7bd-481b-a98c-4ab298edcf97';
    const payload: StatusPageSave = {
      title: 'Platform Status',
      publicSlug: 'status',
      fontFamily: 'inter',
      groups: [],
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        statusPage: {
          id: pageId,
          ...payload,
          monitorCount: 0,
          createdAt: '2026-10-07T00:00:00.000Z',
          updatedAt: '2026-10-07T00:00:00.000Z',
          groups: [],
        },
      }),
    });

    await api.updateStatusPage(pageId, payload);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/status-pages/${pageId}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    );
  });
});
