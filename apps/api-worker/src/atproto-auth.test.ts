import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  atprotoAuthSchema,
  createAtprotoAuth,
  type AtprotoAuthConfig,
  type AtprotoClientLike,
  workersOAuthRuntime,
} from './atproto-auth.js';
import type { RuntimeImplementation } from '@atproto/oauth-client';
import { WebcryptoKey } from '@atproto/jwk-webcrypto';
import { createD1Adapter, createTestDatabase } from '@uptime/cloudflare/testing';

const databases: ReturnType<typeof createTestDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('AT Protocol OAuth authentication', () => {
  it('returns failed interest authorization to its retry page', async () => {
    const fake = fakeClient();
    fake.client.callback = async () => {
      throw new Error('Authorization denied');
    };
    const auth = createAuth(fake.client, { successPath: '/app', failurePath: '/' });
    const response = await auth.callback(
      new Request('https://api.example.com/api/auth/atproto/callback'),
    );
    expect(response.headers.get('location')).toBe('/?auth_error=atproto');
  });

  it('publishes official SDK metadata for the Worker callback', async () => {
    const metadata = (await createSdkAuth().metadata().json()) as {
      client_id: string;
      redirect_uris: string[];
      scope: string;
    };
    expect(metadata).toMatchObject({
      client_id: 'https://api.example.com/oauth/client-metadata.json',
      redirect_uris: ['https://api.example.com/api/auth/atproto/callback'],
      scope: 'atproto',
    });
  });

  it('uses official virtual localhost metadata for a loopback development callback', async () => {
    const metadata = (await createSdkAuth({
      publicOrigin: 'http://127.0.0.1:5176',
      cookieSecure: false,
      allowLocalHttp: true,
    })
      .metadata()
      .json()) as {
      client_id: string;
      redirect_uris: string[];
      application_type: string;
      scope: string;
    };
    expect(metadata).toMatchObject({
      client_id:
        'http://localhost/?redirect_uri=http%3A%2F%2F127.0.0.1%3A5176%2Fapi%2Fauth%2Fatproto%2Fcallback&scope=atproto',
      redirect_uris: ['http://127.0.0.1:5176/api/auth/atproto/callback'],
      application_type: 'native',
      scope: 'atproto',
    });
  });

  it('binds the callback to the initiating browser and creates a hashed local session', async () => {
    const fake = fakeClient();
    const auth = createAuth(fake.client);
    const start = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'alice.bsky.social', returnTo: '/monitors?new=1' }),
      }),
    );
    const loginCookie = cookieValue(start.headers.get('set-cookie'));
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ authorizationUrl: 'https://auth.example/authorize' });

    const callback = await auth.callback(
      new Request('https://api.example.com/api/auth/atproto/callback?code=ok&state=ignored', {
        headers: { cookie: `uptime_atproto_login=${loginCookie}` },
      }),
    );
    const sessionCookie = cookieValue(
      callback.headers.get('set-cookie')?.split(', ').at(-1) ?? null,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/monitors?new=1');
    expect(
      await auth.principal(
        new Request('https://api.example.com/', {
          headers: { cookie: `uptime_atproto_session=${sessionCookie}` },
        }),
      ),
    ).toEqual({
      did: 'did:plc:alice',
      handle: 'alice.bsky.social',
    });

    const database = databases[0]!;
    const stored = database.prepare('SELECT token_hash FROM atproto_login_sessions').get() as {
      token_hash: string;
    };
    expect(stored.token_hash).not.toBe(sessionCookie);
  });

  it('rejects a missing or tampered browser binding before it creates a session', async () => {
    const fake = fakeClient();
    const auth = createAuth(fake.client);
    await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'alice.bsky.social' }),
      }),
    );
    const response = await auth.callback(
      new Request('https://api.example.com/api/auth/atproto/callback', {
        headers: { cookie: 'uptime_atproto_login=attacker-token' },
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/?auth_error=atproto');
    const database = databases[0]!;
    expect(database.prepare('SELECT count(*) AS count FROM atproto_login_sessions').get()).toEqual({
      count: 0,
    });
  });

  it('does not accept an OAuth callback twice', async () => {
    const fake = fakeClient();
    const auth = createAuth(fake.client);
    const start = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'alice.bsky.social' }),
      }),
    );
    const cookie = cookieValue(start.headers.get('set-cookie'));
    const request = () =>
      new Request('https://api.example.com/api/auth/atproto/callback', {
        headers: { cookie: `uptime_atproto_login=${cookie}` },
      });
    expect((await auth.callback(request())).status).toBe(303);
    expect((await auth.callback(request())).headers.get('location')).toBe('/?auth_error=atproto');
  });

  it('writes a redacted callback diagnostic only during local development', async () => {
    const fake = fakeClient();
    fake.client.callback = async () => {
      const error = new Error(
        'token exchange at https://auth.example/token failed for abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
      );
      Object.assign(error, { code: 'invalid_grant' });
      throw error;
    };
    const logs: Record<string, unknown>[] = [];
    const auth = createAuth(
      fake.client,
      { publicOrigin: 'http://127.0.0.1:5176', cookieSecure: false, allowLocalHttp: true },
      { warn: (bindings) => logs.push(bindings) },
    );
    const response = await auth.callback(
      new Request('http://127.0.0.1:5176/api/auth/atproto/callback?code=opaque'),
    );
    expect(response.headers.get('location')).toBe('/?auth_error=atproto');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'atproto_callback_failed',
      name: 'Error',
      code: 'invalid_grant',
    });
    expect(String(logs[0]?.diagnostic)).not.toContain('https://auth.example');
    expect(String(logs[0]?.diagnostic)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('never redirects OAuth callbacks to an external return path', async () => {
    const fake = fakeClient();
    const auth = createAuth(fake.client);
    const start = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'alice.bsky.social', returnTo: 'https://attacker.example' }),
      }),
    );
    const cookie = cookieValue(start.headers.get('set-cookie'));
    const callback = await auth.callback(
      new Request('https://api.example.com/api/auth/atproto/callback', {
        headers: { cookie: `uptime_atproto_login=${cookie}` },
      }),
    );
    expect(callback.headers.get('location')).toBe('/');
  });

  it('uses WebCrypto digest names accepted by Workers', async () => {
    const data = new TextEncoder().encode('pkce-digest');
    const digest = await workersOAuthRuntime.digest(data, { name: 'sha256' });
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    expect(digest).toEqual(expected);
  });

  it('generates an extractable DPoP key so its private JWK survives the callback', async () => {
    const generated = {} as WebcryptoKey;
    const spy = vi.spyOn(WebcryptoKey, 'generate').mockResolvedValue(generated);
    await expect(workersOAuthRuntime.createKey(['ES256'])).resolves.toBe(generated);
    expect(spy).toHaveBeenCalledWith(['ES256'], undefined, { extractable: true });
    spy.mockRestore();
  });

  it('runs SDK handle discovery, DPoP key creation, PKCE, encrypted state persistence, and PAR', async () => {
    const requests: string[] = [];
    let authorizationState: string | null = null;
    let failure: Record<string, unknown> | undefined;
    let createdDpopKey = false;
    const oauthRuntime: RuntimeImplementation = {
      ...workersOAuthRuntime,
      async createKey() {
        createdDpopKey = true;
        return WebcryptoKey.fromJWK(testDpopJwk);
      },
    };
    const auth = createSdkAuth(
      { allowLocalHttp: true },
      async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        requests.push(url.toString());
        if (url.hostname === 'public.api.bsky.app') return json({ did: testDid });
        if (url.hostname === 'plc.directory') {
          return json({
            id: testDid,
            alsoKnownAs: ['at://alice.bsky.social'],
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          });
        }
        if (url.toString() === 'https://pds.example/.well-known/oauth-protected-resource') {
          return json({
            resource: 'https://pds.example',
            authorization_servers: ['https://auth.example'],
          });
        }
        if (url.toString() === 'https://auth.example/.well-known/oauth-authorization-server') {
          return json({
            issuer: 'https://auth.example',
            authorization_endpoint: 'https://auth.example/authorize',
            token_endpoint: 'https://auth.example/token',
            pushed_authorization_request_endpoint: 'https://auth.example/par',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            client_id_metadata_document_supported: true,
            dpop_signing_alg_values_supported: ['ES256'],
            code_challenge_methods_supported: ['S256'],
          });
        }
        if (url.toString() === 'https://auth.example/par') {
          if (!(input instanceof Request)) throw new Error('PAR did not receive a Request');
          authorizationState = new URLSearchParams(await input.clone().text()).get('state');
          return json({ request_uri: 'urn:test:request', expires_in: 60 });
        }
        if (url.toString() === 'https://auth.example/token') {
          return json({
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            token_type: 'DPoP',
            scope: 'atproto',
            sub: testDid,
          });
        }
        throw new Error(`Unexpected OAuth request ${url.origin}${url.pathname}`);
      },
      {
        warn: (bindings) => {
          failure = bindings;
        },
      },
      oauthRuntime,
    );
    const response = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'alice.bsky.social' }),
      }),
    );
    expect(response.status, JSON.stringify(failure)).toBe(200);
    const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
    const authorize = new URL(authorizationUrl);
    expect(authorize.origin).toBe('https://auth.example');
    expect(authorize.searchParams.get('request_uri')).toBe('urn:test:request');
    expect(requests).toContain('https://auth.example/par');
    expect(createdDpopKey).toBe(true);
    const database = databases.at(-1)!;
    const stored = database.prepare('SELECT encrypted_payload FROM atproto_oauth_states').get() as {
      encrypted_payload: string;
    };
    expect(stored.encrypted_payload).not.toContain('alice.bsky.social');
    const cookie = cookieValue(response.headers.get('set-cookie'));
    const callback = await auth.callback(
      new Request(
        `https://api.example.com/api/auth/atproto/callback?code=test-code&state=${encodeURIComponent(authorizationState!)}&iss=https%3A%2F%2Fauth.example`,
        {
          headers: { cookie: `uptime_atproto_login=${cookie}` },
        },
      ),
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/');
    expect(database.prepare('SELECT count(*) AS count FROM atproto_oauth_sessions').get()).toEqual({
      count: 1,
    });
  });
});

