# Staging VPS Canonical Deployment Guide & Runbook (Host 217.217.227.164)

> [!IMPORTANT]
> **STAGING ONLY**: This runbook applies exclusively to the **staging** environment.
> Production operates 100% on Cloudflare Workers, Cloudflare D1 databases, R2 storage, and Pages. Production has **not** migrated to the VPS.
> For production deployment instructions, see [deploy/cloudflare/README.md](../../cloudflare/README.md) and [docs/deployment/free-hosted.md](../../../docs/deployment/free-hosted.md).

This document is the canonical operational guide for running the Uptime staging API and scheduler on Debian 12 VPS `217.217.227.164` (alias `ssh vps`), co-located with PostgreSQL 18.

---

## 1. Architecture & Isolation Boundaries

```mermaid
graph TD
  subgraph Public Internet
    Browser["User Browser / ATProto PDS"]
  end

  subgraph Cloudflare Edge
    Pages["Cloudflare Pages (uptime-staging.pages.dev)"]
    Gateway["Pages Edge Gateway (_worker.js)"]
    ProxyWorker["VPC Proxy Worker (uptime-staging-oauth-api)"]
    VPCBinding["VPC Service Binding (STAGING_NODE_API)"]
    TunnelEdge["Cloudflare Tunnel Edge"]
    Probes["Regional Probe Fleet (uptime-staging-hosted-probe-*)"]
    R2["R2 Reports Bucket (uptime-staging-reports)"]
  end

  subgraph VPS 217.217.227.164
    Cloudflared["cloudflared (Tunnel 73f04432-...)"]
    NodeAPI["Node 24 API (Docker: uptime-staging-node-api)
    127.0.0.1:3001"]
    NodeScheduler["Node 24 Scheduler (Docker: uptime-staging-node-scheduler)
    Single Minute Dispatcher"]
    PG["PostgreSQL 18 (127.0.0.1:5432)
    DB: uptime_staging"]
    Pangolin["Pangolin / Traefik / WireGuard
    0.0.0.0: 80, 443, 21820, 51820 (UNTOUCHED)"]
  end

  Browser -->|HTTPS| Pages
  Pages --> Gateway
  Gateway -->|Service Binding| ProxyWorker
  ProxyWorker -->|STAGING_NODE_API.fetch()| VPCBinding
  VPCBinding -->|Encrypted QUIC| TunnelEdge
  TunnelEdge --> Cloudflared
  Cloudflared -->|HTTP Loopback| NodeAPI
  NodeAPI -->|Local Loopback TCP| PG
  NodeScheduler -->|Local Loopback TCP| PG
  NodeScheduler -->|Signed HTTPS Batches| Probes
  NodeScheduler -->|S3 API| R2
  NodeAPI -->|S3 API Read| R2
```

### Core Architecture Facts
- **Host & Access**: Debian 12 VPS at `217.217.227.164`, accessed via `ssh vps` or `ssh root@217.217.227.164`.
- **PostgreSQL 18**: Runs on VPS loopback `127.0.0.1:5432` / `[::1]:5432`, database `uptime_staging`. Managed with two roles:
  - `uptime_staging_owner`: Schema owner and migration runner.
  - `uptime_staging_worker`: Runtime least-privilege role used by API and scheduler.
- **Node 24 API (`uptime-staging-node-api`)**:
  - Pre-bundled ESM service listening on `127.0.0.1:3001` via `network_mode: host`.
  - Zero public ports exposed. Never expose the authenticated Node API directly on the public IP.
- **Node 24 Scheduler (`uptime-staging-node-scheduler`)**:
  - Single minute dispatcher running via `network_mode: host`. Opens no listening ports.
  - Dispatches due workspaces serially at minute boundaries by querying PostgreSQL `uptime_staging`.
  - Sends signed batches (`PROBE_SIGNING_SECRET`) over outbound HTTPS to Cloudflare regional probe Workers.
