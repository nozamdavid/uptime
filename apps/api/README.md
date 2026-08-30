# API service

The Fastify control plane owns one local admin, sessions, monitor configuration,
latency history, and request-history queries. It requires PostgreSQL with the
`@uptime/database` migrations applied.

Set the API variables from the repository `.env.example`. Generate an Argon2id
hash outside the process (for example with a short-lived local Node command) and
set it as `ADMIN_PASSWORD_HASH`; the service inserts the single `ADMIN_EMAIL`
and that hash only when `admins` is empty. It never accepts or persists a
plaintext password.

The app exposes `/health` without authentication. Protected `/api` operations
require the browser session, an opaque, HMAC-hashed token in an HttpOnly,
strict-SameSite cookie. Set `SESSION_COOKIE_SECURE=true` when serving over HTTPS.

Run after the workspace dependencies have been installed:

```sh
pnpm --filter @uptime/api typecheck
pnpm --filter @uptime/api test
pnpm --filter @uptime/api start
```

The isolated tests cover SSRF literal policy and deterministic aggregate status
and percentile behavior. A database-backed integration suite is intentionally
left to the repository integration pass, where the disposable PostgreSQL
service can exercise auth, CRUD, pagination, and persisted observations.
