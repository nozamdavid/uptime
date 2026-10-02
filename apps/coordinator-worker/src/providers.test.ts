import { describe, expect, it } from 'vitest';
import { createNotificationProvider, providerTestError } from '@uptime/api-worker/providers';
import { blueskyPostText, notificationPreview } from '@uptime/cloudflare';

import { dispatchNotification } from './providers.js';

const message = {
  kind: 'outage' as const,
  monitorName: 'Storefront',
  monitorUrl: 'https://example.com',
  occurredAt: '2026-09-20T10:00:00.000Z',
  outageStartedAt: '2026-09-20T09:58:00.000Z',
};
const messageText =
  'OUTAGE\nStorefront\nhttps://example.com\nTime: 2026-09-20T10:00:00.000Z\nOutage started: 2026-09-20T09:58:00.000Z';

const cases = [
  {
    provider: 'telegram',
    config: { botToken: '123456:abcdefghijklmnopqrstuvwxyzABCDE', chatId: '12345' },
    url: 'https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyzABCDE/sendMessage',
    headers: { 'content-type': 'application/json' },
    body: {
      chat_id: '12345',
      text: messageText,
      link_preview_options: { is_disabled: true },
    },
  },
  {
    provider: 'discord',
    config: { webhookUrl: 'https://discord.com/api/webhooks/12345/abcDEF_123' },
    url: 'https://discord.com/api/webhooks/12345/abcDEF_123?wait=true',
    headers: { 'content-type': 'application/json' },
    body: {
      content: messageText,
      allowed_mentions: { parse: [] },
    },
  },
  {
    provider: 'resend',
    config: {
      apiKey: 're_secret',
      from: 'uptime@example.com',
      to: ['ops@example.com'],
      subject: 'Service alert',
    },
    url: 'https://api.resend.com/emails',
    headers: { 'content-type': 'application/json', authorization: 'Bearer re_secret' },
    body: {
      from: 'uptime@example.com',
      to: ['ops@example.com'],
      subject: 'Service alert',
      text: messageText,
    },
  },
  {
    provider: 'gotify',
    config: {
      serverUrl: 'https://push.example.com/base///',
      applicationToken: 'secret',
      priority: 0,
    },
    url: 'https://push.example.com/base/message',
    headers: { 'content-type': 'application/json', 'x-gotify-key': 'secret' },
    body: {
      title: 'Uptime',
      message: messageText,
      priority: 0,
    },
  },
  {
    provider: 'webhook',
    config: { webhookUrl: 'https://hooks.example.com/notify', bearerToken: 'hook-secret' },
    url: 'https://hooks.example.com/notify',
    headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' },
    body: {
      ...message,
      text: messageText,
    },
  },
  {
    provider: 'home-assistant',
    config: {
      serverUrl: 'https://ha.example.com///',
      accessToken: 'ha-secret',
      service: 'mobile_app_phone',
    },
    url: 'https://ha.example.com/api/services/notify/mobile_app_phone',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ha-secret' },
    body: {
      title: 'Uptime',
      message: messageText,
    },
  },
] as const;