- **Fenced Cloudflare Coordinator**:
  - The legacy Cloudflare coordinator Worker (`uptime-staging-hosted-coordinator`) is retired and fenced with [drain-entry.ts](../../cloudflare/staging/hosted-coordinator/drain-entry.ts), empty crons `crons = []`, and queue consumers deleted.
  - **CRITICAL**: Never run both schedulers simultaneously.
- **Strict Pangolin Isolation**:
  - Host ports `80`, `443` (TCP/UDP), `21820`, `51820` (UDP) are strictly owned by Pangolin (`/opt/pangolin`). Do not touch or modify Pangolin containers or ports.
- **Cloudflare Edge Ingress**:
  - Cloudflare Pages serves the frontend UI and routes `/api/*` and `/oauth/*` via worker service binding to `uptime-staging-oauth-api`.
  - `uptime-staging-oauth-api` (configured in [deploy/cloudflare/staging/vps-api-proxy/wrangler.toml](../../cloudflare/staging/vps-api-proxy/wrangler.toml)) forwards requests through Cloudflare Tunnel `73f04432-509a-4aed-87fb-b94f67bbe41d` to VPS loopback `127.0.0.1:3001`.
- **R2 Storage & Custom Domains**:
  - R2 bucket `uptime-staging-reports` remains active. The scheduler writes reports using the S3-compatible API; the Node API reads reports. Custom status domain routing remains on Cloudflare.
- **Staging Budget Policy**:
  - Staging intentionally runs with `BUDGET_ENFORCEMENT_DISABLED=true` in [docker-compose.yml](docker-compose.yml) on both API and scheduler containers.
  - Manual fleet and workspace pauses, quotas, plan limits, and capacity checks remain strictly enforced. Production defaults remain fully enforced. Cloudflare analytics read tokens remain a deferred TODO.

---

## 2. Directory Layout & Credentials Management

### VPS Directory Structure
```
/opt/uptime-staging/                         # Compose project directory
├── docker-compose.yml                      # Compose configuration for API & scheduler
├── catalog.json                            # Multi-tenant schema catalog mapping
├── api.env                                 # API environment secrets (chmod 0600)
└── scheduler.env                           # Scheduler environment secrets (chmod 0600)

/opt/uptime-staging-artifact/                # API image build context
├── server.mjs                              # Standalone Node 24 API bundle
└── Dockerfile.runtime                      # Runtime container definition

/opt/uptime-staging-scheduler-artifact/      # Scheduler image build context
├── scheduler.mjs                           # Standalone Node 24 scheduler bundle
└── Dockerfile.scheduler                    # Runtime container definition
```

### Protected Credentials & Safe Handling
- **Never print, paste, or commit secrets.** Credentials must never appear in version control, logs, or chat.
- Protected files:
  - `/opt/uptime-staging/api.env`: Permissions must be `0600`. Contains `POSTGRES_URL`, `API_GATEWAY_TOKEN`, `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, `OAUTH_STORAGE_SECRET`.
  - `/opt/uptime-staging/scheduler.env`: Permissions must be `0600`. Contains `POSTGRES_URL`, `PROBE_SIGNING_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, and R2 credentials.
  - `~/.config/uptime-postgresql/staging-worker-password`: Operator file storing the `uptime_staging_worker` password.
  - `deploy/cloudflare/staging/hosted.secrets.env`: Local operator secrets file (mode `0600`).
- Safe transfer: Transfer secrets directly via SSH stdin or scp into mode `0600` destination files.

---

## 3. Database Schema, Bootstrap & Boundaries

Staging starts from native PostgreSQL 18 with **zero D1 data import**. Operator `@noz.am` (`did:plc:lmkzmvv6sdxntwtyxpg7fqqq`) is seeded directly.