function createAuth(
  client: AtprotoClientLike,
  overrides: Partial<AtprotoAuthConfig> = {},
  log?: { warn(bindings: Record<string, unknown>, message: string): void },
) {
  const database = createTestDatabase();
  databases.push(database);
  database.exec(atprotoAuthSchema);
  return createAtprotoAuth({
    db: createD1Adapter(database),
    config: { ...config(), ...overrides },
    createClient: () => client,
    ...(log ? { log } : {}),
  });
}

function createSdkAuth(
  overrides: Partial<AtprotoAuthConfig> = {},
  oauthFetch?: typeof fetch,
  log?: { warn(bindings: Record<string, unknown>, message: string): void },
  oauthRuntime?: RuntimeImplementation,
) {
  const database = createTestDatabase();
  databases.push(database);
  database.exec(atprotoAuthSchema);
  return createAtprotoAuth({
    db: createD1Adapter(database),
    config: { ...config(), ...overrides },
    ...(oauthFetch ? { oauthFetch } : {}),
    ...(log ? { log } : {}),
    ...(oauthRuntime ? { oauthRuntime } : {}),
  });
}

const testDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const testDpopJwk = {
  kty: 'EC',
  crv: 'P-256',
  alg: 'ES256',
  key_ops: ['sign'],
  x: '_eckD1PO99EDX13zQKlmqH9KirmlW-NPxdqe7uPOZe4',
  y: 'zSeJHT2SHQUDjq4YU5Q0AO4F4cW4qbwmBrRu988_JmE',
  d: 'i13euF-OLnTDKRjoP4cJTSG3puF6wrELQuCMmR26tm8',
} as const;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function config() {
  return {
    publicOrigin: 'https://api.example.com',
    sessionSecret: 's'.repeat(32),
    oauthStorageSecret: 'k'.repeat(32),
    sessionTtlSeconds: 60 * 60,
    cookieSecure: true,
  };
}

function fakeClient(): { client: AtprotoClientLike } {
  let state: string | null = null;
  let used = false;
  return {
    client: {
      clientMetadata: {},
      jwks: { keys: [] },
      async authorize(_handle, options) {
        state = options.state;
        return new URL('https://auth.example/authorize');
      },
      async callback() {
        if (used || !state) throw new Error('authorization state was already consumed');
        used = true;
        return { session: { did: 'did:plc:alice' }, state };
      },
    },
  };
}

function cookieValue(header: string | null): string {
  if (!header) throw new Error('Cookie was not set');
  const match = /^[^=]+=([^;]+)/.exec(header);
  if (!match) throw new Error('Cookie has no value');
  return match[1]!;
}
