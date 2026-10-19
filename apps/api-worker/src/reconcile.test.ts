import { afterEach, describe, expect, it, vi } from 'vitest';

import { workerFetch } from './reconcile.js';

afterEach(() => vi.unstubAllGlobals());

describe('workerFetch', () => {
  it('wraps host fetch so property invocation cannot supply an illegal receiver', async () => {
    const fetchSpy = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const receiverSensitiveFetch = fetchSpy as unknown as typeof fetch;
    vi.stubGlobal('fetch', receiverSensitiveFetch);

    const unsafe = { fetchImpl: receiverSensitiveFetch };
    expect(() => unsafe.fetchImpl('https://hooks.example.test')).toThrow('Illegal invocation');
    fetchSpy.mockClear();

    const safe = { fetchImpl: workerFetch };
    const response = await safe.fetchImpl('https://hooks.example.test');
    expect(response.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
