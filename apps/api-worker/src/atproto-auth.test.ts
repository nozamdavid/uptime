import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createAtprotoAuth,
  withPostgresLease,
  type AtprotoAuthConfig,
  type AtprotoClientLike,
  workersOAuthRuntime,
} from './atproto-auth.js';
import type { RuntimeImplementation } from '@atproto/oauth-client';
import { WebcryptoKey } from '@atproto/jwk-webcrypto';
import { type Database, pgFirst } from '@uptime/cloudflare/postgres';
import { createControlFixture, type ControlTestFixture } from './testing/control-fixture.js';

let fixture: ControlTestFixture;

beforeAll(async () => {
  fixture = await createControlFixture();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

describe('AT Protocol OAuth authentication', { timeout: 60_000 }, () => {
  it('returns failed interest authorization to its retry page', async () => {
    const fake = fakeClient();
    fake.client.callback = async () => {
      throw new Error('Authorization denied');
    };
    const auth = createAuth(fixture.db, fake.client, { successPath: '/app', failurePath: '/' });
    const response = await auth.callback(
      new Request('https://api.example.com/api/auth/atproto/callback'),
    );
    expect(response.headers.get('location')).toBe('/?auth_error=atproto');
  });

  it('publishes official SDK metadata for the Worker callback', async () => {
    const metadata = (await createSdkAuth(fixture.db).metadata().json()) as {
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
    const metadata = (await createSdkAuth(fixture.db, {
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
    const auth = createAuth(fixture.db, fake.client);
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

    const stored = await pgFirst<{ token_hash: string }>(
      fixture.db,
      `SELECT token_hash FROM ${fixture.db.table('atproto_login_sessions')} WHERE did = $1`,
      ['did:plc:alice'],
    );
    expect(stored?.token_hash).toBeDefined();
    expect(stored?.token_hash).not.toBe(sessionCookie);
  });

  it('deletes the stored OAuth token set on logout even when revocation fails', async () => {
    const fake = fakeClient();
    fake.client.revoke = vi.fn().mockRejectedValue(new Error('revocation unavailable'));
    const auth = createAuth(fixture.db, fake.client);
    const start = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'alice.bsky.social' }),
      }),
    );
    const callback = await auth.callback(
      new Request('https://api.example.com/api/auth/atproto/callback', {
        headers: { cookie: `uptime_atproto_login=${cookieValue(start.headers.get('set-cookie'))}` },
      }),
    );
    const sessionCookie = cookieValue(
      callback.headers.get('set-cookie')?.split(', ').at(-1) ?? null,
    );
    await fixture.db.query(
      `INSERT INTO ${fixture.db.table('atproto_oauth_sessions')} (did, encrypted_payload, updated_at)
       VALUES ($1, $2, $3)`,
      ['did:plc:alice', 'encrypted-token-set', new Date().toISOString()],
    );
    const request = new Request('https://api.example.com/api/auth/logout', {
      headers: { cookie: `uptime_atproto_session=${sessionCookie}` },
    });
    expect((await auth.logout(request)).status).toBe(204);
    expect(fake.client.revoke).toHaveBeenCalledWith('did:plc:alice');
    expect(await auth.principal(request)).toBeNull();
    expect(
      await pgFirst(
        fixture.db,
        `SELECT did FROM ${fixture.db.table('atproto_oauth_sessions')} WHERE did = $1`,
        ['did:plc:alice'],
      ),
    ).toBeNull();
  });

  it('prunes expired and orphaned OAuth token sets while retaining active sessions', async () => {
    const timestamp = new Date().toISOString();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    for (const name of ['expired', 'orphaned', 'active']) {
      await fixture.db.query(
        `INSERT INTO ${fixture.db.table('atproto_oauth_sessions')} (did, encrypted_payload, updated_at)
         VALUES ($1, $2, $3)`,
        [`did:plc:prune-${name}`, 'encrypted-token-set', timestamp],
      );
    }
    for (const [name, expiresAt] of [
      ['expired', expired],
      ['active', future],
      ['active', expired],
    ]) {
      await fixture.db.query(
        `INSERT INTO ${fixture.db.table('atproto_login_sessions')}
         (token_hash, did, handle, expires_at, created_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [
          `prune-${name}-${expiresAt}`,
          `did:plc:prune-${name}`,
          'alice.bsky.social',
          expiresAt,
          timestamp,
        ],
      );
    }
    await createAuth(fixture.db, fakeClient().client).prune();
    const remaining = await fixture.db.query<{ did: string }>(
      `SELECT did FROM ${fixture.db.table('atproto_oauth_sessions')} WHERE did LIKE $1`,
      ['did:plc:prune-%'],
    );
    expect(remaining.rows).toEqual([{ did: 'did:plc:prune-active' }]);
  });

  it('rejects a missing or tampered browser binding before it creates a session', async () => {
    const fake = fakeClient();
    const auth = createAuth(fixture.db, fake.client);
    await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'tamper.bsky.social' }),
      }),
    );
    const response = await auth.callback(
      new Request('https://api.example.com/api/auth/atproto/callback', {
        headers: { cookie: 'uptime_atproto_login=attacker-token' },
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/?auth_error=atproto');
    const row = await pgFirst<{ count: string | number }>(
      fixture.db,
      `SELECT count(*) AS count FROM ${fixture.db.table('atproto_login_sessions')} WHERE handle = $1`,
      ['tamper.bsky.social'],
    );
    expect(Number(row?.count ?? 0)).toBe(0);
  });

  it('does not accept an OAuth callback twice', async () => {
    const fake = fakeClient();
    const auth = createAuth(fixture.db, fake.client);
    const start = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle: 'twice.bsky.social' }),
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
      fixture.db,
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
    const auth = createAuth(fixture.db, fake.client);
    const start = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({
          handle: 'external.bsky.social',
          returnTo: 'https://attacker.example',
        }),
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
    const generated = await workersOAuthRuntime.createKey(['ES256']);
    expect(generated.privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256', d: expect.any(String) });
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
      fixture.db,
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

    const stored = await pgFirst<{ encrypted_payload: string }>(
      fixture.db,
      `SELECT encrypted_payload FROM ${fixture.db.table('atproto_oauth_states')}`,
    );
    expect(stored?.encrypted_payload).toBeDefined();
    expect(stored?.encrypted_payload).not.toContain('alice.bsky.social');

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

    const sessionCount = await pgFirst<{ count: string | number }>(
      fixture.db,
      `SELECT count(*) AS count FROM ${fixture.db.table('atproto_oauth_sessions')} WHERE did = $1`,
      [testDid],
    );
    expect(Number(sessionCount?.count ?? 0)).toBe(1);
  });

  describe('PostgreSQL lease claim/release token fencing under concurrency', () => {
    it('serializes concurrent contenders and prevents overlapping execution', async () => {
      const conn2 = await fixture.openConnection();
      const lockName = 'session-mutex-test';
      const events: string[] = [];

      const contender1 = withPostgresLease(fixture.db, lockName, async () => {
        events.push('start:1');
        await new Promise((resolve) => setTimeout(resolve, 100));
        events.push('end:1');
        return 1;
      });

      // Small delay to ensure contender1 claims first
      await new Promise((resolve) => setTimeout(resolve, 20));

      const contender2 = withPostgresLease(conn2, lockName, async () => {
        events.push('start:2');
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push('end:2');
        return 2;
      });

      const [res1, res2] = await Promise.all([contender1, contender2]);
      expect(res1).toBe(1);
      expect(res2).toBe(2);

      // Must be completely serialized: 1 starts, 1 ends, then 2 starts, 2 ends
      expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
    });

    it('fences expired lease token so late releaser does not delete newer active lease', async () => {
      const lockName = 'fence-token-test';
      const expiredPastIso = new Date(Date.now() - 60_000).toISOString();

      // Seed an expired lease with an old token
      await fixture.db.query(
        `INSERT INTO ${fixture.db.table('atproto_oauth_locks')} (name, token, lease_until)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET token = EXCLUDED.token, lease_until = EXCLUDED.lease_until`,
        [lockName, 'old-stale-token', expiredPastIso],
      );

      // Contender claims the expired lease with a new token
      let activeTokenInAction: string | null = null;
      await withPostgresLease(fixture.db, lockName, async () => {
        // While active, read the current token
        const row = await pgFirst<{ token: string }>(
          fixture.db,
          `SELECT token FROM ${fixture.db.table('atproto_oauth_locks')} WHERE name = $1`,
          [lockName],
        );
        activeTokenInAction = row?.token ?? null;
        expect(activeTokenInAction).not.toBe('old-stale-token');

        // Late releaser tries to delete using the OLD token
        await fixture.db.query(
          `DELETE FROM ${fixture.db.table('atproto_oauth_locks')} WHERE name = $1 AND token = $2`,
          [lockName, 'old-stale-token'],
        );

        // Active lease must NOT be deleted because token fencing protected it!
        const stillActive = await pgFirst<{ token: string }>(
          fixture.db,
          `SELECT token FROM ${fixture.db.table('atproto_oauth_locks')} WHERE name = $1`,
          [lockName],
        );
        expect(stillActive?.token).toBe(activeTokenInAction);
      });

      // After normal release with matching token, lock is cleared
      const afterRelease = await pgFirst<{ token: string }>(
        fixture.db,
        `SELECT token FROM ${fixture.db.table('atproto_oauth_locks')} WHERE name = $1`,
        [lockName],
      );
      expect(afterRelease).toBeNull();
    });
  });
});

function createAuth(
  db: Database,
  client: AtprotoClientLike,
  overrides: Partial<AtprotoAuthConfig> = {},
  log?: { warn(bindings: Record<string, unknown>, message: string): void },
) {
  return createAtprotoAuth({
    db,
    config: { ...config(), ...overrides },
    createClient: () => client,
    ...(log ? { log } : {}),
  });
}

function createSdkAuth(
  db: Database,
  overrides: Partial<AtprotoAuthConfig> = {},
  oauthFetch?: typeof fetch,
  log?: { warn(bindings: Record<string, unknown>, message: string): void },
  oauthRuntime?: RuntimeImplementation,
) {
  return createAtprotoAuth({
    db,
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
