# Staging API Secure Ingress Preflight & Architecture Assessment (2026-10-05)

## 1. Executive Summary & Core Ingress Decision

- **Task Scope:** Read-only deployment preflight and transport architecture assessment for relocating the staging API to Debian 12 VPS (`217.217.227.164`) co-located with staging PostgreSQL 18.
- **Strict Boundaries Observed:**
  - Read-only preflight: Zero remote or local source code mutations.
  - Ownership: Exclusively `docs/deployment/vps-api-secure-ingress-2026-10-05.md`.
  - Co-located Pangolin services on host ports 80/443 (TCP/UDP) and 21820/51820 (UDP) must not be interrupted or bound.
  - Production database (D1), staging PostgreSQL, and active tunnels remain untouched.
  - No secret values printed, exposed, or committed.

### Core Architectural Decision: Workers VPC HTTP Service Binding
The recommended, proven, and fully authorized ingress mechanism is **Cloudflare Workers VPC HTTP Service Binding** utilizing the existing, active Cloudflare Tunnel (`73f04432-509a-4aed-87fb-b94f67bbe41d`):

| Ingress Option | Viability | Technical Evaluation & Constraints |
| :--- | :--- | :--- |
| **Workers VPC HTTP Service Binding (Recommended)** | **Proven / Supported** | Uses existing active tunnel `73f04432-509a-4aed-87fb-b94f67bbe41d`. Zero public ports opened on VPS. Node binds `127.0.0.1:3001` (verified free). QUIC encrypted tunnel. No domain or TLS cert setup required. |
| **Direct IP Public HTTPS (`https://217.217.227.164`)** | **Disproven / Blocked** | **Hard Blocker 1:** Cloudflare Workers `fetch()` rejects direct IP access with `Error 1003: Direct IP access not allowed`.<br>**Hard Blocker 2:** Let's Encrypt issues IP certificates only under the `shortlived` profile (~6-day lifetime) requiring HTTP-01 (port 80) or TLS-ALPN-01 (port 443), both strictly owned by Pangolin. |
| **Unauthenticated Public Subdomain (`api-staging.uptime.noz.am`)** | **Not Selected** | Must not invent or assume availability. Requires DNS records and public TLS certs. VPC service binding avoids any new public hostname setup. |

---

## 2. Ingress Transport Architecture & Path

```mermaid
graph LR
  subgraph Public Internet
    Browser["User Browser / ATProto PDS"]
  end

  subgraph Cloudflare Edge
    Pages["Cloudflare Pages (uptime-staging.pages.dev)"]
    Gateway["Pages Edge Gateway (_worker.js)"]
    ProxyWorker["Worker Service (uptime-staging-oauth-api)"]
    VPCBinding["VPC Service Binding (STAGING_NODE_API)"]
    TunnelEdge["Cloudflare Tunnel Edge"]
  end

  subgraph VPS 217.217.227.164
    Cloudflared["cloudflared (PID 1790844)"]
    NodeAPI["Node API (Docker / 127.0.0.1:3001)"]
    PG["PostgreSQL 18 (127.0.0.1:5432)"]
    Pangolin["Pangolin / Traefik (0.0.0.0:80,443)"]
  end

  Browser -->|HTTPS| Pages
  Pages --> Gateway
  Gateway -->|Service Binding| ProxyWorker
  ProxyWorker -->|env.STAGING_NODE_API.fetch()| VPCBinding
  VPCBinding -->|Encrypted QUIC| TunnelEdge
  TunnelEdge --> Cloudflared
  Cloudflared -->|HTTP loopback| NodeAPI
  NodeAPI -->|Loopback TCP| PG
  Pangolin -.->|Isolated / Untouched| Pangolin
```

