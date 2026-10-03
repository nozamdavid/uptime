// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  frontendConfig: () => ({ apiBaseUrl: 'https://uptime-api.example.com/api' }),
}));

const { api, RequestError } = await import('./api.js');

describe('private session expiry signaling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dispatches session expiry for a private 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const expired = vi.fn();
    window.addEventListener('uptime:session-expired', expired);
    await expect(api.monitors()).rejects.toBeInstanceOf(RequestError);
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener('uptime:session-expired', expired);
  });

  it('does not dispatch for auth or public requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const expired = vi.fn();
    window.addEventListener('uptime:session-expired', expired);
    await expect(api.signIn('wrong')).rejects.toBeInstanceOf(RequestError);
    await expect(api.publicMonitor('monitor-1', '24h')).rejects.toBeInstanceOf(RequestError);
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener('uptime:session-expired', expired);
  });
});
