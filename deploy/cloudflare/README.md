# Cloudflare deployment files

Run every command in this guide from the repository root.

## Choose the right configuration

| Target                 | Configuration                                 | How it is maintained                       |
| ---------------------- | --------------------------------------------- | ------------------------------------------ |
| Production API         | `deploy/cloudflare/api/wrangler.toml`         | Edit by hand                               |
| Production coordinator | `deploy/cloudflare/coordinator/wrangler.toml` | Edit by hand                               |
| Production reporter    | `deploy/cloudflare/reporter/wrangler.toml`    | Edit by hand                               |
| Production Pages       | `deploy/cloudflare/pages/wrangler.toml`       | Edit by hand                               |
| Production test target | `deploy/cloudflare/target/wrangler.toml`      | Edit by hand                               |
| Production probes      | `deploy/cloudflare/wrangler.<region>.toml`    | Generated                                  |
| Staging                | `deploy/cloudflare/staging/`                  | See the [staging guide](staging/README.md) |

The probe generator only owns the root `wrangler.<region>.toml` files. It does
not touch the API, coordinator, reporter, Pages, test target, or staging
configurations.

## Deploy the API and coordinator

First validate both Workers without changing Cloudflare:

```bash
scripts/deploy-app-workers.sh --dry-run
```

Then deploy with an untracked secrets file:

```bash
scripts/deploy-app-workers.sh --secrets-file /path/to/app-secrets.env
```

The script applies pending D1 migrations before it deploys either Worker. Use
`--target api` or `--target coordinator` to deploy one Worker.

See the [deployment runbook](../../docs/operations/deployment-runbook.md) for
required bindings, variables, secrets, local development, deployment, and
rollback.

## Deploy the reporter, gateway, and test target

The app deployment script deploys only the API and coordinator. Deploy the
separate reporter and test target explicitly:

```bash
apps/api-worker/node_modules/.bin/wrangler deploy --config deploy/cloudflare/reporter/wrangler.toml
apps/api-worker/node_modules/.bin/wrangler deploy --config deploy/cloudflare/target/wrangler.toml
```

Build the frontend with the production gateway origin, then package the shared
Pages Worker and deploy with the production service and R2 bindings:

```bash
VITE_API_BASE_URL=/api VITE_REPORTS_BASE_URL=https://uptime-2l5.pages.dev/reports pnpm --filter @uptime/web build --outDir ../../dist/production/web --emptyOutDir
cp deploy/cloudflare/staging/pages/_worker.js dist/production/web/_worker.js
apps/api-worker/node_modules/.bin/wrangler pages deploy ../../../dist/production/web --cwd deploy/cloudflare/pages --project-name uptime --branch main --commit-dirty=true
```

Production uses `https://uptime-2l5.pages.dev`, D1 `uptime`, private R2
`uptime-reports`, and Workflow `uptime-monitor-refresh`. Do not substitute
staging bindings. As verified on 2026-10-05, `uptime.noz.am` serves production;
`uptime-staging.pages.dev` serves staging. Inspect live Pages bindings before
deployment: the hosted gateway uses `IMPORTED_*` bindings for existing reports.

## Deploy regional probes

Probe configurations come from the region registry in `packages/regions`.
Regenerate and check them before deployment:

```bash
pnpm generate:wrangler
pnpm generate:wrangler -- --check
```

Authenticate, run a dry run, then deploy:

```bash
pnpm --filter @uptime/probe-worker exec wrangler login
scripts/deploy-workers.sh --dry-run
scripts/deploy-workers.sh --secrets-file /path/to/probe-secrets.env
```

Every deployed probe must use the same high-entropy `PROBE_SIGNING_SECRET` as
the coordinator.

Set `REGIONS_LIST` in the environment or the repository `.env` file to deploy
only part of the fleet. The script preserves the listed order:

```dotenv
REGIONS_LIST="asia-east,asia-south"
```

When `REGIONS_LIST` is absent, the script deploys every generated probe. The
same region list controls the API monitor editor and coordinator scheduling.