### Component Details
1. **Frontend / Public Origin:** Cloudflare Pages hosts the UI and public routes at `https://uptime-staging.pages.dev`.
2. **Pages Functions & Gateway:** Cloudflare Pages Functions cannot directly bind `[[vpc_services]]` (Pages schema validation error). However, Pages natively supports standard Worker Service Bindings (`[[services]]`). The Pages gateway (`_worker.js`) routes `/api/*` and `/oauth/*` to the Worker service binding `API` or `OAUTH`.
3. **Cloudflare Worker VPC Binding:** The Worker (`uptime-staging-oauth-api`) includes a `[[vpc_services]]` block pointing to the VPC service ID created on Cloudflare Tunnel `73f04432-509a-4aed-87fb-b94f67bbe41d`.
4. **Tunnel & VPS Loopback:** `cloudflared` receives the request over outbound QUIC connections to Cloudflare Edge (`sof01`/`sof05`), forwarding directly to `127.0.0.1:3001`.
5. **Node API Server:** Listens strictly on `127.0.0.1:3001` inside Docker container or host process.

---

## 3. Verified VPS Runtime & Network Preflight Facts

Direct read-only inspection of VPS `217.217.227.164` (verified 2026-10-05):

- **Port 3001 Availability:** Verified via `ss -tulpn | grep 3001` — **completely free**.
- **Preserved Ports (Unmodified):**
  - Ports `80` and `443` (TCP/UDP) bound by `docker-proxy` to `gerbil` / `traefik` (Pangolin).
  - Ports `21820` and `51820` (UDP) bound by `docker-proxy` (Pangolin WireGuard).
  - Port `5432` bound strictly to `127.0.0.1:5432` and `[::1]:5432` by PostgreSQL 18.6 (`uptime-staging`).
  - Port `22` bound to host `sshd`.
- **Active Cloudflare Tunnel:**
  - Name: `uptime-staging-postgres`
  - Tunnel UUID: `73f04432-509a-4aed-87fb-b94f67bbe41d`
  - Service: `cloudflared-uptime-staging.service` (PID 1790844).
  - Configuration: `/etc/cloudflared/uptime-staging-postgres.env` (managed tunnel token).
- **Compute Resources:**
  - Docker: `Docker version 29.8.0, build 88096ef` installed and active.
  - Node.js on Host: Not installed. Docker container runtime (e.g., `node:24-bookworm-slim`) is authorized and appropriate.
  - Headroom: 6.1 GiB RAM available (out of 7.8 GiB), 51 GB disk available.

---

## 4. Origin Trust, ATProto OAuth & Anti-Spoofing Architecture

### 4.1 Strict Preservation of Public Origin
Under ATProto OAuth specification and browser cookie policies:
- **ATProto `client_id`:** Must be an absolute public HTTPS URL resolving to `https://uptime-staging.pages.dev/oauth/client-metadata.json`. External PDS servers (e.g., `bsky.social`) validate this URL via public HTTPS.
- **Host-Only Cookies:** `uptime_atproto_session` and `uptime_atproto_login` are issued without a `Domain=` attribute (host-only). Browsers only transmit them to `uptime-staging.pages.dev`.
- **Public URL Stability:** The Node server adapter configuration (`apps/api-worker/src/node-env.ts`) explicitly enforces:
  - `PUBLIC_ORIGIN = "https://uptime-staging.pages.dev"`
  - Handler code always bases generated URLs on `publicOrigin`; client `Host` headers are never trusted.

### 4.2 Transparent Authenticated Proxy & Anti-Spoofing Controls
To prevent header forgery or unauthorized requests over the local loopback:
1. **Shared Gateway Secret (`API_GATEWAY_TOKEN`):**
   - Configured in the proxy Worker and the Node server environment (min 32 characters).
   - The edge proxy injects `x-gateway-token: <secret>`.
   - The Node server checks this token on every incoming request, returning `401 Unauthorized` if missing or invalid.
2. **Trusted Proxy Enforcement (`API_TRUSTED_PROXIES`):**
   - The Node runtime adapter configures `API_TRUSTED_PROXIES="127.0.0.1"`.
   - Forwarding headers (`CF-Connecting-IP`, `X-Forwarded-For`) are only accepted when the remote socket peer matches an address in `API_TRUSTED_PROXIES`.
   - Any attempt to spoof client IP headers from untrusted sources is rejected.

---

## 5. Cloudflare CLI & Configuration Commands

### 5.1 Create VPC HTTP Service (Cloudflare Account `8af9a4d4a03e412bbd3f2a31463ec5b6`)
Using existing tunnel `73f04432-509a-4aed-87fb-b94f67bbe41d`:

```bash
npx wrangler vpc service create uptime-staging-node-api \
  --type http \
  --tunnel-id 73f04432-509a-4aed-87fb-b94f67bbe41d \
  --ipv4 127.0.0.1 \
  --http-port 3001
```

*Verification:*
```bash
npx wrangler vpc service list
# Output displays service ID (UUID) for uptime-staging-node-api
```

### 5.2 Worker Configuration (`wrangler.toml`)
In the proxy worker (`deploy/cloudflare/staging/oauth-api/wrangler.toml` or dedicated proxy):

```toml
# Bind the VPC service to reach Node API on VPS loopback 3001
[[vpc_services]]
binding = "STAGING_NODE_API"
service_id = "<SERVICE_ID_FROM_CREATE>"
```

### 5.3 Forwarding Handler Snippet (Edge Worker)
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Forward request through VPC service to VPS loopback
    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.set('x-forwarded-host', url.host);
    forwardHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));
    if (env.API_GATEWAY_TOKEN) {
      forwardHeaders.set('x-gateway-token', env.API_GATEWAY_TOKEN);
    }

    return env.STAGING_NODE_API.fetch(request.url, {
      method: request.method,
      headers: forwardHeaders,
      body: request.body,
      redirect: 'manual',
    });
  },
};
```

---

## 6. Runtime Private Auth Secrets Inventory (Local Inspection)

In accordance with strict safety guidelines, secrets were assessed locally by protected filename presence and variable names only. No secret values were printed or exposed:

### 6.1 Required Secrets for Node Staging API
From `apps/api-worker/src/env.ts` and `apps/api-worker/src/node-env.ts`:
1. `SESSION_SECRET` (min 32 chars): Signs and validates user session cookies.
2. `CREDENTIAL_ENCRYPTION_SECRET` (min 32 chars): AES-GCM key for encrypted monitor credentials.
3. `OAUTH_STORAGE_SECRET` (min 32 chars): Required by ATProto OAuth state store.
4. `POSTGRES_URL`: PostgreSQL connection string (`postgresql://uptime_staging_worker:<password>@127.0.0.1:5432/uptime_staging`).
5. `API_GATEWAY_TOKEN` (min 32 chars): Shared token between Edge Worker and Node adapter.

### 6.2 Local File Presence & Gap Analysis
- **`deploy/cloudflare/staging/hosted.secrets.env`:**
  - *Present:* `CREDENTIAL_ENCRYPTION_SECRET`, `PROBE_SIGNING_SECRET`.
  - *Missing:* `SESSION_SECRET`, `OAUTH_STORAGE_SECRET`.
- **`deploy/cloudflare/hosted/.dev.vars`:**
  - *Present:* `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, `OAUTH_STORAGE_SECRET` (development values only).
- **Cloudflare Worker Secrets (`uptime-staging-oauth-api`):**
  - Confirmed configured on Cloudflare: `CREDENTIAL_ENCRYPTION_SECRET`, `OAUTH_STORAGE_SECRET`, `SESSION_SECRET`.
  - Note: Cloudflare Worker secrets are write-only and cannot be extracted via API/CLI.
- **Action for Deployment Phase:** The operator must supply production/staging values for `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, `OAUTH_STORAGE_SECRET`, and `POSTGRES_URL` in the protected runtime environment file on the VPS (e.g. `/opt/uptime-staging/api.env`, permissions `0600`).

---

## 7. Implementation Ownership & Handoff

- **Preflight & Architecture Documentation (This Task):**
  - File: [`docs/deployment/vps-api-secure-ingress-2026-10-05.md`](file:///Users/david/.codex/worktrees/f95e/uptime/docs/deployment/vps-api-secure-ingress-2026-10-05.md) (Owned exclusively).
  - Status: Complete, read-only preflight verified.
- **Node Server Adapter Implementation:**
  - Handed off to peer subagent implementing `apps/api-worker/src/node-server.ts` and `apps/api-worker/src/node-env.ts`.
- **VPS Deployment Execution:**
  - Handed off to deployment operator to run Docker container (`node:24-bookworm-slim`), provision `/opt/uptime-staging/api.env`, create the VPC HTTP service via `wrangler vpc service create`, and attach `[[vpc_services]]` to the staging edge Worker.