### Bootstrap & Migration Tooling
The initial schema and operator seed come from [`scripts/postgres-staging-bootstrap.ts`](../../../scripts/postgres-staging-bootstrap.ts). It is an operator-only initial bootstrap. It is not a general migration command for a populated staging database:

- It refuses to seed when `control.users` holds any user other than the operator.
- It expects exactly 9 `control` and 17 `full-hosted` migrations and 13 hosted catalog sources, so a new migration needs a reviewed change to the script first.
- It connects to the VPS through `ssh vps` and `psql`, so run it from an operator workstation.

To run the script in read-only verification mode from the repository root, use `@uptime/api`'s declared `tsx` runner:
```bash
pnpm --filter @uptime/api exec tsx ../../scripts/postgres-staging-bootstrap.ts --verify-only
```
This invocation uses `@uptime/api`'s declared runner and connects through `ssh vps`. Remember that this script is strictly an initial/operator-only bootstrap tool and not a general migration command for a populated staging database.

### Status page font upgrade on populated staging

Run these commands from the repository root after reviewing the font migration and the current VPS Compose image tags. The dedicated upgrade tool checks all 14 catalog entries. The 13 populated schemas, `tenant_000` through `tenant_009`, `operator`, `test_001`, and `test_002`, use `full-hosted`. The catalog also lists `legacy_staging` with `legacy-staging`, but that schema is not provisioned on the current VPS. The tool reports and skips it only while the schema is absent; if it appears, a valid ledger is required. It rejects missing ledgers in populated schemas, profile or checksum changes, catalog drift, and pending migrations other than `0017_status_page_font_family.sql`. It does not seed control data or require empty application tables.

```bash
ssh vps "su - postgres -c 'pg_dump -Fc -d uptime_staging -f /var/backups/postgresql/uptime_staging-font-20261007.dump'"
ssh vps "su - postgres -c 'pg_restore --list /var/backups/postgresql/uptime_staging-font-20261007.dump'"
ssh vps "stat -c '%n %s bytes %y' /var/backups/postgresql/uptime_staging-font-20261007.dump"
pnpm --filter @uptime/api exec tsx ../../scripts/postgres-staging-upgrade.ts
```

Check that the plan lists exactly `0017_status_page_font_family.sql` once for each of the 13 populated schemas and reports `legacy_staging` absent. Apply the reviewed plan and verify the second plan reports zero pending migrations for all 13 populated schemas:

```bash
pnpm --filter @uptime/api exec tsx ../../scripts/postgres-staging-upgrade.ts --apply
pnpm --filter @uptime/api exec tsx ../../scripts/postgres-staging-upgrade.ts
```

Each schema runs in its own transaction under an advisory lock. The generator verifies applied checksums again inside that transaction, adds the column with `josefin-sans` as the default, and records `0017` in the same transaction. If a later schema fails, rerun after resolving the error; completed schemas are skipped. The old API and scheduler bundles do not select the new column, so deploy the new bundles after all 14 schemas pass.

Build both bundles and transfer only their build contexts. Record the two current image tags and IDs, then use fresh tags for the new images:

```bash
pnpm --filter @uptime/api-worker build:node
pnpm --filter @uptime/coordinator-worker build:node
scp apps/api-worker/dist/node/server.mjs deploy/vps/staging/Dockerfile.runtime root@217.217.227.164:/opt/uptime-staging-artifact/
scp apps/coordinator-worker/dist/node/scheduler.mjs deploy/vps/staging/Dockerfile.scheduler root@217.217.227.164:/opt/uptime-staging-scheduler-artifact/
ssh vps "docker inspect --format '{{.Config.Image}} {{.Image}}' uptime-staging-node-api uptime-staging-node-scheduler"
ssh vps "cd /opt/uptime-staging-artifact && docker build -t uptime-staging-api:font-20261007 -f Dockerfile.runtime ."
ssh vps "cd /opt/uptime-staging-scheduler-artifact && docker build -t uptime-staging-scheduler:font-20261007 -f Dockerfile.scheduler ."
ssh -t vps "vi /opt/uptime-staging/docker-compose.yml"
```

