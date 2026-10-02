/**
 * AT Protocol OAuth for a Cloudflare Worker.
 *
 * This uses the portable official OAuth client. Do not replace it with
 * `@atproto/oauth-client-node`: that package imports Node crypto and the Node
 * DNS handle resolver, neither of which is an appropriate Workers dependency.
 */
import {
  OAuthClient,
  type InternalStateData,
  type OAuthClientMetadataInput,
  type OAuthClientOptions,
  type RuntimeImplementation,
  type Session,
  type SessionStore,
  type StateStore,
} from '@atproto/oauth-client';
import type { Key } from '@atproto/oauth-client';
import { WebcryptoKey } from '@atproto/jwk-webcrypto';
import {
  first,
  hashSessionToken,
  randomToken,
  run,
  base64UrlDecode,
  base64UrlEncode,
  type D1Database,
} from '@uptime/cloudflare';
import { isForbiddenIpLiteral } from '@uptime/contracts';

import { clearCookie, parseCookies, serializeCookie } from './http.js';

const STATE_COOKIE = 'uptime_atproto_login';
const SESSION_COOKIE = 'uptime_atproto_session';
const STATE_TTL_SECONDS = 10 * 60;
const MAX_HANDLE_LENGTH = 253;
const MAX_DISCOVERY_RESPONSE_BYTES = 128 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Apply this to the control-plane D1 database. OAuth state and token sets are
 * encrypted before storage. Browser session credentials are only stored as
 * HMAC hashes.
 */
export const atprotoAuthSchema = `
CREATE TABLE IF NOT EXISTS atproto_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  encrypted_payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atproto_oauth_states_expires_idx
  ON atproto_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS atproto_oauth_sessions (
  did TEXT PRIMARY KEY NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS atproto_oauth_locks (
  name TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atproto_oauth_locks_lease_idx
  ON atproto_oauth_locks (lease_until);

CREATE TABLE IF NOT EXISTS atproto_login_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  did TEXT NOT NULL,
  handle TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atproto_login_sessions_expires_idx
  ON atproto_login_sessions (expires_at);
`;

export interface AtprotoAuthConfig {
  /** Public canonical API origin, never an internal Worker URL. */
  publicOrigin: string;
  sessionSecret: string;
  /** Independent 32+ character secret used only to encrypt D1 OAuth records. */
  oauthStorageSecret: string;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  /** Local path where the browser lands after a successful login. */
  successPath?: string;
  /** Local HTTP metadata is permitted only for Workers development. */
  allowLocalHttp?: boolean;
}

export interface AtprotoPrincipal {
  did: string;
  handle: string;
}

export interface AtprotoClientLike {
  clientMetadata: unknown;
  jwks: unknown;
  authorize(handle: string, options: { state: string; scope: string }): Promise<URL>;
  callback(params: URLSearchParams): Promise<{ session: { did: string }; state: string | null }>;
  revoke?(did: string): Promise<void>;
}

export interface AtprotoAuthDependencies {
  db: D1Database;
  config: AtprotoAuthConfig;
  now?: () => Date;
  /** Inject a fake client in tests. Production uses createAtprotoOAuthClient. */
  createClient?: () => AtprotoClientLike;
  /** Test-only transport hook for exercising SDK discovery without network I/O. */
  oauthFetch?: typeof fetch;
  /** Test-only runtime hook. Production always uses Workers WebCrypto. */
  oauthRuntime?: RuntimeImplementation;
  log?: { warn(bindings: Record<string, unknown>, message: string): void };
}

interface LoginSessionRow {
  did: string;
  handle: string;
}

interface StateRow {
  encrypted_payload: string;
}

/** Keep SDK-internal JWK implementation types out of this package's public API. */
interface OAuthStores {
  db: D1Database;
  stateStore: StateStore;
  sessionStore: SessionStore;
}

