# Multi-region uptime monitor

Uptime monitoring on a Node API and scheduler backed by PostgreSQL, with
checks from up to nine regions run by Cloudflare probe Workers. Includes latency
charts, request history, optional DNS diagnostics, notification destinations,
public monitor views, and grouped status pages.

## Environment Architecture

Production and staging run the same way. The API and the scheduler are Node 24
services on a VPS next to PostgreSQL 18, and a reverse proxy on the VPS serves
the built web UI. Cloudflare only hosts the regional probe Workers and the test
target Worker.

- **Production**: See the [deployment runbook](docs/operations/deployment-runbook.md) and the [Cloudflare probe guide](deploy/cloudflare/README.md).
- **Staging**: Debian 12 VPS (`217.217.227.164`). See the canonical [VPS staging runbook](deploy/vps/staging/README.md) and the [Cloudflare staging probe guide](deploy/cloudflare/staging/README.md).

## Free hosted version

The [first version](docs/plans/free-v1-implementation.md) includes AT Protocol
OAuth signup, dedicated customer databases, team access, and an operator dashboard.
Use the [hosted runbook](docs/deployment/free-hosted.md) for local OAuth development
and deployment. Its $20 forecast guard requires Cloudflare billing alerts.
The public landing currently collects interest through identity-only AT Protocol
OAuth. Signups appear in the operator page and do not allocate workspace databases.
The [product release plan](docs/plans/product-release-plan.md) covers positioning,
user journeys, operations, launch gates, and the broader roadmap.
The [platform research](docs/research/saas-platform-research.md) records infrastructure
limits, costs, and requirements for a later paid release.

## Architecture

- The API layer (`apps/api-worker`, Node 24 and PostgreSQL 18 only) handles authentication, configuration, and private history.
- The coordinator / scheduler (`apps/coordinator-worker`, Node 24) runs as a single minute dispatcher. It claims due checks and sends signed regional probe batches.
- The scheduler publishes reports to R2 through the API's configured storage integration.
- Regional probe Workers perform the target HTTP requests across worldwide PoPs.
- The VPS reverse proxy serves the React UI built with `pnpm --filter @uptime/web build`.

## Development and verification

Requires Node.js 24+, pnpm 11.24.0, a PostgreSQL 18 database, and a Cloudflare
account for deploying probes.

```sh
pnpm install --frozen-lockfile
pnpm hash:admin
```

Copy the required API values from `.env.example` into an ignored `.env` file and
fill in local secrets. Build and start the API, then start the UI in a separate
terminal:

```sh
pnpm --filter @uptime/api-worker build:node
pnpm --filter @uptime/api-worker start:node
pnpm --filter @uptime/web dev
```

Vite serves the UI on port 5176 and proxies `/api` to the local API on
port 8787. Set `UPTIME_API_PROXY_TARGET` if using another port. Background checks
also require the scheduler, secrets, and reachable regional probes; see
the [deployment runbook](docs/operations/deployment-runbook.md).

### Compiling VPS Bundles
```sh
# Build Node 24 API bundle (apps/api-worker/dist/node/server.mjs)
pnpm --filter @uptime/api-worker build:node

# Build Node 24 Scheduler bundle (apps/coordinator-worker/dist/node/scheduler.mjs)
pnpm --filter @uptime/coordinator-worker build:node
```

### Checks and Tests
```sh
pnpm typecheck
pnpm test
pnpm build
scripts/tests/deploy-workers.sh
pnpm generate:wrangler -- --check
```

## Deployment

- **Production Deployment**: Follow the [VPS deployment runbook](deploy/vps/staging/README.md) for the API, scheduler, and web UI, and the [deployment runbook](docs/operations/deployment-runbook.md) for the overall sequence and rollback. Deploy probe Workers with the [Cloudflare probe guide](deploy/cloudflare/README.md).
- **Staging Deployment**: Follow the [canonical VPS staging runbook](deploy/vps/staging/README.md) and manage PostgreSQL via `scripts/postgres-staging-bootstrap.ts`.

Validate the probe bundles without deploying:

```sh
scripts/deploy-workers.sh --dry-run
```

## Operational behavior

- Region placement hints express affinity, not a guaranteed city or source IP.
- Requests require an HMAC signature and a current timestamp.
- Detailed observations default to seven days of retention; daily aggregates
  remain available. DNS diagnostics default to 30 days.
- Public monitor reports include the available retained observation history.
  Closed latency history uses persisted hourly aggregates; the
  rolling 24-hour window (up to 25 hours from the floored hour) and partial
  oldest hours at the 7-day and 30-day boundaries use raw observations. Each
  aggregate keeps exact latency-value frequencies and 15-minute summaries, so
  percentiles and chart detail remain available.
- Uptime charts use cached daily bars for closed days and aggregate the current
  day's observations separately.
- HTTP notification providers are supported; SMTP delivery is unsupported in
  this application.
- Monitor intentionally public targets. Literal-address and redirect checks
  do not provide DNS-to-socket pinning or replace origin access controls.
- Staging budget policy: Budget enforcement is intentionally disabled on staging VPS (`BUDGET_ENFORCEMENT_DISABLED=true`). Production defaults remain strictly enforced.

See [architecture](docs/architecture/mvp.md) for the runtime responsibilities,
[deploy/vps/staging/README.md](deploy/vps/staging/README.md) for staging VPS operations,
and [operations](docs/operations/deployment-runbook.md) for general configuration.