In that editor, change only the API and scheduler `image:` values to `uptime-staging-api:font-20261007` and `uptime-staging-scheduler:font-20261007`. Confirm the scheduler remains the sole active scheduler as required in section 5. Then recreate the two services and inspect health and publication logs:

```bash
ssh vps "cd /opt/uptime-staging && docker compose up -d --no-build --no-deps uptime-staging-node-api uptime-staging-node-scheduler && docker compose ps"
ssh vps "cd /opt/uptime-staging && docker compose logs --since=5m uptime-staging-node-scheduler"
ssh vps "su - postgres -c 'psql -d uptime_staging -c \"SELECT report_key, generated_at, status FROM operator.report_publications ORDER BY generated_at DESC LIMIT 5;\"'"
ssh vps "curl -fsS 'http://127.0.0.1:3001/reports/public/status-pages.json?workspace=<OPERATOR_WORKSPACE_UUID>'"
```

Replace `<OPERATOR_WORKSPACE_UUID>` with the operator workspace ID. The scheduler publishes fresh status page cohorts on its next due minute; look for `report_metrics` with `failed: 0` and `published` above zero for a tenant with pages. Check that `operator.report_publications` has an advanced `cohort` timestamp and that the public index includes `fontFamily`. For a page in that workspace, request `/reports/public/status-pages/<SLUG>.json?workspace=<OPERATOR_WORKSPACE_UUID>` and check `statusPage.fontFamily`. The API health check alone does not prove report publication.

For rollback, restore the recorded API and scheduler image tags in Compose and recreate those services with the same command above. Keep the added column and ledger entry in place: older bundles ignore them. A database restore would discard writes since the backup and needs a separate rehearsed recovery decision; do not drop or restore the live database as a routine code rollback.

### Backup & Restore
- Tracked configuration: `deploy/postgresql/vps/uptime-staging-backup.timer` (daily 03:00 UTC) triggers `uptime-staging-backup.service`, a oneshot `pg_dump -Fc` that replaces `/var/backups/postgresql/uptime_staging-latest.dump`.
- The repository does not prove the units are installed or that a dump exists. Check on the VPS before relying on it:
  ```bash
  ssh vps "systemctl list-timers uptime-staging-backup.timer; systemctl status uptime-staging-backup.service; ls -l /var/backups/postgresql/"
  ```
- Manual backup: `ssh vps "systemctl start uptime-staging-backup.service"`, then re-check the file time and size.
- Before replacing any data, confirm the dump is recent and readable (`pg_restore --list`), then restore it into an isolated scratch database and verify it there. Plan the cutover (stop API and scheduler, grants, role ownership) from that rehearsal. Do not drop the live database as a first step.

---

## 4. API Deployment (`uptime-staging-node-api`)

### Step 1: Build the API Bundle Locally
From repository root:
```bash
pnpm --filter @uptime/api-worker build:node
```
Generates self-contained bundle at `apps/api-worker/dist/node/server.mjs`.

### Step 2: Transfer the Build Context to VPS
The image build context is `/opt/uptime-staging-artifact/`, which needs only `server.mjs` and `Dockerfile.runtime`:
```bash
scp apps/api-worker/dist/node/server.mjs \
    deploy/vps/staging/Dockerfile.runtime \
    root@217.217.227.164:/opt/uptime-staging-artifact/
```
Do not copy `docker-compose.yml`, `catalog.json`, or any `.env` file in a routine deploy. The VPS copies hold server-side state and secrets. Copy the repository `docker-compose.yml` or `catalog.json` only for a first install or a reviewed change, after diffing against the VPS copy.

