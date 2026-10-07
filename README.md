# Multi-region uptime monitor

Uptime monitoring on Cloudflare Workers, D1, R2, and Pages, with checks from up
to nine regions. Includes latency charts, request history, optional DNS
diagnostics, notification destinations, public monitor views, and grouped
status pages.

## Environment Architecture

- **Production**: Operates 100% on Cloudflare Workers, Cloudflare D1 multi-tenant databases, R2 storage, and Cloudflare Pages. See the [Cloudflare deployment guide](deploy/cloudflare/README.md) and [hosted runbook](docs/deployment/free-hosted.md).
- **Staging**: Core API and scheduler run on a Debian 12 VPS (`217.217.227.164`) co-located with PostgreSQL 18. Frontend UI is served by Cloudflare Pages (`https://uptime-staging.pages.dev`), routing API traffic through Cloudflare Tunnel to the loopback Node API (`127.0.0.1:3001`). Regional probe Workers execute health checks across Cloudflare PoPs. See the canonical [VPS staging runbook](deploy/vps/staging/README.md) and [Cloudflare staging guide](deploy/cloudflare/staging/README.md).

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

- The API layer handles authentication, configuration, and private history.
  - In staging: Node 24 service `uptime-staging-node-api` runs on VPS loopback `127.0.0.1:3001` backed by PostgreSQL 18.
  - In production: Worker `uptime-hosted-api` runs on Cloudflare Workers backed by D1.
- The coordinator / scheduler claims due checks and sends signed regional probe batches.
  - In staging: Node 24 service `uptime-staging-node-scheduler` runs as a single minute dispatcher on the VPS. The Cloudflare staging coordinator is fenced (`crons = []`, no queue consumers).
  - In production: Cloudflare Worker coordinator claims checks via D1 queues.
- A separately leased report job publishes status-page snapshots to R2. Public
  monitor snapshots are built on demand by the reporter and cached in R2;
  Workflow startup runs in the background after the initial snapshot is saved.
  Status-page publication also starts a refresh cycle for monitors currently
  down or recovering; active cycles are reused.
- Regional probe Workers perform the target HTTP requests across worldwide PoPs.
- Cloudflare Pages serves the React UI.

## Development and verification

Requires Node.js 24+, pnpm 11.24.0, and a Cloudflare account for deployment.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm hash:admin
```

Copy the required API values from `.env.example` into an ignored
`deploy/cloudflare/api/.dev.vars` file and fill in local secrets. The password
helper prints a Workers-compatible PBKDF2 hash. Start the API and UI in separate
terminals:

```sh
pnpm --filter @uptime/api-worker dev
pnpm --filter @uptime/web dev
```

Vite serves the UI on port 5176 and proxies `/api` to the local API Worker on
port 8787. Set `UPTIME_API_PROXY_TARGET` if using another port. Background checks
also require coordinator bindings, secrets, and reachable regional probes; see
the [deployment runbook](docs/operations/deployment-runbook.md).

### Compiling VPS Bundles (Staging)
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
bash scripts/tests/run-cloudflare-tooling.sh
scripts/tests/deploy-workers.sh
pnpm generate:wrangler -- --check
node --test deploy/cloudflare/staging/pages/gateway.test.mjs
```

## Deployment

- **Production Deployment**: Follow the [Cloudflare deployment guide](deploy/cloudflare/README.md) and [hosted setup](docs/deployment/free-hosted.md). Run `scripts/deploy-hosted-workers.sh --environment production` to provision tenant D1 pools and deploy production Workers.
- **Staging Deployment**: Follow the [canonical VPS staging runbook](deploy/vps/staging/README.md). Run `scripts/deploy-hosted-workers.sh --environment staging` to deploy the Cloudflare VPC proxy Worker (`uptime-staging-oauth-api`) and fenced coordinator, and manage PostgreSQL via `scripts/postgres-staging-bootstrap.ts`.

Validate bundles without deploying:

```sh
scripts/deploy-app-workers.sh --dry-run
scripts/deploy-workers.sh --dry-run
scripts/deploy-hosted-workers.sh --environment production --dry-run
scripts/deploy-hosted-workers.sh --environment staging --dry-run
```

## Operational behavior

- Region placement hints express affinity, not a guaranteed city or source IP.
- Requests require an HMAC signature and a current timestamp.
- Detailed observations default to seven days of retention; daily aggregates
  remain available. DNS diagnostics default to 30 days.
- Public monitor reports include the available retained observation history.
  The Pages gateway routes monitor requests to the reporter, which builds an
  initial snapshot when needed, considers it fresh for 120 seconds, and starts
  up to four one-minute refreshes. Workflow creation does not delay the initial
  response. Closed latency history uses persisted hourly aggregates; the
  rolling 24-hour window (up to 25 hours from the floored hour) and partial
  oldest hours at the 7-day and 30-day boundaries use raw observations. Each
  aggregate keeps exact latency-value frequencies and 15-minute summaries, so
  percentiles and chart detail remain available.
- Uptime charts use cached daily bars for closed days and aggregate the current
  day's observations separately.
- HTTP notification providers are supported; SMTP delivery is unsupported in
  this application’s Worker implementation. See the
  [notification guide](docs/operations/notifications.md).
- Monitor intentionally public targets. Literal-address and redirect checks
  do not provide DNS-to-socket pinning or replace origin access controls.
- Staging budget policy: Budget enforcement is intentionally disabled on staging VPS (`BUDGET_ENFORCEMENT_DISABLED=true`). Production defaults remain strictly enforced.

See [architecture](docs/architecture/mvp.md) for the runtime responsibilities,
[deploy/vps/staging/README.md](deploy/vps/staging/README.md) for staging VPS operations,
and [operations](docs/operations/deployment-runbook.md) for general configuration.
