# Cloudflare deployment files

> [!IMPORTANT]
> **ENVIRONMENT DISTINCTION**:
> - **Production**: 100% hosted on Cloudflare Workers, Cloudflare D1 databases, R2 storage, and Pages. All D1 commands, migrations, and hosted worker deployment steps here apply to production.
> - **Staging**: Core API and minute scheduler run on a Debian 12 VPS (`217.217.227.164`) on PostgreSQL 18. Staging uses Cloudflare Pages for UI, a VPC proxy Worker (`uptime-staging-oauth-api`) to forward ingress through Cloudflare Tunnel, and regional probe Workers. Staging D1 is retired. See [deploy/cloudflare/staging/README.md](staging/README.md) and the canonical [VPS staging runbook](../vps/staging/README.md).

Run every command in this guide from the repository root.

## Choose the right configuration

| Target | Configuration | How it is maintained |
| --- | --- | --- |
| Generic API preset | `deploy/cloudflare/api/wrangler.toml` | Placeholder D1 ID and origin |
| Generic coordinator | `deploy/cloudflare/coordinator/wrangler.toml` | Edit by hand |
| Production API bridge | `deploy/cloudflare/production/legacy-api.wrangler.toml` | Existing production database |
| Production reporter | `deploy/cloudflare/production/reporter.wrangler.toml` | Existing cron and Workflow bindings |
| Hosted production | `deploy/cloudflare/hosted/` | Hosted API and coordinator (D1-backed) |
| Production Pages | `deploy/cloudflare/pages/wrangler.toml` | Edit by hand |
| Production test target | `deploy/cloudflare/target/wrangler.toml` | Edit by hand |
| Production probes | `deploy/cloudflare/wrangler.<region>.toml` | Generated via `pnpm generate:wrangler` |
| Staging Cloudflare | `deploy/cloudflare/staging/` | See the [staging guide](staging/README.md) and [VPS guide](../vps/staging/README.md) |

The probe generator only owns the root `wrangler.<region>.toml` files. It does not touch the API, coordinator, reporter, Pages, test target, or staging configurations.