### Step 3: Build a New Image Tag
Never reuse a tag. Record the running image first so rollback stays possible:
```bash
ssh vps "docker inspect --format '{{.Config.Image}} {{.Image}}' uptime-staging-node-api"
ssh vps "cd /opt/uptime-staging-artifact && docker build -t uptime-staging-api:<NEW_TAG> -f Dockerfile.runtime ."
```
Keep the previous tag and image ID in your deploy notes.

### Step 4: Point Compose at the New Tag and Recreate the API
`docker compose ... --no-build` never builds; the image must already exist from Step 3. On the VPS, edit only the `image:` line of `uptime-staging-node-api` in `/opt/uptime-staging/docker-compose.yml`, then:
```bash
ssh vps "cd /opt/uptime-staging && docker compose up -d --no-build --no-deps uptime-staging-node-api"
```
The scheduler container is not touched.

---

## 5. Minute Scheduler Deployment (`uptime-staging-node-scheduler`)

### Step 1: Build the Scheduler Bundle Locally
From repository root:
```bash
pnpm --filter @uptime/coordinator-worker build:node
```
Generates self-contained bundle at `apps/coordinator-worker/dist/node/scheduler.mjs`.

### Step 2: Transfer the Build Context to VPS
The build context is `/opt/uptime-staging-scheduler-artifact/`, which needs only `scheduler.mjs` and `Dockerfile.scheduler`. It does not depend on an API deploy:
```bash
scp apps/coordinator-worker/dist/node/scheduler.mjs \
    deploy/vps/staging/Dockerfile.scheduler \
    root@217.217.227.164:/opt/uptime-staging-scheduler-artifact/
```
The same rule applies as for the API: do not overwrite the VPS `docker-compose.yml`, `catalog.json`, or `.env` files.

### Step 3: Build a New Image Tag
```bash
ssh vps "docker inspect --format '{{.Config.Image}} {{.Image}}' uptime-staging-node-scheduler"
ssh vps "cd /opt/uptime-staging-scheduler-artifact && docker build -t uptime-staging-scheduler:<NEW_TAG> -f Dockerfile.scheduler ."
```
Keep the previous tag and image ID in your deploy notes.

### Step 4: Check Configuration
Confirm `/opt/uptime-staging/scheduler.env` exists (mode `0600`) with `SCHEDULER_ENABLED=true`, and that the Cloudflare coordinator cron is removed (section 6). Never run two schedulers.

### Step 5: Point Compose at the New Tag and Recreate the Scheduler
Edit only the `image:` line of `uptime-staging-node-scheduler` in `/opt/uptime-staging/docker-compose.yml`, then:
```bash
ssh vps "cd /opt/uptime-staging && docker compose up -d --no-build --no-deps uptime-staging-node-scheduler"
```
The API container is not touched. This works on its own, with no prior API deploy.

---

## 6. Cloudflare Worker Deployments (Proxy & Fence)

Staging uses Cloudflare Workers for the VPC ingress proxy and the fenced coordinator.

### VPC API Proxy Worker
Deploy the proxy Worker under `uptime-staging-oauth-api`:
```bash
pnpm --filter @uptime/api-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/vps-api-proxy/wrangler.toml
```
Or via script:
```bash
scripts/deploy-hosted-workers.sh --environment staging --target api
```

### Fenced Coordinator
Deploy the coordinator fence (preserves `drain-entry.ts`, empty crons, no queue consumer):
```bash
pnpm --filter @uptime/coordinator-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/hosted-coordinator/wrangler.toml
```
Or via script:
```bash
scripts/deploy-hosted-workers.sh --environment staging --target coordinator
```

---

## 7. Health Verification & Troubleshooting

### 1. Verify Containers
```bash
ssh vps "cd /opt/uptime-staging && docker compose ps"
```
Both `uptime-staging-node-api` (Up, healthy) and `uptime-staging-node-scheduler` (Up) should be active.