type StoredState = Omit<InternalStateData, 'dpopKey'> & {
  dpopJwk: Readonly<Record<string, unknown>>;
};
type StoredSession = Omit<Session, 'dpopKey'> & { dpopJwk: Readonly<Record<string, unknown>> };

/**
 * Routes supplied to the API router:
 * POST /api/auth/atproto/start { handle, returnTo? }
 * GET  /api/auth/atproto/callback
 * GET  /oauth/client-metadata.json
 * GET  /oauth/jwks.json
 */
export function createAtprotoAuth(dependencies: AtprotoAuthDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const config = validateConfig(dependencies.config);
  const stores = createOAuthStores(dependencies.db, config, now);
  const client =
    dependencies.createClient?.() ??
    createAtprotoOAuthClient(config, stores, dependencies.oauthFetch, dependencies.oauthRuntime);

  return {
    metadata: (): Response => immutableJson(client.clientMetadata),
    jwks: (): Response => immutableJson(client.jwks),

    async start(request: Request): Promise<Response> {
      const body = await request.json().catch(() => null);
      let handle: string;
      try {
        handle = normalizeHandle(
          typeof body === 'object' && body !== null
            ? (body as { handle?: unknown }).handle
            : undefined,
        );
      } catch {
        return new Response(
          JSON.stringify({
            error: { code: 'invalid_handle', message: 'A valid AT Protocol handle is required' },
          }),
          {
            status: 400,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        );
      }
      const returnTo = localReturnPath(
        typeof body === 'object' && body !== null
          ? (body as { returnTo?: unknown }).returnTo
          : undefined,
        config.successPath,
      );
      const binding = randomToken(32);
      // The SDK persists this value with the authorization state. It binds the
      // callback to the browser that started the login and carries no secret.
      const appState = encodeAppState({ binding, handle, returnTo });
      let authorizationUrl: URL;
      try {
        authorizationUrl = await client.authorize(handle, { state: appState, scope: 'atproto' });
      } catch (error) {
        dependencies.log?.warn(
          {
            event: 'atproto_authorize_failed',
            ...safeOAuthError(error, isLocalDevelopment(config)),
          },
          'AT Protocol authorization could not be started',
        );
        return new Response(
          JSON.stringify({
            error: { code: 'atproto_unavailable', message: 'AT Protocol sign-in is unavailable' },
          }),
          {
            status: 502,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        );
      }
      const headers = new Headers({ 'cache-control': 'no-store' });
      headers.append(
        'set-cookie',
        serializeLoginCookie(STATE_COOKIE, binding, config, STATE_TTL_SECONDS),
      );
      return new Response(JSON.stringify({ authorizationUrl: authorizationUrl.toString() }), {
        status: 200,
        headers: withJsonHeaders(headers),
      });
    },

    async callback(request: Request): Promise<Response> {
      const params = new URL(request.url).searchParams;
      let completed: { session: { did: string }; state: string | null };
      try {
        completed = await client.callback(params);
      } catch (error) {
        dependencies.log?.warn(
          {
            event: 'atproto_callback_failed',
            ...safeOAuthError(error, isLocalDevelopment(config)),
          },
          'AT Protocol authorization callback could not be completed',
        );
        return authFailure(config, 'OAuth authorization could not be completed.');
      }

      const appState = decodeAppState(completed.state);
      const cookie = parseCookies(request.headers.get('cookie'))[STATE_COOKIE];
      if (!appState || !cookie || !constantTimeEqual(appState.binding, cookie)) {
        return authFailure(config, 'OAuth login did not match this browser.');
      }
      if (!isDid(completed.session.did))
        return authFailure(config, 'OAuth returned an invalid account.');

      const token = randomToken(32);
      const expiresAt = new Date(now().getTime() + config.sessionTtlSeconds * 1_000);
      const nowIso = now().toISOString();
      await run(
        dependencies.db,
        `INSERT INTO atproto_login_sessions
           (token_hash, did, handle, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          await hashSessionToken(token, config.sessionSecret),
          completed.session.did,
          appState.handle,
          expiresAt.toISOString(),
          nowIso,
          nowIso,
        ],
      );
      const headers = new Headers({ location: appState.returnTo, 'cache-control': 'no-store' });
      headers.append('set-cookie', clearLoginCookie(STATE_COOKIE, config));
      headers.append(
        'set-cookie',
        serializeLoginCookie(SESSION_COOKIE, token, config, config.sessionTtlSeconds),
      );
      return new Response(null, { status: 303, headers });
    },

    async principal(request: Request): Promise<AtprotoPrincipal | null> {
      const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
      if (!token) return null;
      const current = now();
      const row = await first<LoginSessionRow>(
        dependencies.db,
        `SELECT did, handle FROM atproto_login_sessions
          WHERE token_hash = ? AND expires_at > ? LIMIT 1`,
        [await hashSessionToken(token, config.sessionSecret), current.toISOString()],
      );
      return row ? { did: row.did, handle: row.handle } : null;
    },

    async logout(request: Request): Promise<Response> {
      const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
      if (token) {
        const tokenHash = await hashSessionToken(token, config.sessionSecret);
        const session = await first<{ did: string }>(
          dependencies.db,
          'SELECT did FROM atproto_login_sessions WHERE token_hash = ? LIMIT 1',
          [tokenHash],
        );
        await run(dependencies.db, 'DELETE FROM atproto_login_sessions WHERE token_hash = ?', [
          tokenHash,
        ]);
        if (session?.did && client.revoke) await client.revoke(session.did).catch(() => undefined);
      }
      const headers = new Headers({ 'cache-control': 'no-store' });
      headers.append('set-cookie', clearLoginCookie(SESSION_COOKIE, config));
      return new Response(null, { status: 204, headers });
    },

    async prune(): Promise<void> {
      const timestamp = now().toISOString();
      await run(
        dependencies.db,
        `DELETE FROM atproto_oauth_states WHERE state_hash IN
           (SELECT state_hash FROM atproto_oauth_states WHERE expires_at <= ? LIMIT 100)`,
        [timestamp],
      );
      await run(
        dependencies.db,
        `DELETE FROM atproto_login_sessions WHERE token_hash IN
           (SELECT token_hash FROM atproto_login_sessions WHERE expires_at <= ? LIMIT 100)`,
        [timestamp],
      );
      await run(
        dependencies.db,
        `DELETE FROM atproto_oauth_locks WHERE name IN
           (SELECT name FROM atproto_oauth_locks WHERE lease_until <= ? LIMIT 100)`,
        [timestamp],
      );
    },
  };
}

/** Build the official SDK client with Workers-native WebCrypto and D1 stores. */
export function createAtprotoOAuthClient(
  config: AtprotoAuthConfig,
  stores: OAuthStores,
  oauthFetch: typeof fetch = guardedDiscoveryFetch(config.allowLocalHttp ?? false),
  oauthRuntime: RuntimeImplementation = workersOAuthRuntime,
): AtprotoClientLike {
  const publicUrl = new URL(config.publicOrigin);
  const origin = publicUrl.origin;
  const callback = `${origin}/api/auth/atproto/callback`;
  const localDevelopment = config.allowLocalHttp === true && isLoopbackHost(publicUrl.hostname);
  const metadata: OAuthClientMetadataInput = localDevelopment
    ? {
        // AT Protocol virtual localhost metadata. The authorization server does
        // not fetch this URL, and accepts a loopback redirect with any port.
        client_id: localhostClientId(callback),
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
        scope: 'atproto',
      }
    : {
        client_id: `${origin}/oauth/client-metadata.json`,
        client_name: 'Uptime',
        client_uri: origin,
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
        scope: 'atproto',
      };
  const runtimeImplementation: RuntimeImplementation = {
    ...oauthRuntime,
    // Refresh and revocation mutate a DID's token set. A D1 lease serializes
    // those updates across Worker isolates; the lease is short and fenced by a
    // random token so a late releaser cannot delete a newer lock.
    requestLock: <T>(name: string, action: () => T | PromiseLike<T>) =>
      withD1Lease(stores.db, name, async () => await action()),
  };
  const options: OAuthClientOptions = {
    responseMode: 'query',
    clientMetadata: metadata,
    stateStore: stores.stateStore,
    sessionStore: stores.sessionStore,
    runtimeImplementation,
    // `@atproto-labs/*` currently constructs Fetch Requests with redirect:
    // "error", which Workers rejects before an injected fetch can run. Keep
    // official OAuth discovery, but provide the equivalent identity seam with
    // Workers-compatible manual redirect rejection.
    identityResolver: createWorkersIdentityResolver(oauthFetch),
    fetch: oauthFetch,
    allowHttp: config.allowLocalHttp ?? false,
  };
  return new OAuthClient(options);
}

function createWorkersIdentityResolver(discoveryFetch: typeof fetch) {
  return {
    async resolve(input: string, options?: { signal?: AbortSignal }) {
      if (isAtprotoDid(input)) {
        const didDoc = await fetchDidDocument(input, discoveryFetch, options?.signal);
        return { did: input, didDoc, handle: 'handle.invalid' };
      }
      const handle = normalizeHandle(input);
      const endpoint = new URL(
        '/xrpc/com.atproto.identity.resolveHandle',
        'https://public.api.bsky.app',
      );
      endpoint.searchParams.set('handle', handle);
      const identity = await fetchJson<{ did?: unknown }>(
        endpoint,
        discoveryFetch,
        options?.signal,
      );
      if (typeof identity.did !== 'string' || !isAtprotoDid(identity.did)) {
        throw new TypeError('AT Protocol handle did not resolve to a supported DID');
      }
      const didDoc = await fetchDidDocument(identity.did, discoveryFetch, options?.signal);
      const aliases = Array.isArray(didDoc.alsoKnownAs) ? didDoc.alsoKnownAs : [];
      if (!aliases.includes(`at://${handle}`)) {
        throw new TypeError('AT Protocol DID document does not confirm this handle');
      }
      return { did: identity.did, didDoc, handle };
    },
  };
}

type AtprotoDid = `did:plc:${string}` | `did:web:${string}`;
type AtprotoDidDocument = {
  id: AtprotoDid;
  alsoKnownAs?: string[];
  service: { id: string; type: string | string[]; serviceEndpoint: string }[];
};

async function fetchDidDocument(
  did: AtprotoDid,
  discoveryFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<AtprotoDidDocument> {
  const url = didDocumentUrl(did);
  const didDoc = await fetchJson<unknown>(
    url,
    discoveryFetch,
    signal,
    'application/did+ld+json, application/json',
  );
  if (!isSupportedDidDocument(didDoc, did)) {
    throw new TypeError('AT Protocol DID document is invalid');
  }
  return didDoc;
}

function isSupportedDidDocument(value: unknown, did: AtprotoDid): value is AtprotoDidDocument {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { id?: unknown; alsoKnownAs?: unknown; service?: unknown };
  return (
    candidate.id === did &&
    (candidate.alsoKnownAs === undefined ||
      (Array.isArray(candidate.alsoKnownAs) &&
        candidate.alsoKnownAs.every((alias) => typeof alias === 'string'))) &&
    Array.isArray(candidate.service) &&
    candidate.service.every(
      (service) =>
        !!service &&
        typeof service === 'object' &&
        typeof (service as { id?: unknown }).id === 'string' &&
        (typeof (service as { type?: unknown }).type === 'string' ||
          Array.isArray((service as { type?: unknown }).type)) &&
        typeof (service as { serviceEndpoint?: unknown }).serviceEndpoint === 'string',
    )
  );
}

function didDocumentUrl(did: AtprotoDid): URL {
  if (did.startsWith('did:plc:'))
    return new URL(`/${encodeURIComponent(did)}`, 'https://plc.directory/');
  const parts = did
    .slice('did:web:'.length)
    .split(':')
    .map((part) => decodeURIComponent(part));
  const host = parts.shift();
  if (!host) throw new TypeError('Invalid did:web identifier');
  const url = new URL(`https://${host}/`);
  url.pathname = parts.length
    ? `/${parts.map(encodeURIComponent).join('/')}/did.json`
    : '/.well-known/did.json';
  return url;
}

function isAtprotoDid(value: string): value is AtprotoDid {
  return /^(?:did:plc:[a-z2-7]{24}|did:web:[a-z0-9._:%-]+)$/i.test(value);
}

async function fetchJson<T>(
  url: URL,
  discoveryFetch: typeof fetch,
  signal?: AbortSignal,
  accept = 'application/json',
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, DISCOVERY_TIMEOUT_MS);
  try {
    const response = await discoveryFetch(url, {
      headers: { accept },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok)
      throw new TypeError(`AT Protocol identity discovery failed with status ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && contentType !== 'application/did+ld+json') {
      throw new TypeError('AT Protocol identity discovery returned an invalid content type');
    }
    return JSON.parse(await boundedResponseText(response)) as T;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_DISCOVERY_RESPONSE_BYTES)
    throw new TypeError('AT Protocol identity discovery response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DISCOVERY_RESPONSE_BYTES)
        throw new TypeError('AT Protocol identity discovery response is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Workers' WebCrypto uses hyphenated digest names, unlike the SDK's lowercase identifiers. */
export const workersOAuthRuntime = {
  // The DPoP private JWK is encrypted in D1 for the callback. WebCrypto keys
  // default to non-extractable, which makes `privateJwk` silently contain only
  // public material after generation and breaks the callback signature.
  createKey: (algorithms: string[]) =>
    WebcryptoKey.generate(algorithms, undefined, { extractable: true }),
  getRandomValues: (length: number) => {
    const result = new Uint8Array(length);
    crypto.getRandomValues(result);
    return result;
  },
  digest: async (
    data: Uint8Array,
    algorithm: { name: 'sha256' | 'sha384' | 'sha512' },
  ): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.digest(webCryptoDigestName(algorithm.name), data as BufferSource),
    ),
};

function webCryptoDigestName(
  name: 'sha256' | 'sha384' | 'sha512',
): 'SHA-256' | 'SHA-384' | 'SHA-512' {
  switch (name) {
    case 'sha256':
      return 'SHA-256';
    case 'sha384':
      return 'SHA-384';
    case 'sha512':
      return 'SHA-512';
  }
}

function createOAuthStores(
  db: D1Database,
  config: AtprotoAuthConfig,
  now: () => Date,
): OAuthStores {
  return {
    db,
    stateStore: {
      async set(state: string, value: InternalStateData) {
        const dpopJwk = privateJwk(value.dpopKey, 'state');
        const { dpopKey: _discard, ...rest } = value;
        const payload = await encryptJson(config.oauthStorageSecret, { ...rest, dpopJwk });
        await run(
          db,
          `INSERT OR REPLACE INTO atproto_oauth_states
             (state_hash, encrypted_payload, expires_at, created_at) VALUES (?, ?, ?, ?)`,
          [
            await hashSessionToken(state, config.sessionSecret),
            payload,
            new Date(now().getTime() + STATE_TTL_SECONDS * 1_000).toISOString(),
            now().toISOString(),
          ],
        );
      },
      async get(state: string) {
        const stateHash = await hashSessionToken(state, config.sessionSecret);
        const row = await first<StateRow>(
          db,
          `SELECT encrypted_payload FROM atproto_oauth_states
            WHERE state_hash = ? AND expires_at > ? LIMIT 1`,
          [stateHash, now().toISOString()],
        );
        if (!row) return undefined;
        const value = await decryptJson<StoredState>(
          config.oauthStorageSecret,
          row.encrypted_payload,
        );
        const dpopKey = await restoreWebcryptoDpopKey(value.dpopJwk);
        const { dpopJwk: _discard, ...rest } = value;
        return { ...rest, dpopKey };
      },
      async del(state: string) {
        await run(db, 'DELETE FROM atproto_oauth_states WHERE state_hash = ?', [
          await hashSessionToken(state, config.sessionSecret),
        ]);
      },
    },
    sessionStore: {
      async set(did: string, value: Session) {
        const dpopJwk = privateJwk(value.dpopKey, 'session');
        const { dpopKey: _discard, ...rest } = value;
        await run(
          db,
          `INSERT OR REPLACE INTO atproto_oauth_sessions (did, encrypted_payload, updated_at)
           VALUES (?, ?, ?)`,
          [
            did,
            await encryptJson(config.oauthStorageSecret, { ...rest, dpopJwk }),
            now().toISOString(),
          ],
        );
      },
      async get(did: string) {
        const row = await first<StateRow>(
          db,
          'SELECT encrypted_payload FROM atproto_oauth_sessions WHERE did = ? LIMIT 1',
          [did],
        );
        if (!row) return undefined;
        const value = await decryptJson<StoredSession>(
          config.oauthStorageSecret,
          row.encrypted_payload,
        );
        const dpopKey = await restoreWebcryptoDpopKey(value.dpopJwk);
        const { dpopJwk: _discard, ...rest } = value;
        return { ...rest, dpopKey };
      },
      async del(did: string) {
        await run(db, 'DELETE FROM atproto_oauth_sessions WHERE did = ?', [did]);
      },
    },
  };
}

function privateJwk(key: Key, recordType: 'state' | 'session'): Readonly<Record<string, unknown>> {
  const jwk = key.privateJwk;
  const privateExponent = jwk && (jwk as Readonly<Record<string, unknown>>).d;
  if (!jwk || typeof privateExponent !== 'string' || !privateExponent) {
    throw new Error(`AT Protocol OAuth ${recordType} has no private DPoP JWK`);
  }
  return jwk;
}

/**
 * `WebcryptoKey.fromJWK()` is inherited from the JOSE base class and returns a
 * generic key. Re-import both halves as CryptoKeys so a restored DPoP key can
 * sign in Workers after the authorization redirect.
 */
async function restoreWebcryptoDpopKey(
  jwk: Readonly<Record<string, unknown>>,
): Promise<WebcryptoKey> {
  const algorithm = webcryptoImportAlgorithm(jwk);
  const { d: _private, key_ops: _operations, use: _use, ...bareJwk } = jwk;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...bareJwk, d: jwk.d, key_ops: ['sign'] } as JsonWebKey,
    algorithm,
    true,
    ['sign'],
  );
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { ...bareJwk, key_ops: ['verify'] } as JsonWebKey,
    algorithm,
    true,
    ['verify'],
  );
  return WebcryptoKey.fromKeypair({ privateKey, publicKey });
}

function webcryptoImportAlgorithm(
  jwk: Readonly<Record<string, unknown>>,
): EcKeyImportParams | RsaHashedImportParams {
  if (jwk.kty === 'EC' && (jwk.crv === 'P-256' || jwk.crv === 'P-384' || jwk.crv === 'P-521')) {
    return { name: 'ECDSA', namedCurve: jwk.crv };
  }
  if (jwk.kty === 'RSA' && typeof jwk.alg === 'string') {
    const hash = jwk.alg.slice(-3);
    if (
      (jwk.alg.startsWith('PS') || jwk.alg.startsWith('RS')) &&
      (hash === '256' || hash === '384' || hash === '512')
    ) {
      return {
        name: jwk.alg.startsWith('PS') ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
        hash: `SHA-${hash}`,
      };
    }
  }
  throw new TypeError('Unsupported AT Protocol DPoP JWK');
}

async function withD1Lease<T>(db: D1Database, name: string, action: () => Promise<T>): Promise<T> {
  const token = randomToken(24);
  const deadline = Date.now() + 15_000;
  let acquired = false;
  while (Date.now() < deadline) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 30_000).toISOString();
    // D1 serializes writes. The conditional UPDATE is the acquire operation:
    // only one contender can replace an expired lease with its random token.
    await run(
      db,
      `INSERT INTO atproto_oauth_locks (name, token, lease_until) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until
       WHERE atproto_oauth_locks.lease_until <= ?`,
      [name, token, leaseUntil, now.toISOString()],
    );
    const lock = await first<{ token: string }>(
      db,
      'SELECT token FROM atproto_oauth_locks WHERE name = ? LIMIT 1',
      [name],
    );
    if (lock?.token === token) {
      acquired = true;
      break;
    }
    await delay(50 + Math.floor(Math.random() * 50));
  }
  if (!acquired) throw new Error('Timed out waiting for AT Protocol OAuth session lock');
  try {
    return await action();
  } finally {
    await run(db, 'DELETE FROM atproto_oauth_locks WHERE name = ? AND token = ?', [name, token]);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function guardedDiscoveryFetch(allowLocalHttp: boolean): typeof fetch {
  return async (input, init) => {
    // The SDK requests Fetch's `error` redirect mode. Workers rejects that
    // value while constructing Request, so normalize it before construction.
    const request = new Request(input, { ...init, redirect: 'manual' });
    const url = new URL(request.url);
    assertDiscoveryUrl(url, allowLocalHttp);
    // Workers supports `manual`, but not Fetch's `error` redirect mode. Reject
    // every redirect ourselves so discovery cannot pivot to an internal URL.
    const response = await fetch(request);
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel();
      throw new TypeError('AT Protocol discovery redirect was rejected');
    }
    return response;
  };
}

function assertDiscoveryUrl(url: URL, allowLocalHttp: boolean): void {
  const host = url.hostname.toLowerCase();
  const local = isLoopbackHost(host);
  if (url.username || url.password)
    throw new TypeError('AT Protocol discovery URL must not contain credentials');
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) {
    throw new TypeError('AT Protocol discovery requires HTTPS');
  }
  if (
    host === 'localhost' ||
    host === 'localhost.' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isForbiddenIpLiteral(host)
  ) {
    if (!(allowLocalHttp && local))
      throw new TypeError('AT Protocol discovery target is not public');
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function isLocalDevelopment(config: AtprotoAuthConfig): boolean {
  return config.allowLocalHttp === true && isLoopbackHost(new URL(config.publicOrigin).hostname);
}

function localhostClientId(callback: string): string {
  const url = new URL('http://localhost/');
  url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('scope', 'atproto');
  return url.toString();
}

function validateConfig(config: AtprotoAuthConfig): AtprotoAuthConfig {
  const origin = new URL(config.publicOrigin);
  const local = isLoopbackHost(origin.hostname);
  if (
    origin.protocol !== 'https:' &&
    !(config.allowLocalHttp && local && origin.protocol === 'http:')
  ) {
    throw new Error('ATPROTO_PUBLIC_ORIGIN must be an HTTPS public origin');
  }
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('ATPROTO_PUBLIC_ORIGIN must be an origin without a path or credentials');
  }
  if (config.sessionSecret.length < 32 || config.oauthStorageSecret.length < 32) {
    throw new Error('AT Protocol secrets must each be at least 32 characters');
  }
  if (!Number.isInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 300) {
    throw new Error('AT Protocol session TTL must be at least 300 seconds');
  }
  return {
    ...config,
    publicOrigin: origin.origin,
    successPath: localReturnPath(config.successPath, '/'),
  };
}

function normalizeHandle(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('handle is required');
  const handle = value.trim().toLowerCase();
  if (
    handle.length < 3 ||
    handle.length > MAX_HANDLE_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      handle,
    )
  ) {
    throw new TypeError('handle must be a valid AT Protocol handle');
  }
  return handle;
}

