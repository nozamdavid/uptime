# Multi-region uptime monitor

Uptime monitoring on Cloudflare Workers, D1, R2, and Pages, with checks from up
to nine regions. Includes latency charts, request history, optional DNS
diagnostics, notification destinations, public monitor views, and grouped
status pages.

## Architecture

- The API Worker handles authentication, configuration, and private history.
- The coordinator claims due checks, sends signed regional probe batches, and
  stores observations in D1. Notification delivery and retention are bounded.
- A separately leased report job publishes status-page snapshots to R2. Public
  monitor snapshots are built on demand by the reporter and cached in R2;
  Workflow startup runs in the background after the initial snapshot is saved.
  Status-page publication also starts a refresh cycle for monitors currently
  down or recovering; active cycles are reused.
- Regional Workers perform the target requests; Pages serves the React UI.
- D1 migrations and triggers maintain daily uptime after detailed results expire.

The retired PostgreSQL API, scheduler, schema, exporters, and Docker packaging
are no longer part of this checkout. Historical migration and audit documents
remain as records; use the current Cloudflare guides for operations.

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

Follow the [Cloudflare deployment guide](deploy/cloudflare/README.md). Production
and staging use separate checked-in Wrangler configurations; the
[staging guide](deploy/cloudflare/staging/README.md) documents the existing
isolated environment. Validate bundles without deploying:

```sh
scripts/deploy-app-workers.sh --dry-run
scripts/deploy-workers.sh --dry-run
```

The app deployment script applies pending D1 migrations before deploying the
API or coordinator. Secrets and existing data are not stored in the repository.

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
  percentiles and chart detail remain available. Until a monitor's backfill
  coverage is ready, reports use the raw-history path. Migration `0010` adds
  these aggregates; existing monitors are populated with
  `scripts/backfill-hourly-latency.mts` (see the [Cloudflare guide](deploy/cloudflare/README.md)).
  Background maintenance repairs up to four closed monitor-hours per minute;
  observation inserts, corrections, and deletions mark hours for repair.
  Latency history still follows raw-observation retention: seven days by
  default in production and 30 days in staging. Reports expose freshness
  metadata; private history remains available through the API.
- Uptime charts use cached daily bars for closed days and aggregate the current
  day's observations separately.
- HTTP notification providers are supported; SMTP delivery is unsupported in
  this application’s Worker implementation. See the
  [notification guide](docs/operations/notifications.md).
- Monitor intentionally public targets. Literal-address and redirect checks
  do not provide DNS-to-socket pinning or replace origin access controls.

See [architecture](docs/architecture/mvp.md) for the runtime responsibilities
and [operations](docs/operations/deployment-runbook.md) for configuration and
troubleshooting.
