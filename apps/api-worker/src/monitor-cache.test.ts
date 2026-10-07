import { describe, expect, it, vi } from 'vitest';
import { MonitorRequestCache } from './monitor-cache.js';

describe('monitor request cache', () => {
  it('expires exactly at 60 seconds and isolates keys and returned objects', async () => {
    const cache = new MonitorRequestCache();
    const load = vi.fn(async () => ({ value: 1 }));
    const first = await cache.get('workspace-a:private:24h', load, 0);
    first.value = 2;
    expect(await cache.get('workspace-a:private:24h', load, 59_999)).toEqual({ value: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('workspace-a:private:24h', load, 60_000);
    await cache.get('workspace-b:private:24h', load, 60_000);
    await cache.get('workspace-a:public:24h', load, 60_000);
    await cache.get('workspace-a:private:7d', load, 60_000);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('does not cache failed retrievals', async () => {
    const cache = new MonitorRequestCache();
    await expect(
      cache.get('key', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    expect(await cache.get('key', async () => 'retried')).toBe('retried');
  });
});