function localReturnPath(value: unknown, fallback = '/'): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  ) {
    return fallback;
  }
  try {
    const resolved = new URL(value, 'https://local.invalid');
    return resolved.origin === 'https://local.invalid'
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

function encodeAppState(value: { binding: string; handle: string; returnTo: string }): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeAppState(
  value: string | null,
): { binding: string; handle: string; returnTo: string } | null {
  if (!value || value.length > 1024) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as Record<
      string,
      unknown
    >;
    const handle = normalizeHandle(parsed.handle);
    return typeof parsed.binding === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(parsed.binding)
      ? { binding: parsed.binding, handle, returnTo: localReturnPath(parsed.returnTo) }
      : null;
  } catch {
    return null;
  }
}

function serializeLoginCookie(
  name: string,
  token: string,
  config: AtprotoAuthConfig,
  maxAge: number,
): string {
  return serializeCookie(name, token, {
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge,
  });
}

function clearLoginCookie(name: string, config: AtprotoAuthConfig): string {
  return clearCookie(name, { secure: config.cookieSecure, sameSite: 'lax' });
}

function immutableJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

function withJsonHeaders(headers: Headers): Headers {
  headers.set('content-type', 'application/json; charset=utf-8');
  return headers;
}

function safeOAuthError(
  error: unknown,
  includeDevelopmentDiagnostic: boolean,
): { name: string; code?: string; diagnostic?: string } {
  const candidate = error as { name?: unknown; code?: unknown };
  return {
    name: typeof candidate?.name === 'string' ? candidate.name.slice(0, 80) : 'Error',
    ...(typeof candidate?.code === 'string' ? { code: candidate.code.slice(0, 80) } : {}),
    ...(includeDevelopmentDiagnostic ? { diagnostic: sanitizedErrorDiagnostic(error) } : {}),
  };
}