### 2. Verify API Health & Ingress Security
On the VPS:
```bash
# 1. Loopback health endpoint
curl -i http://127.0.0.1:3001/health
# Expected: HTTP/1.1 200 OK {"status":"ok",...}

# 2. Unauthenticated request without the gateway token (must be rejected)
curl -i http://127.0.0.1:3001/api/interest/session
# Expected: HTTP/1.1 403 Forbidden
```
Then load the staging site through Cloudflare Pages in an existing authenticated browser session and confirm the app loads and API calls succeed. Do not put the gateway token on a command line.

### 3. Verify Scheduler Execution
```bash
ssh vps "cd /opt/uptime-staging && docker compose logs --tail=50 -f uptime-staging-node-scheduler"
```
Expected output per minute:
- `scheduler_tick_started`
- `tenant_job_started` (`maintenanceOnly: false` when budget disabled)
- `tenant_job_completed`
- `scheduler_dispatch attempted:N sent:N failed:0`
- `scheduler_tick_completed`

A sent outbox row or a completed tick does not prove monitoring works. Confirm new regional rows in `observations` and `check_runs` in the tenant schema of a monitor you expect to run (query as `uptime_staging_owner` on the VPS). Each monitor's own interval still decides when it is due, so wait at least one interval. A manually paused monitor, fleet, or workspace, or a capacity limit, can still prevent probes even with `BUDGET_ENFORCEMENT_DISABLED=true`.

### Troubleshooting Common Issues
- `invalid_configuration`: The scheduler exits 1 on startup if an environment variable is missing or malformed. Inspect logs to see the named variable.
- `report_pending` / `503`: The Node API report route queries R2. If credentials or report pointer objects are missing, `report_pending` is returned.
- `imported_unavailable`: Requests for legacy imported workspaces return 503 on Node API; imported routes continue to resolve through legacy Cloudflare Workers.
- Budget bypass verification:
  ```bash
  ssh vps "docker exec uptime-staging-node-api printenv BUDGET_ENFORCEMENT_DISABLED"
  ssh vps "docker exec uptime-staging-node-scheduler printenv BUDGET_ENFORCEMENT_DISABLED"
  ```
  Both must output `true`.

---

## 8. Rollback Procedures (Zero Dual Schedulers)

### Scheduler Rollback
**Routine rollback is the previous VPS scheduler image.** Set the scheduler `image:` line in `/opt/uptime-staging/docker-compose.yml` back to the recorded previous tag (the image must still exist on the VPS; check with `docker image ls uptime-staging-scheduler`), then:
```bash
ssh vps "cd /opt/uptime-staging && docker compose up -d --no-build --no-deps uptime-staging-node-scheduler"
```
To pause dispatch without rolling back, run `docker compose stop uptime-staging-node-scheduler`, or set `SCHEDULER_ENABLED=false` in `scheduler.env` and recreate the container.

**Returning to Cloudflare is a separate migration, not a rollback step.** The fenced coordinator's `scheduled` handler in `drain-entry.ts` is a no-op, so re-adding the cron or queue consumer does nothing on its own. It needs a reviewed runtime and queue config, producers, drain, and leases paused, and verified proof that the VPS scheduler is stopped and nothing overlaps before any Cloudflare scheduler starts.

### API Rollback
1. Roll back the VPS API by setting the `uptime-staging-node-api` `image:` line back to the recorded previous tag, then:
   ```bash
   ssh vps "cd /opt/uptime-staging && docker compose up -d --no-build --no-deps uptime-staging-node-api"
   ```
2. For the Cloudflare proxy Worker, redeploy the current proxy config (section 6), or use `wrangler rollback` only to a version known to be a VPS proxy build. Rolling back to an arbitrary older `uptime-staging-oauth-api` version can restore the retired Worker runtime and its cron.
   ```bash
   pnpm --filter @uptime/api-worker exec wrangler rollback <KNOWN_PROXY_VERSION_ID> --name uptime-staging-oauth-api
   ```