Set `WORKERS_URL_DOMAIN` on the coordinator to the account suffix reported by
Wrangler, such as `account-subdomain.workers.dev`. The coordinator calls probes
at `https://uptime-probe-{region}.{WORKERS_URL_DOMAIN}`.

Do not commit account IDs or secrets unless they are intentionally public.

## Probe placement

| Worker                        | Region           | Placement hint       |
| ----------------------------- | ---------------- | -------------------- |
| `uptime-probe-us-east`        | `us-east`        | `aws:us-east-1`      |
| `uptime-probe-us-west`        | `us-west`        | `aws:us-west-2`      |
| `uptime-probe-canada-central` | `canada-central` | `aws:ca-central-1`   |
| `uptime-probe-eu-west`        | `eu-west`        | `aws:eu-west-1`      |
| `uptime-probe-eu-north`       | `eu-north`       | `aws:eu-north-1`     |
| `uptime-probe-eu-south`       | `eu-south`       | `aws:eu-south-1`     |
| `uptime-probe-asia`           | `asia`           | `aws:ap-southeast-1` |
| `uptime-probe-asia-east`      | `asia-east`      | `aws:ap-northeast-1` |
| `uptime-probe-asia-south`     | `asia-south`     | `aws:ap-south-1`     |

Placement hints express regional affinity. They do not guarantee a fixed city,
Cloudflare point of presence, or source IP.

To verify placement:

1. Point a temporary monitor at an HTTPS echo service you control.
2. Run every enabled probe long enough to collect representative results.
3. Save each result's `colo` and the echo service's source metadata.
4. Compare those records with `https://<probe>/cdn-cgi/trace`.

Workers do not reveal the full DNS chain or the final TCP destination used by
`fetch`. The probe blocks forbidden literal addresses and checks redirect URLs,
but private origins still need their own access controls.

## Report publication

Production runs probe scheduling in `uptime-coordinator` and publication in
`uptime-reporter`, each with a minute cron. The coordinator sets
`REPORT_SCHEDULE_DISABLED=true` so the separate reporter owns publication.

The reporter publishes the status-page index and status-page reports through an
atomic R2 cohort. The gateway resolves those objects through `public/cohort.json`;
the pointer is committed only after every public object is ready.

Standalone monitor reports have independent generations. The Pages gateway
forwards them to its `REPORTER` service binding instead of resolving them through
the status-page cohort. Monitor refresh uses the `MONITOR_REFRESH` Workflow binding.

The `reports` row in the D1 `jobs` table records duration, statement count, and
native query metrics. Report publication has a 100-statement ceiling.

## On-demand monitor reports

Public monitor snapshots use persisted hourly latency aggregates for closed
history. Reports read the current rolling 24-hour window from raw observations,
starting at its floored hour (up to 25 hours), and read raw data for the partial
oldest hours at the 7-day and 30-day boundaries. Hourly rows retain exact
latency-value frequencies for percentiles and 15-minute summaries for chart
detail. A coverage row is written only after backfill completes, so uncovered
monitors continue using the raw-history path.

Migration `0010_monitor_latency_hourly.sql` creates the aggregate, dirty-hour,
and coverage tables. Deploying the API or coordinator applies pending migrations.
Afterward, backfill existing monitors with the command for the target database:

```bash
pnpm --filter @uptime/coordinator-worker exec tsx ../../scripts/backfill-hourly-latency.mts --database uptime --config ../../deploy/cloudflare/api/wrangler.toml --remote
pnpm --filter @uptime/coordinator-worker exec tsx ../../scripts/backfill-hourly-latency.mts --database uptime-staging --config ../../deploy/cloudflare/staging/api/wrangler.toml --remote
```

The reporter repairs up to four fully closed dirty monitor-hours per minute.
Observation inserts, corrections, and deletions mark hours for repair. A GET
starts a durable Workflow before building the initial report, then waits up to
20 seconds for its snapshot. Startup survives a disconnected request. The Workflow
also performs four subsequent refreshes at one-minute intervals. Latency history remains limited by raw
observation retention: production and staging both retain 30 days; aggregates
do not extend that history.