For the existing production database and `https://uptime.noz.am` Pages site, use the [production import rollout](../../docs/deployment/free-hosted.md#production-import-rollout-for-uptimenozaam). The generic API config points at a placeholder D1 ID and includes a tenant migrations directory. Do not use `scripts/deploy-app-workers.sh` for that production database; its migration step targets `uptime`.

## Deploy the API and coordinator

### Production Hosted Workers
In production, hosted workers use Cloudflare D1 multi-tenant pools:

```bash
# Dry run
scripts/deploy-hosted-workers.sh --environment production --dry-run

# Deploy production hosted workers (provisions D1 pool, verifies operator, deploys)
scripts/deploy-hosted-workers.sh --environment production
```

`scripts/provision-tenant-pool.sh` and `scripts/bootstrap-operator-workspace.sh` manage the production D1 pool. Both scripts automatically reject staging, as staging D1 is retired in favor of native PostgreSQL on VPS.

### Staging Cloudflare Workers
In staging, `scripts/deploy-hosted-workers.sh --environment staging` skips D1 provisioning and deploys the VPC API proxy Worker (`uptime-staging-oauth-api`) and the fenced coordinator (`uptime-staging-hosted-coordinator`):

```bash
scripts/deploy-hosted-workers.sh --environment staging --dry-run
scripts/deploy-hosted-workers.sh --environment staging
```

For app worker presets using untracked secrets files:
```bash
scripts/deploy-app-workers.sh --dry-run
scripts/deploy-app-workers.sh --secrets-file /path/to/app-secrets.env
```

See the [deployment runbook](../../docs/operations/deployment-runbook.md) for required bindings, variables, secrets, local development, deployment, and rollback.

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

Probe configurations come from the region registry in `packages/regions`. Regenerate and check them before deployment:

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

Every deployed probe must use the same high-entropy `PROBE_SIGNING_SECRET` as the coordinator / scheduler.

Set `REGIONS_LIST` in the environment or the repository `.env` file to deploy only part of the fleet. The script preserves the listed order:

```dotenv
REGIONS_LIST="asia-east,asia-south"
```

When `REGIONS_LIST` is absent, the script deploys every generated probe. The same region list controls the API monitor editor and coordinator scheduling.

Set `WORKERS_URL_DOMAIN` on the coordinator to the account suffix reported by Wrangler, such as `account-subdomain.workers.dev`. The coordinator calls probes at `https://uptime-probe-{region}.{WORKERS_URL_DOMAIN}`.

Do not commit account IDs or secrets unless they are intentionally public.

## Probe placement

| Worker | Region | Placement hint |
| --- | --- | --- |
| `uptime-probe-us-east` | `us-east` | `aws:us-east-1` |
| `uptime-probe-us-west` | `us-west` | `aws:us-west-2` |
| `uptime-probe-canada-central` | `canada-central` | `aws:ca-central-1` |
| `uptime-probe-eu-west` | `eu-west` | `aws:eu-west-1` |
| `uptime-probe-eu-north` | `eu-north` | `aws:eu-north-1` |
| `uptime-probe-eu-south` | `eu-south` | `aws:eu-south-1` |
| `uptime-probe-asia` | `asia` | `aws:ap-southeast-1` |
| `uptime-probe-asia-east` | `asia-east` | `aws:ap-northeast-1` |
| `uptime-probe-asia-south` | `asia-south` | `aws:ap-south-1` |

Placement hints express regional affinity. They do not guarantee a fixed city, Cloudflare point of presence, or source IP.

To verify placement:
1. Point a temporary monitor at an HTTPS echo service you control.
2. Run every enabled probe long enough to collect representative results.
3. Save each result's `colo` and the echo service's source metadata.
4. Compare those records with `https://<probe>/cdn-cgi/trace`.

Workers do not reveal the full DNS chain or the final TCP destination used by `fetch`. The probe blocks forbidden literal addresses and checks redirect URLs, but private origins still need their own access controls.

## Report publication

In production, the coordinator starts probe work and report publication as separately leased jobs. A long probe run does not suppress that minute's report job.

The production publisher:
- caches 89 closed UTC days in R2 and reads the current day from D1;
- invalidates cached days after historical writes through migration `0007`;
- publishes standalone monitors and status pages through the same atomic cohort;
- keeps up to the configured sample limit (5,000 by default) per monitor in eight private R2 shards, with a 50,000-row limit per shard; dense shards retain fewer newest rows per monitor and expose the actual `sampleLimit` and `sampled` flags;
- bounds compressed and decoded sample objects to 8 MiB each;
- reads at most two sample shards concurrently, draining both reads before propagating failure, while parsing and writing shards sequentially;
- rebuilds cold or invalidated histories in bounded batches per shard, combining up to five indexed monitor scans per D1 statement while retaining each monitor's row limit; recovery uses stored observations and completes in the same run;
- refreshes latency ranges and percentiles at each monitor's configured cadence;
- renews the owning report lease at publication boundaries, only while its token still owns an unexpired lease, so slow storage reads do not abort progressing work; and
- commits one cohort pointer only after every public object is ready.

The `reports` row in the D1 `jobs` table records duration, statement count, and native query metrics. Report publication has a 100-statement ceiling.

Migration `0013` retires the unused observation changefeed triggers. Reporting no longer reads or cleans that feed; its table remains for rollback compatibility. Hourly dirty keys still drive latency aggregation. `REPORT_SCHEDULE_DISABLED=true` skips publication without claiming the separate reporter's lease or changing its metrics.

Migration `0014` removes redundant observation indexes on check-run ID and error code. The unique check-run/region index supports round lookups. Monitor-wide history, regional history, retention, and failed-result recovery retain their dedicated indexes; observation identity and duplicate protection remain intact.

## On-demand monitor reports

In production, monitor views retrieve database data directly. Summary, uptime, latency, and history requests are cached per isolate for exactly 60 seconds. Every request checks authentication, workspace access, and public visibility before using the cache; public and private entries are separate. Monitor reports are no longer generated or persisted in R2. Status-page snapshots keep their existing publication.

The compatibility monitor report endpoint uses persisted hourly latency aggregates for closed history. It reads the current rolling 24-hour window from raw observations, starting at its floored hour (up to 25 hours), and reads raw data for the partial oldest hours at the 7-day and 30-day boundaries. Hourly rows retain exact latency-value frequencies for percentiles and 15-minute summaries for chart detail. A coverage row is written only after backfill completes, so uncovered monitors continue using the raw-history path.

Migration `0010_monitor_latency_hourly.sql` creates the aggregate, dirty-hour, and coverage tables. Deploying the API or coordinator applies pending migrations. Afterward, backfill existing monitors for the production database:

```bash
pnpm --filter @uptime/coordinator-worker exec tsx ../../scripts/backfill-hourly-latency.mts \
  --database uptime --config ../../deploy/cloudflare/api/wrangler.toml --remote
```

The reporter repairs up to four fully closed dirty monitor-hours per minute. Observation inserts, corrections, and deletions mark hours for repair. The old monitor Workflow entry point remains only to drain deployed instances, and does no work. Latency history remains limited by raw observation retention: seven days by default in production and 30 days in staging; aggregates do not extend that history.
