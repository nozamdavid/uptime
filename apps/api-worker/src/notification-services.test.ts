import { afterEach, describe, expect, it, vi } from 'vitest';

import { openProviderConfig, sealProviderConfig } from './credentials.js';
import { createTestContext, login, request, type TestContext } from './testing/test-utils.js';

const contexts: TestContext[] = [];
const json = (response: Response): Promise<any> => response.json();

async function context(options: Parameters<typeof createTestContext>[0] = {}) {
  const ctx = await createTestContext(options);
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
  vi.restoreAllMocks();
});

const telegram = {
  name: 'Operations Telegram',
  provider: 'telegram',
  enabled: true,
  config: { botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '-100123456' },
};

describe('credential encryption', () => {
  it('round-trips a provider config through AES-GCM', async () => {
    const secret = 'c'.repeat(32);
    const sealed = await sealProviderConfig(secret, telegram.config);
    expect(sealed).toContain('encrypted');
    expect(sealed).not.toContain('abcdefghijklmnopqrstuvwxyz');
    const { config, encrypted } = await openProviderConfig(secret, sealed);
    expect(encrypted).toBe(true);
    expect(config).toEqual(telegram.config);
  });

  it('rejects a tampered envelope', async () => {
    const secret = 'c'.repeat(32);
    const sealed = await sealProviderConfig(secret, telegram.config);
    const tampered = sealed.replace(/"encrypted":"v1\.[A-Za-z0-9_-]{4}/, '"encrypted":"v1.AAAA');
    await expect(openProviderConfig(secret, tampered)).rejects.toThrow();
  });

  it('rejects decryption with the wrong secret', async () => {
    const sealed = await sealProviderConfig('a'.repeat(32), telegram.config);
    await expect(openProviderConfig('b'.repeat(32), sealed)).rejects.toThrow();
  });
});

describe('notification services contract', () => {
  it('requires authentication', async () => {
    const { app } = await context();
    const response = await request(app, '/api/notification-services');
    expect(response.status).toBe(401);
  });

  it('creates a service and stores credentials encrypted at rest', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify(telegram),
    });
    expect(response.status).toBe(201);
    const service = (await json(response)).service;
    expect(service.config).toEqual({ chatId: '-100123456' });
    expect(JSON.stringify(service)).not.toContain('botToken');
    expect(JSON.stringify(service)).not.toContain('abcdefghijklmnopqrstuvwxyz');

    const stored = ctx.sqlite.prepare('SELECT config FROM notification_services').get() as {
      config: string;
    };
    expect(stored.config).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(stored.config).toContain('encrypted');
  });

  it('lists every provider with secrets redacted', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const providers = [
      telegram,
      {
        name: 'Resend',
        provider: 'resend',
        config: {
          apiKey: 're_secret',
          from: 'a@example.com',
          to: ['b@example.com'],
          subject: 'Alert',
        },
      },
      {
        name: 'Gotify',
        provider: 'gotify',
        config: {
          serverUrl: 'https://push.example.com',
          applicationToken: 'gotify-secret',
          priority: 8,
        },
      },
      {
        name: 'Discord',
        provider: 'discord',
        config: { webhookUrl: 'https://discord.com/api/webhooks/123/secrettoken' },
      },
      {
        name: 'Webhook',
        provider: 'webhook',
        config: { webhookUrl: 'https://hooks.example.com/secret', bearerToken: 'bearer-secret' },
      },
      {
        name: 'SMTP',
        provider: 'smtp',
        config: {
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls',
          username: 'uptime',
          password: 'smtp-secret',
          from: 'a@example.com',
          to: ['b@example.com'],
        },
      },
      {
        name: 'HA',
        provider: 'home-assistant',
        config: { serverUrl: 'http://ha.local:8123', accessToken: 'ha-secret', service: 'notify' },
      },
    ];
    for (const provider of providers) {
      const created = await request(ctx.app, '/api/notification-services', {
        method: 'POST',
        cookie,
        body: JSON.stringify(provider),
      });
      expect(created.status).toBe(201);
    }
    const list = await request(ctx.app, '/api/notification-services', { cookie });
    const body = await list.text();
    for (const secret of [
      'abcdefghijklmnopqrstuvwxyz',
      're_secret',
      'gotify-secret',
      'secrettoken',
      'hooks.example.com',
      'bearer-secret',
      'smtp-secret',
      'ha-secret',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('retains a saved secret when an edit submits a blank secret', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const created = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify(telegram),
    });
    const id = (await json(created)).service.id;
    const updated = await request(ctx.app, `/api/notification-services/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        name: 'Primary Telegram',
        config: { botToken: '', chatId: '-100123456' },
      }),
    });
    expect(updated.status).toBe(200);
    expect((await json(updated)).service.name).toBe('Primary Telegram');

    const stored = ctx.sqlite
      .prepare('SELECT config FROM notification_services WHERE id = ?')
      .get(id) as { config: string };
    const { config } = await openProviderConfig('c'.repeat(32), stored.config);
    expect(config.botToken).toBe(telegram.config.botToken);
  });

  it('stores Bluesky credentials encrypted, redacts them, and keeps a blank edited password', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const appPassword = 'bsky-app-password';
    const created = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Bluesky',
        provider: 'bluesky',
        config: { handle: ' @Ops.Example.com ', appPassword },
      }),
    });
    expect(created.status).toBe(201);
    const service = (await json(created)).service;
    expect(service.config).toEqual({ handle: 'ops.example.com' });
    expect(JSON.stringify(service)).not.toContain(appPassword);
    const id = service.id as string;
    const stored = ctx.sqlite
      .prepare('SELECT config FROM notification_services WHERE id = ?')
      .get(id) as { config: string };
    expect(stored.config).not.toContain(appPassword);
    expect(stored.config).toContain('encrypted');

    const updated = await request(ctx.app, `/api/notification-services/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ config: { handle: 'New.Example.com', appPassword: '' } }),
    });
    expect(updated.status).toBe(200);
    expect((await json(updated)).service.config).toEqual({ handle: 'new.example.com' });
    const saved = ctx.sqlite
      .prepare('SELECT config FROM notification_services WHERE id = ?')
      .get(id) as { config: string };
    const { config } = await openProviderConfig('c'.repeat(32), saved.config);
    expect(config).toEqual({ handle: 'new.example.com', appPassword });
  });

  it('rejects unrelated keys for a provider', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const created = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify(telegram),
    });
    const id = (await json(created)).service.id;
    const response = await request(ctx.app, `/api/notification-services/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ config: { webhookUrl: 'https://x.example.com' } }),
    });
    // strip()/strict provider keys are enforced during merge, not the update schema.
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('validation_error');
  });

  it('rejects invalid provider config without echoing credentials', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const invalid = 'http://example.com/not-a-webhook';
    const response = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Invalid Discord',
        provider: 'discord',
        config: { webhookUrl: invalid },
      }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe('validation_error');
    expect(text).not.toContain(invalid);
  });

  it('deletes a service', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const created = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify(telegram),
    });
    const id = (await json(created)).service.id;
    const deleted = await request(ctx.app, `/api/notification-services/${id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(deleted.status).toBe(204);
    const missing = await request(ctx.app, `/api/notification-services/${id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(missing.status).toBe(404);
  });

  it('sends a test through the configured provider', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const ctx = await context({ notificationFetch: fetchMock });
    const { cookie } = await login(ctx.app);
    const webhookUrl = 'https://discord.com/api/webhooks/123456/secret-token';
    const created = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Discord', provider: 'discord', config: { webhookUrl } }),
    });
    const id = (await json(created)).service.id;
    const response = await request(ctx.app, `/api/notification-services/${id}/test`, {
      method: 'POST',
      cookie,
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${webhookUrl}?wait=true`);
  });

  it('sends a Bluesky test by logging in and creating a post', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ did: 'did:plc:operations' }))
      .mockResolvedValueOnce(
        Response.json({
          id: 'did:plc:operations',
          alsoKnownAs: ['at://ops.example.com'],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://eurosky.social',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          did: 'did:plc:operations',
          accessJwt: 'access-token',
          refreshJwt: 'refresh',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ uri: 'at://did:plc:operations/app.bsky.feed.post/123' }),
      );
    const ctx = await context({ notificationFetch: fetchMock });
    const { cookie } = await login(ctx.app);
    const created = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Bluesky',
        provider: 'bluesky',
        config: { handle: '@ops.example.com', appPassword: 'bsky-secret' },
      }),
    });
    const id = (await json(created)).service.id;
    const response = await request(ctx.app, `/api/notification-services/${id}/test`, {
      method: 'POST',
      cookie,
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=ops.example.com',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://plc.directory/did:plc:operations');
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      'https://eurosky.social/xrpc/com.atproto.server.createSession',
    );
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
      'https://eurosky.social/xrpc/com.atproto.repo.createRecord',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      repo: 'did:plc:operations',
      collection: 'app.bsky.feed.post',
      record: { $type: 'app.bsky.feed.post' },
    });
    const history = ctx.sqlite
      .prepare('SELECT external_url FROM notification_history WHERE notification_service_id = ?')
      .get(id) as { external_url: string | null };
    expect(history.external_url).toBe('https://bsky.app/profile/did:plc:operations/post/123');
  });

  it('documents SMTP as unsupported in the Workers runtime', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const created = await request(ctx.app, '/api/notification-services', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'SMTP',
        provider: 'smtp',
        config: {
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls',
          from: 'a@example.com',
          to: ['b@example.com'],
        },
      }),
    });
    const id = (await json(created)).service.id;
    const response = await request(ctx.app, `/api/notification-services/${id}/test`, {
      method: 'POST',
      cookie,
    });
    expect(response.status).toBe(501);
    expect((await json(response)).error.code).toBe('provider_unsupported');
  });
});
