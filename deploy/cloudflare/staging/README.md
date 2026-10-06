# Isolated Cloudflare Staging Deployment

> [!IMPORTANT]
> **STAGING ARCHITECTURE**: Staging core API and minute scheduler run on a dedicated Debian 12 VPS (`217.217.227.164`) co-located with PostgreSQL 18.
> Production remains 100% on Cloudflare Workers and D1 databases.
> For the canonical VPS deployment and operations guide, see [deploy/vps/staging/README.md](../../vps/staging/README.md).

This environment is completely isolated from production. Every Cloudflare Worker, database, bucket, and Pages project uses the `uptime-staging` namespace.

---

## Post-VPS Migration Architecture

- **API Runtime**: Runs on Node 24 on VPS (`127.0.0.1:3001`). Zero public ports.
- **Scheduler**: Runs as a single minute dispatcher on Node 24 on VPS (`uptime-staging-node-scheduler`), evaluating monitors, dispatching signed probe batches over HTTPS, and writing reports to R2.
- **Database**: PostgreSQL 18 on VPS with dedicated schemas (`control`, `tenant_*`), managed and bootstrapped via [`scripts/postgres-staging-bootstrap.ts`](file:///Users/david/.codex/worktrees/f95e/uptime/scripts/postgres-staging-bootstrap.ts). Staging D1 databases are retired.
- **Operator**: `@noz.am` (`did:plc:lmkzmvv6sdxntwtyxpg7fqqq`).
- **Budget Policy**: Staging has budget enforcement disabled (`BUDGET_ENFORCEMENT_DISABLED=true` on VPS API and scheduler). Production defaults remain enforced.

---

## Retained Cloudflare Staging Infrastructure

The following Cloudflare staging resources remain active:

| Resource | Staging Value | Role |
| --- | --- | --- |
| **Frontend** | <https://uptime-staging.pages.dev> | Cloudflare Pages hosting React UI and gateway routing |
| **VPC API Proxy Worker** | `uptime-staging-oauth-api` | Live proxy Worker ([vps-api-proxy/wrangler.toml](vps-api-proxy/wrangler.toml)) forwarding ingress through Cloudflare Tunnel to Node API on loopback `127.0.0.1:3001` |
| **Fenced Coordinator** | `uptime-staging-hosted-coordinator` | Retired coordinator safety fence ([hosted-coordinator/drain-entry.ts](hosted-coordinator/drain-entry.ts), empty crons `crons = []`, 0 queue consumers) |
| **Regional Probes** | `uptime-staging-probe-{region}` | Probe Workers executing HTTP health checks across regional Cloudflare PoPs |
| **Hosted Probes** | `uptime-staging-hosted-probe-{region}` | Regional probe Workers for hosted tenant checks |
| **R2 Bucket** | `uptime-staging-reports` | Private report storage used by VPS scheduler and API |
| **Status Domains** | `deploy/cloudflare/staging/status-domains/` | Custom domain ingress fallback gateway |
| **Controlled Target** | `uptime-staging-target` | Probe healthcheck target |
| **Legacy Imported Bindings** | `deploy/cloudflare/staging/api/` & `reporter/` | Bound by Pages for legacy imported workspace routes (`IMPORTED_API`, `IMPORTED_REPORTER`) |
| **PostgreSQL Catalog** | `deploy/cloudflare/staging/postgresql-runtime-catalog.json` | Active schema catalog mapping for VPS PostgreSQL runtime |

---

## Worker Deployments

### 1. VPC API Proxy Worker
The live staging Worker `uptime-staging-oauth-api` runs the VPC HTTP service proxy forwarding requests to the VPS loopback:

```bash
pnpm --filter @uptime/api-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/vps-api-proxy/wrangler.toml
```

Or using the unified script:
```bash
scripts/deploy-hosted-workers.sh --environment staging --target api
```

### 2. Retired Hosted Coordinator Fence
The retired hosted coordinator is preserved as a deployment fence to prevent accidental reactivation of Cloudflare-based scheduling:

```bash
pnpm --filter @uptime/coordinator-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/hosted-coordinator/wrangler.toml
```

Or using the unified script:
```bash
scripts/deploy-hosted-workers.sh --environment staging --target coordinator
```

### 3. Regional Probe Fleet
Deploy regional probe Workers:
```bash
scripts/deploy-workers.sh --environment staging
```

---

## Safety Rules & Guardrails

- **Zero Dual Schedulers**: Never start the Cloudflare staging coordinator cron or add queue consumers while the VPS scheduler is running.
- **Never expose plaintext API**: Ingress arrives only via Cloudflare Tunnel over encrypted QUIC to loopback `127.0.0.1:3001`. Do not open public host ports or change Pangolin ports.
- **No D1 Provisioning in Staging**: `scripts/provision-tenant-pool.sh` and `scripts/bootstrap-operator-workspace.sh` reject staging. `scripts/deploy-hosted-workers.sh staging` automatically deploys the proxy and fenced coordinator without touching D1.
- **Protected Secrets**: Never commit or print secrets from `deploy/cloudflare/staging/hosted.secrets.env`. Keep permissions at mode `0600`.
- **Pages Environment**: Do not copy `.env.staging` or `.env.staging.*.json` into Pages builds.
