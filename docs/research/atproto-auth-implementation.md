# AT Protocol OAuth deployment

`apps/api-worker/src/atproto-auth.ts` implements sign-in through the official,
portable `@atproto/oauth-client` package. Do not use app passwords, password
login, or scopes beyond `atproto`.

## Required routes

The public HTTPS origin must forward these paths to the API Worker without
rewriting the query string:

| Route | Purpose |
| --- | --- |
| `GET /oauth/client-metadata.json` | Discoverable OAuth client metadata |
| `GET /oauth/jwks.json` | Empty JWKS for the current public client |
| `POST /api/auth/atproto/start` | Starts sign-in with `{ "handle": "name.example" }` |
| `GET /api/auth/atproto/callback` | OAuth redirect URI |

`PUBLIC_ORIGIN` must exactly be that public origin, such as
`https://api.example.com`. It must not be a Worker service URL, a preview URL,
or an origin with a path. Local development may use a loopback origin such as
`http://127.0.0.1:5176` when `ENVIRONMENT=development`. The module then
uses AT Protocol's virtual `http://localhost/` client ID, with the loopback
callback and `atproto` scope encoded in its query string.

## Secrets and control-plane database

Set these Worker secrets:

```text
SESSION_SECRET=<random 32+ character secret>
OAUTH_STORAGE_SECRET=<different random 32+ character secret>
```

The first hashes browser session tokens before D1 storage. The second encrypts
OAuth state, DPoP private keys, and refresh tokens with AES-GCM. Never rotate
either secret without first expiring affected login sessions. Apply the
exported `atprotoAuthSchema` to the control-plane D1 database, not tenant
databases.

The schema stores short-lived authorization state, encrypted SDK sessions,
hashed browser sessions, and fenced D1 leases. Prune runs in bounded batches
through `auth.prune()` after login starts and callbacks.

Workers development uses manual redirect rejection and an injected identity
resolver because the SDK's default DID resolver constructs unsupported
`redirect: 'error'` requests. DPoP keys are generated as extractable WebCrypto
key pairs, encrypted before persistence, and restored with separate private
`sign` and public `verify` usages. This lets a key survive the browser redirect
without falling back to Node crypto. The complete local provider login,
callback, workspace allocation, and persisted session were verified on
2026-10-02; account passwords are entered at the provider only.

## Router integration

Create one auth service per Worker isolate:

```ts
const auth = createAtprotoAuth({
  db: env.CONTROL_DB,
  config: {
    publicOrigin: env.ATPROTO_PUBLIC_ORIGIN,
    sessionSecret: env.ATPROTO_SESSION_SECRET,
    oauthStorageSecret: env.ATPROTO_OAUTH_STORAGE_SECRET,
    sessionTtlSeconds: 60 * 60 * 24 * 30,
    cookieSecure: true,
    successPath: '/app',
  },
});
```

Register `auth.metadata`, `auth.jwks`, `auth.start`, and `auth.callback` on
the listed routes. On authenticated requests, call
`auth.principal(request)`, which returns `{ did, handle }` or `null`. The DID
is the stable account identity. The handle is only the normalized handle
submitted at login and may change later. On logout, call `auth.logout(request)`.

Create or look up the application user by DID after `principal()` returns.
Check suspension and workspace membership in the control plane before tenant
access. Do not derive an email address from an AT Protocol account.

## Security properties and operating limits

The SDK performs PKCE, DPoP, authorization-server discovery, issuer checks,
and token subject validation. The module adds a separate browser-bound,
HttpOnly `SameSite=Lax` login cookie; callbacks without its matching binding
fail. SDK authorization state is single-use and expires after 10 minutes.

Discovery fetches accept HTTPS only, reject redirects, block loopback,
link-local, private IPv4, local/internal names, and reject HTTP except the
explicit localhost development setting. AT Protocol is decentralized, so a
production deployment still makes HTTPS requests to public user-selected PDS
and authorization hosts. Keep Cloudflare outbound controls enabled and monitor
Worker egress; hostname checks cannot by themselves prevent a public DNS name
from later rebinding.

This first release is a public OAuth client with DPoP and no client signing
key. `@atproto/oauth-client-node` must not be added because its Node crypto and
DNS resolver do not suit Workers. A later confidential-client upgrade needs a
long-lived signing JWK in a Worker secret, `private_key_jwt` metadata, and a
non-empty `/oauth/jwks.json` endpoint. That changes client identity and should
be deployed as a planned migration, not as an incidental key rotation.
