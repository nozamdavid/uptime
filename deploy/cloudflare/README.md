# Cloudflare deployment files

Run every command in this guide from the repository root.

## Choose the right configuration

| Target                 | Configuration                                 | How it is maintained                       |
| ---------------------- | --------------------------------------------- | ------------------------------------------ |
| Production API         | `deploy/cloudflare/api/wrangler.toml`         | Edit by hand                               |
| Production coordinator | `deploy/cloudflare/coordinator/wrangler.toml` | Edit by hand                               |
| Production probes      | `deploy/cloudflare/wrangler.<region>.toml`    | Generated                                  |
| Staging                | `deploy/cloudflare/staging/`                  | See the [staging guide](staging/README.md) |

The probe generator only owns the root `wrangler.<region>.toml` files. It does
not touch the API, coordinator, or staging configurations.

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

The coordinator starts probe work and report publication as separately leased
jobs. A long probe run does not suppress that minute's report job.

The current publisher:

- caches 89 closed UTC days in R2 and reads the current day from D1;
- invalidates cached days after historical writes through migration `0007`;
- consumes the observation changefeed added by migration `0008`;
- publishes standalone monitors and status pages through the same atomic cohort;
- keeps up to the configured sample limit (5,000 by default) per monitor in eight
  private R2 shards, with a 50,000-row limit per shard; dense shards retain fewer
  newest rows per monitor and expose the actual `sampleLimit` and `sampled` flags;
- bounds compressed and decoded sample objects to 8 MiB each;
- reads at most two sample shards concurrently, draining both reads before
  propagating failure, while parsing and writing shards sequentially;
- rebuilds cold or invalidated histories in bounded batches per shard, combining
  up to five indexed monitor scans per D1 statement while retaining each monitor's
  row limit; recovery uses stored observations and completes in the same run;
- refreshes latency ranges and percentiles at each monitor's configured cadence;
- processes at most 2,000 ordered change events per report job;
- renews the owning report lease at publication boundaries, only while its token
  still owns an unexpired lease, so slow storage reads do not abort progressing work; and
- commits one cohort pointer only after every public object is ready.

The `reports` row in the D1 `jobs` table records duration, statement count, and
native query metrics. Report publication has a 100-statement ceiling.

Disabled publication still maintains the changefeed in batches of at most 2,000
rows. `REPORT_SCHEDULE_DISABLED=true` runs maintenance without claiming the
separate reporter's lease or changing its metrics. A recent consumer retains its
unapplied input: maintenance uses its durable R2 sample cursor, or preserves its
input when R2 is unavailable. After 24 hours without a cohort commit (or the
configured interval plus 120 seconds, if longer), maintenance can discard an
inactive consumer's feed. Live leases and a consumer timestamp check fence the
deletion; sequence gaps force bounded graph bootstrapping when reports resume.

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
Observation inserts, corrections, and deletions mark hours for repair. Workflow
creation starts in the background after the initial report is committed, so it
does not hold the first response open. Latency history remains limited by raw
observation retention: seven days by default in production and 30 days in
staging; aggregates do not extend that history.
