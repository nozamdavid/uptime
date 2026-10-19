# Staging API Ingress Preflight (2026-10-05)

> [!NOTE]
> The Cloudflare Pages gateway, VPC proxy Worker, and Cloudflare Tunnel ingress described in the original version of this record were removed with the Cloudflare-hosted backend. The VPS reverse proxy now serves the web UI and forwards `/api`, `/oauth`, and `/reports` to the Node API. See the [VPS staging runbook](../../deploy/vps/staging/README.md).

## VPS runtime facts

Read-only inspection of VPS `217.217.227.164` on 2026-10-05:

- Port `3001` was free; the Node API binds `127.0.0.1:3001`.
- Ports `80` and `443` (TCP/UDP) and `21820` and `51820` (UDP) belong to Pangolin and must not be bound or interrupted.
- PostgreSQL 18 listens only on `127.0.0.1:5432` and `[::1]:5432`.
- Docker was installed and Node.js was not installed on the host, so the API runs in a `node:24-bookworm-slim` container.
- Headroom was 6.1 GiB RAM (of 7.8 GiB) and 51 GB disk.

## Origin trust and anti-spoofing

- The ATProto OAuth `client_id` must be an absolute public HTTPS URL, `<PUBLIC_ORIGIN>/oauth/client-metadata.json`, reachable by external PDS servers.
- `uptime_atproto_session` and `uptime_atproto_login` cookies are host-only (no `Domain=`), so the public origin must stay stable.
- Handlers build URLs from `PUBLIC_ORIGIN`; client `Host` headers are never trusted (`apps/api-worker/src/node-env.ts`).
- Forwarding headers (`CF-Connecting-IP`, `X-Forwarded-For`) are accepted only when the socket peer matches `API_TRUSTED_PROXIES` (`127.0.0.1,::1`), so the reverse proxy must run on the same host.

## Required API secrets

Set these in the protected runtime file on the VPS (`/opt/uptime-staging/api.env`, mode `0600`). Never print or commit them.

1. `SESSION_SECRET` (min 32 chars): signs session cookies.
2. `CREDENTIAL_ENCRYPTION_SECRET` (min 32 chars): AES-GCM key for encrypted monitor credentials.
3. `OAUTH_STORAGE_SECRET` (min 32 chars): ATProto OAuth state store.
4. `POSTGRES_URL`: `postgresql://uptime_staging_worker:<password>@127.0.0.1:5432/uptime_staging`.