/** Local diagnostics retain the failure stage while redacting URLs and credentials. */
function sanitizedErrorDiagnostic(error: unknown): string {
  const chain: { name: string; message: string; stack: string }[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      cause?: unknown;
    };
    chain.push({
      name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      message: typeof candidate.message === 'string' ? candidate.message : '',
      stack: typeof candidate.stack === 'string' ? candidate.stack : '',
    });
    current = candidate.cause;
  }
  // The Worker log field is bounded. Put the root cause first, where it stays
  // visible even when a framework wrapped it in several OAuth errors.
  const parts = chain.reverse().map(({ name, message, stack }) => {
    const frames = stack ? ` ${redactDiagnostic(stack.split('\n').slice(1, 3).join(' | '))}` : '';
    return `${name}: ${redactDiagnostic(message)}${frames}`.slice(0, 260);
  });
  return parts.join(' <- ').slice(0, 600) || 'Unknown authorization error';
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s'"<>]+/giu, '[url]')
    .replace(
      /\b(?:Bearer\s+)?[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
      '[token]',
    )
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/gu, '[secret]');
}

function authFailure(config: AtprotoAuthConfig, message: string): Response {
  const headers = new Headers({
    location: `${config.successPath}?auth_error=atproto`,
    'cache-control': 'no-store',
  });
  headers.append('set-cookie', clearLoginCookie(STATE_COOKIE, config));
  // The response body is deliberately generic: OAuth server errors can contain
  // user-controlled text and must not be reflected into an HTML page.
  return new Response(message, { status: 303, headers });
}

function isDid(value: string): boolean {
  return /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value) && value.length <= 2048;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1)
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function encryptJson(secret: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return base64UrlEncode(packed);
}

async function decryptJson<T>(secret: string, packed: string): Promise<T> {
  const bytes = base64UrlDecode(packed);
  if (bytes.length <= 12) throw new TypeError('Invalid encrypted OAuth record');
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