describe('Worker notification provider requests', () => {
  for (const item of cases) {
    it(`sends the ${item.provider} request consistently`, async () => {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), init: init! });
        return new Response(item.provider === 'telegram' ? '{"ok":true}' : '{}');
      };

      await createNotificationProvider(item.provider, item.config, fetchImpl).send(message);
      await dispatchNotification(item.provider, item.config, message, fetchImpl);

      expect(requests).toHaveLength(2);
      for (const { url, init } of requests) {
        expect(url).toBe(item.url);
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('manual');
        expect(Object.fromEntries(new Headers(init.headers).entries())).toEqual(item.headers);
        expect(init.signal).toBeDefined();
        expect(JSON.parse(String(init.body))).toEqual(item.body);
      }
    });
  }

  it('returns safe Telegram and Discord links from successful delivery metadata', async () => {
    const telegram = await dispatchNotification('telegram', cases[0].config, message, async () =>
      Response.json({
        ok: true,
        result: {
          message_id: 42,
          chat: { type: 'supergroup', username: 'ops_room' },
        },
      }),
    );
    expect(telegram).toEqual({ text: messageText, externalUrl: 'https://t.me/ops_room/42' });

    const privateChat = await dispatchNotification('telegram', cases[0].config, message, async () =>
      Response.json({
        ok: true,
        result: { message_id: 43, chat: { type: 'private', username: 'ops_room' } },
      }),
    );
    expect(privateChat.externalUrl).toBeNull();

    const supergroup = await dispatchNotification('telegram', cases[0].config, message, async () =>
      Response.json({
        ok: true,
        result: { message_id: 44, chat: { type: 'supergroup', id: -100123456 } },
      }),
    );
    expect(supergroup.externalUrl).toBe('https://t.me/c/123456/44');

    const discord = await dispatchNotification('discord', cases[1].config, message, async () =>
      Response.json({ id: '456', channel_id: '123', guild_id: '789' }),
    );
    expect(discord.externalUrl).toBe('https://discord.com/channels/789/123/456');
  });

  it('keeps successful delivery when receipt metadata is malformed and excludes secrets from previews', async () => {
    const receipt = await dispatchNotification('telegram', cases[0].config, message, async () =>
      Response.json({ ok: true, result: { message_id: 'invalid' } }),
    );
    expect(receipt).toEqual({ text: messageText, externalUrl: null });
    const preview = notificationPreview('resend', cases[2].config, message);
    expect(preview).toEqual({
      text: messageText,
      preview: { subject: 'Service alert', from: 'uptime@example.com', to: ['ops@example.com'] },
    });
    expect(JSON.stringify(preview)).not.toContain('re_secret');
  });
  it('classifies retryable responses and hides credential-bearing fetch errors', async () => {
    const rateLimited: typeof fetch = async () =>
      new Response('{"parameters":{"retry_after":12}}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      dispatchNotification('telegram', cases[0].config, message, rateLimited),
    ).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 12 });

    const leakingFetch: typeof fetch = async () => {
      throw new Error('https://api.telegram.org/botsecret/sendMessage failed');
    };
    await expect(
      dispatchNotification('telegram', cases[0].config, message, leakingFetch),
    ).rejects.toMatchObject({
      retryable: true,
      message: 'Notification delivery temporarily failed',
    });
  });

  it('rejects a provider redirect when Workers returns it in manual mode', async () => {
    const redirectingFetch: typeof fetch = async (_input, init) => {
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
      return Response.redirect('https://elsewhere.example.com', 302);
    };
    await expect(
      dispatchNotification('webhook', cases[4].config, message, redirectingFetch),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe('Bluesky notifications', () => {
  const config = { handle: 'alerts.example.com', appPassword: 'aaaa-bbbb-cccc-dddd' };

  function identityResponse(input: RequestInfo | URL): Response | null {
    const url = new URL(String(input));
    if (url.hostname === 'public.api.bsky.app') {
      const handle = url.searchParams.get('handle')!;
      return Response.json({ did: `did:plc:${handle.split('.')[0]!.replace(/-/g, '')}` });
    }
    if (url.hostname === 'plc.directory') {
      const did = url.pathname.slice(1);
      const handle = `${did.slice('did:plc:'.length).replace('apiauth', 'api-auth')}.example.com`;
      return Response.json({
        id: did,
        alsoKnownAs: [`at://${handle}`],
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://bsky.social',
          },
        ],
      });
    }
    return null;
  }

  it('uses Workers-supported manual redirects for discovery and posting', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
      expect(init?.redirect).toBe('manual');
      const identity = identityResponse(input);
      if (identity) return identity;
      return String(input).endsWith('createSession')
        ? Response.json({ did: 'did:plc:redirectmode', accessJwt: 'token' })
        : Response.json({ uri: 'at://did:plc:redirectmode/app.bsky.feed.post/1' });
    };
    const receipt = await dispatchNotification(
      'bluesky',
      { handle: 'redirectmode.example.com', appPassword: config.appPassword },
      message,
      fetchImpl,
    );
    expect(receipt).toEqual({
      text: messageText,
      externalUrl: 'https://bsky.app/profile/did:plc:redirectmode/post/1',
    });
  });

  it('rejects a redirected handle lookup before sending credentials', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe('manual');
      return Response.redirect('https://elsewhere.example.com', 302);
    };
    await expect(
      dispatchNotification(
        'bluesky',
        { handle: 'redirectlookup.example.com', appPassword: config.appPassword },
        message,
        fetchImpl,
      ),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('authenticates and posts at the PDS declared by a custom-handle account', async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle')) {
        return Response.json({ did: 'did:plc:custompds' });
      }
      if (url === 'https://plc.directory/did:plc:custompds') {
        return Response.json({
          id: 'did:plc:custompds',
          alsoKnownAs: ['at://custom.example.com'],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://eurosky.social',
            },
          ],
        });
      }
      if (url === 'https://eurosky.social/xrpc/com.atproto.server.createSession') {
        return Response.json({ did: 'did:plc:custompds', accessJwt: 'custom-token' });
      }
      if (url === 'https://eurosky.social/xrpc/com.atproto.repo.createRecord') {
        return Response.json({ uri: 'at://did:plc:custompds/app.bsky.feed.post/1' });
      }
      return new Response('{}', { status: 401 });
    };

    const receipt = await dispatchNotification(
      'bluesky',
      { handle: 'custom.example.com', appPassword: config.appPassword },
      message,
      fetchImpl,
    );
    expect(receipt.externalUrl).toBe('https://bsky.app/profile/did:plc:custompds/post/1');
    await createNotificationProvider(
      'bluesky',
      { handle: 'custom.example.com', appPassword: config.appPassword },
      fetchImpl,
    ).send(message);
    expect(requests).toEqual([
      'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=custom.example.com',
      'https://plc.directory/did:plc:custompds',
      'https://eurosky.social/xrpc/com.atproto.server.createSession',
      'https://eurosky.social/xrpc/com.atproto.repo.createRecord',
      'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=custom.example.com',
      'https://plc.directory/did:plc:custompds',
      'https://eurosky.social/xrpc/com.atproto.repo.createRecord',
    ]);
  });

  it('discovers a migrated PDS before using a still-valid cached session', async () => {
    const requests: string[] = [];
    let service = 'https://bsky.social';
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('resolveHandle')) return Response.json({ did: 'did:plc:migrating' });
      if (url.startsWith('https://plc.directory/')) {
        return Response.json({
          id: 'did:plc:migrating',
          alsoKnownAs: ['at://migrating.example.com'],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: service,
            },
          ],
        });
      }
      if (url.endsWith('createSession')) {
        return Response.json({ did: 'did:plc:migrating', accessJwt: `${service}-token` });
      }
      return Response.json({ uri: 'at://did:plc:migrating/app.bsky.feed.post/1' });
    };
    const migratingConfig = { handle: 'migrating.example.com', appPassword: config.appPassword };
    await dispatchNotification('bluesky', migratingConfig, message, fetchImpl);
    service = 'https://eurosky.social';
    await dispatchNotification('bluesky', migratingConfig, message, fetchImpl);
    expect(requests.filter((url) => url.endsWith('createSession'))).toEqual([
      'https://bsky.social/xrpc/com.atproto.server.createSession',
      'https://eurosky.social/xrpc/com.atproto.server.createSession',
    ]);
    expect(requests.filter((url) => url.endsWith('createRecord'))).toEqual([
      'https://bsky.social/xrpc/com.atproto.repo.createRecord',
      'https://eurosky.social/xrpc/com.atproto.repo.createRecord',
    ]);
  });

  it('resolves hostname did:web documents and accepts a fully qualified PDS service ID', async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('resolveHandle'))
        return Response.json({ did: 'did:web:identity.example.com' });
      if (url.endsWith('/.well-known/did.json')) {
        return Response.json({
          id: 'did:web:identity.example.com',
          alsoKnownAs: ['https://example.com', 'at://web.example.com'],
          service: [
            {
              id: 'did:web:identity.example.com#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example.com:8443',
            },
          ],
        });
      }
      if (url.endsWith('createSession')) {
        return Response.json({ did: 'did:web:identity.example.com', accessJwt: 'web-token' });
      }
      return Response.json({ uri: 'at://did:web:identity.example.com/app.bsky.feed.post/1' });
    };
    await dispatchNotification(
      'bluesky',
      { handle: 'web.example.com', appPassword: config.appPassword },
      message,
      fetchImpl,
    );
    expect(requests).toEqual([
      'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=web.example.com',
      'https://identity.example.com/.well-known/did.json',
      'https://pds.example.com:8443/xrpc/com.atproto.server.createSession',
      'https://pds.example.com:8443/xrpc/com.atproto.repo.createRecord',
    ]);
  });

  it('rejects untrusted PDS URLs and identities before sending credentials', async () => {
    for (const [name, document, sessionDid] of [
      [
        'private',
        {
          id: 'did:plc:private',
          alsoKnownAs: ['at://private.example.com'],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://127.0.0.1',
            },
          ],
        },
        'did:plc:private',
      ],
      [
        'mismatch',
        {
          id: 'did:plc:mismatch',
          alsoKnownAs: ['at://other.example.com'],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example.com',
            },
          ],
        },
        'did:plc:mismatch',
      ],
      [
        'session',
        {
          id: 'did:plc:session',
          alsoKnownAs: ['at://session.example.com'],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example.com',
            },
          ],
        },
        'did:plc:wrong',
      ],
    ] as const) {
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (url.includes('resolveHandle')) return Response.json({ did: `did:plc:${name}` });
        if (url.startsWith('https://plc.directory/')) return Response.json(document);
        if (url.endsWith('createSession')) {
          expect(JSON.parse(String(init!.body))).toMatchObject({ password: config.appPassword });
          return Response.json({ did: sessionDid, accessJwt: 'token' });
        }
        throw new Error('A post was unexpectedly attempted');
      };
      await expect(
        dispatchNotification(
          'bluesky',
          { handle: `${name}.example.com`, appPassword: config.appPassword },
          message,
          fetchImpl,
        ),
      ).rejects.toMatchObject({ retryable: true });
      expect(requests.some((url) => url.endsWith('createRecord'))).toBe(false);
      if (name !== 'session')
        expect(requests.some((url) => url.endsWith('createSession'))).toBe(false);
    }
  });

  it('logs in, publishes a post, and reuses the session across both adapters', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init: init! });
      const identity = identityResponse(input);
      if (identity) return identity;
      return Response.json(
        url.endsWith('createSession')
          ? { did: 'did:plc:alerts', accessJwt: 'access-token' }
          : { uri: 'at://did:plc:alerts/app.bsky.feed.post/1', cid: 'cid' },
      );
    };

    await createNotificationProvider('bluesky', config, fetchImpl).send(message);
    await dispatchNotification('bluesky', config, message, fetchImpl);

    expect(requests.map(({ url }) => url)).toEqual([
      'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=alerts.example.com',
      'https://plc.directory/did:plc:alerts',
      'https://bsky.social/xrpc/com.atproto.server.createSession',
      'https://bsky.social/xrpc/com.atproto.repo.createRecord',
      'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=alerts.example.com',
      'https://plc.directory/did:plc:alerts',
      'https://bsky.social/xrpc/com.atproto.repo.createRecord',
    ]);
    expect(JSON.parse(String(requests[2]!.init.body))).toEqual({
      identifier: config.handle,
      password: config.appPassword,
    });
    for (const { init } of requests.filter(({ url }) => url.startsWith('https://bsky.social/'))) {
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeDefined();
    }
    for (const { init } of requests.filter(({ url }) => url.endsWith('createRecord'))) {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-token');
      expect(JSON.parse(String(init.body))).toMatchObject({
        repo: 'did:plc:alerts',
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: messageText },
      });
    }
  });

  it('does not reuse a session when credentials change', async () => {
    const credentials: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const identity = identityResponse(input);
      if (identity) return identity;
      if (String(input).endsWith('createSession')) {
        const { password } = JSON.parse(String(init!.body)) as { password: string };
        credentials.push(password);
        return Response.json({ did: 'did:plc:changed', accessJwt: password });
      }
      return Response.json({ uri: 'at://did:plc:changed/app.bsky.feed.post/1' });
    };
    const first = { handle: 'changed.example.com', appPassword: 'aaaa-bbbb-cccc-dddd' };
    const second = { ...first, appPassword: 'eeee-ffff-gggg-hhhh' };
    await dispatchNotification('bluesky', first, message, fetchImpl);
    await dispatchNotification('bluesky', second, message, fetchImpl);
    expect(credentials).toEqual([first.appPassword, second.appPassword]);
  });

  it('shares one login among concurrent sends for the same account', async () => {
    let logins = 0;
    let posts = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const identity = identityResponse(input);
      if (identity) return identity;
      if (String(input).endsWith('createSession')) {
        logins++;
        await Promise.resolve();
        return Response.json({ did: 'did:plc:parallel', accessJwt: 'parallel-token' });
      }
      posts++;
      return Response.json({ uri: 'at://did:plc:parallel/app.bsky.feed.post/1' });
    };
    const parallelConfig = { ...config, handle: 'parallel.example.com' };
    await Promise.all([
      dispatchNotification('bluesky', parallelConfig, message, fetchImpl),
      dispatchNotification('bluesky', parallelConfig, message, fetchImpl),
    ]);
    expect(logins).toBe(1);
    expect(posts).toBe(2);
  });

  it('logs in again once when the cached token expires', async () => {
    const requests: string[] = [];
    let sessions = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      const identity = identityResponse(input);
      if (identity) return identity;
      if (url.endsWith('createSession')) {
        sessions++;
        return Response.json({ did: 'did:plc:expired', accessJwt: `token-${sessions}` });
      }
      return sessions === 1
        ? new Response('{}', { status: 401 })
        : Response.json({ uri: 'at://did:plc:expired/app.bsky.feed.post/1' });
    };
    await dispatchNotification(
      'bluesky',
      { handle: 'expired.example.com', appPassword: config.appPassword },
      message,
      fetchImpl,
    );
    expect(requests).toHaveLength(8);
    expect(sessions).toBe(2);
  });

  it('classifies auth, rate limits, malformed sessions, and redacts network errors', async () => {
    const auth: typeof fetch = async (input) =>
      identityResponse(input) ?? new Response('{}', { status: 401 });
    const rateLimit: typeof fetch = async (input) =>
      identityResponse(input) ??
      new Response('{}', { status: 429, headers: { 'retry-after': '23' } });
    const malformed: typeof fetch = async (input) =>
      identityResponse(input) ?? Response.json({ did: 'did:plc:bad' });
    const network: typeof fetch = async (input) => {
      const identity = identityResponse(input);
      if (identity) return identity;
      throw new Error(`request with ${config.appPassword} failed`);
    };
    await expect(
      dispatchNotification('bluesky', { ...config, handle: 'auth.example.com' }, message, auth),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      dispatchNotification(
        'bluesky',
        { ...config, handle: 'rate.example.com' },
        message,
        rateLimit,
      ),
    ).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 23 });
    await expect(
      dispatchNotification('bluesky', { ...config, handle: 'bad.example.com' }, message, malformed),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      dispatchNotification(
        'bluesky',
        { ...config, handle: 'network.example.com' },
        message,
        network,
      ),
    ).rejects.toMatchObject({
      retryable: true,
      message: 'Notification delivery temporarily failed',
    });
    await expect(
      createNotificationProvider('bluesky', { ...config, handle: 'api.example.com' }, network).send(
        message,
      ),
    ).rejects.toThrow('Bluesky notification test failed');
    await expect(
      createNotificationProvider(
        'bluesky',
        { ...config, handle: 'api-auth.example.com' },
        auth,
      ).send(message),
    ).rejects.toThrow('Bluesky notification test failed');
  });

  it('reports only the failed phase and HTTP status from each Bluesky test step', async () => {
    const cases = [
      { name: 'handle', phase: 'handle lookup', status: 503 },
      { name: 'did', phase: 'did lookup', status: 502 },
      { name: 'pds', phase: 'pds validation' },
      { name: 'login', phase: 'login', status: 401 },
      { name: 'session', phase: 'session validation' },
      { name: 'post', phase: 'post', status: 429 },
    ] as const;
    for (const item of cases) {
      const handle = `phase${item.name}.example.com`;
      const did = `did:plc:phase${item.name}`;
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('resolveHandle')) {
          return item.name === 'handle'
            ? new Response('secret body', { status: item.status })
            : Response.json({ did });
        }
        if (url.startsWith('https://plc.directory/')) {
          if (item.name === 'did') return new Response('secret body', { status: item.status });
          return Response.json({
            id: did,
            alsoKnownAs: [`at://${handle}`],
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint:
                  item.name === 'pds' ? 'http://localhost' : 'https://pds.example.com',
              },
            ],
          });
        }
        if (url.endsWith('createSession')) {
          if (item.name === 'login') return new Response('secret body', { status: 401 });
          return Response.json({
            did: item.name === 'session' ? 'did:plc:wrong' : did,
            accessJwt: 'token',
          });
        }
        return new Response('secret body', { status: 429 });
      };
      let deliveredError: unknown;
      try {
        await createNotificationProvider(
          'bluesky',
          { handle, appPassword: 'private-app-password' },
          fetchImpl,
        ).send(message);
      } catch (error) {
        deliveredError = providerTestError(error);
      }
      expect(deliveredError).toMatchObject({
        status: 502,
        code: 'notification_failed',
        message: `Bluesky test failed during ${item.phase}${'status' in item ? ` (HTTP ${item.status})` : ''}`,
      });
      expect(String(deliveredError)).not.toMatch(
        /private-app-password|secret body|pds\.example\.com/,
      );
    }
  });

  it('preserves alert meaning while respecting post limits and emoji graphemes', () => {
    const text = blueskyPostText({
      ...message,
      monitorName: '👩‍🚀'.repeat(150),
      monitorUrl: `https://example.com/${'界'.repeat(1000)}`,
    });
    expect(text).toContain('OUTAGE');
    expect(text).toContain('Time:');
    expect(text).toContain('Outage started:');
    expect(text).toContain('https://example.com/');
    expect(
      [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length,
    ).toBeLessThanOrEqual(300);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(3000);
    expect(text).not.toContain('\uFFFD');
  });
});
