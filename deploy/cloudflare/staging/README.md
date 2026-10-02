# Isolated staging deployment

This environment is separate from production. Every Worker, database, bucket,
and Pages project uses the `uptime-staging` namespace.

Run commands from the repository root. Never use the production configs in
`deploy/cloudflare/` for staging work.

On `codex/product-release-plan`, `scripts/deploy-app-workers.sh` and
`scripts/deploy-workers.sh` default to staging and reject production targets,
including `DEPLOY_ENVIRONMENT=production`. On other named branches, select
staging explicitly with `--environment staging`. Detached checkouts cannot deploy
through these scripts.

## Resources

| Resource           | Staging value                                      |
| ------------------ | -------------------------------------------------- |
| Frontend           | <https://uptime-staging.pages.dev>                 |
| Public status page | <https://uptime-staging.pages.dev/status/bsky>     |
| API                | <https://uptime-staging-api.david-8af.workers.dev> |
| D1 database        | `uptime-staging`                                   |
| D1 database ID     | `3900c94a-82a0-4422-a5f8-1a56b781cea7`             |
| R2 bucket          | `uptime-staging-reports`                           |
| API Worker         | `uptime-staging-api`                               |
| Coordinator Worker | `uptime-staging-coordinator`                       |
| Reporter Worker    | `uptime-staging-reporter`                          |
| Probes             | `uptime-staging-probe-{region}`                    |
| Controlled target  | `uptime-staging-target`                            |
| Pages project      | `uptime-staging`                                   |

R2 stays private. The Pages gateway forwards public monitor requests to the
reporter service binding and serves status-page reports from the bucket. It
forwards monitoring APIs to the API Worker through a service binding.

The separate `uptime-staging-oauth-api` Worker stores AT Protocol OAuth sessions
and interest signups in `uptime-staging-control`. The gateway routes OAuth,
interest, identity, and operator APIs to that Worker. The monitoring API verifies
AT Protocol cookies through its `OAUTH` service binding and grants imported
monitoring access only to accounts in `OPERATOR_DIDS`. Interest signups receive no
access to that imported database. Identity checks and operator APIs allocate no
monitoring workspace or tenant slot.

Deploy both backends when changing the identity bridge:

```bash
pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply CONTROL_DB \
  --remote --config ../../deploy/cloudflare/staging/oauth-api/wrangler.toml
pnpm --filter @uptime/api-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/oauth-api/wrangler.toml
scripts/deploy-app-workers.sh --environment staging --target api
```

OAuth secrets belong only on the OAuth Worker. Keep them in Wrangler secret
storage, never in committed code or the Pages build.

## Safety rules

- Use only Wrangler configs below `deploy/cloudflare/staging/`.
- Do not change production Workers, routes, URLs, databases, or buckets.
- Do not change billing settings.
- Keep all notification services disabled.
- Do not copy `.env.staging` or `.env.staging.*.json` into the Pages build.
- Do not run a full `PRAGMA foreign_key_check` against the live imported D1.

The full remote foreign-key scan has exceeded D1 CPU time before. Use the
retained import validation described in
[the import record](../../../docs/staging-import-2026-09-21.md).

## Current data

Staging is an active Workers/D1 deployment. The import counts below record its
original seed and are historical provenance; they change as the deployment
runs. PostgreSQL export, import, and repair tooling is archived and must not be
rerun as part of current staging operations.

Staging contains the PostgreSQL configuration and history imported through
`2026-09-21T16:59:59.999Z`:

- 107 monitors;
- 224 monitor-region pairs;
- one status page with 106 members;
- 1,808,883 imported check runs;
- 2,695,780 imported observations;
- 3,191 imported diagnostics; and
- 9,669 imported daily uptime rows.

The coordinator runs checks every minute. The reporter publishes status-page
snapshots in the background. Individual monitor snapshots are built on request
from hourly aggregates and detailed history retained for 30 days. The reporter's
`MONITOR_SNAPSHOT_FRESH_SECONDS` setting is 120 seconds. A request builds the
initial snapshot and starts a workflow that refreshes it up to four more times
at one-minute intervals. Status-page publication also starts or reuses a
workflow for enabled monitors that are down or recovering. Imported notification
services remain disabled. Daily aggregates are preserved permanently. The
historical protection cutoff was removed on 2026-09-23.

See [the import record](../../../docs/staging-import-2026-09-21.md) for snapshot
boundaries, row counts, digests, and verification evidence.

## 1. Authenticate

```bash
pnpm --filter @uptime/api-worker exec wrangler login
```

Staging credentials are stored in the git-ignored, owner-readable
`.env.staging` and `.env.staging.*.json` files. Never print or commit them.

## 2. Apply D1 migrations

Apply migrations before deploying code that uses the new schema:

```bash
pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply uptime-staging \
  --remote \
  --config ../../deploy/cloudflare/staging/api/wrangler.toml
```

This uses the shared migrations in `packages/cloudflare/src/migrations`.

## 3. Deploy Workers

Deploy the API:

```bash
pnpm --filter @uptime/api-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/api/wrangler.toml
```

Deploy the coordinator:

```bash
pnpm --filter @uptime/coordinator-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/coordinator/wrangler.toml
```

Deploy the reporter, which uses staging D1 and R2 bindings and needs no
secrets:

```bash
pnpm --filter @uptime/coordinator-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/reporter/wrangler.toml
```

Verify the reporter's minute cron before setting
`REPORT_SCHEDULE_DISABLED=true` on the coordinator. This leaves checks on the
coordinator and report publication on the reporter.

Deploy the controlled target when its code changes:

```bash
pnpm --filter @uptime/probe-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/target/wrangler.toml
```

Deploy a probe with its matching staging config. Repeat for each changed region:

```bash
pnpm --filter @uptime/probe-worker exec wrangler deploy \
  --config ../../deploy/cloudflare/staging/probes/wrangler.us-east.toml
```

The API and coordinator need separate staging-only secrets. The coordinator's
`PROBE_SIGNING_SECRET` must match every staging probe.

The coordinator and probes use `global_fetch_strictly_public`. This keeps
Worker-to-Worker requests on their public `workers.dev` URLs.

## 4. Build and deploy Pages

Build with same-origin API routing and the staging report gateway:

```bash
VITE_API_BASE_URL=/api \
VITE_REPORTS_BASE_URL=https://uptime-staging.pages.dev/reports \
  pnpm --filter @uptime/web exec vite build \
    --outDir ../../dist/staging/web \
    --emptyOutDir
cp deploy/cloudflare/staging/pages/_worker.js dist/staging/web/_worker.js
```

Test the gateway before deployment:

```bash
node --test deploy/cloudflare/staging/pages/gateway.test.mjs
```

Deploy to the staging Pages project's configured production branch (`staging`).
The project is isolated from the production `uptime` project. This updates
`uptime-staging.pages.dev`, rather than only a branch preview:

```bash
pnpm --filter @uptime/api-worker exec wrangler pages deploy \
  ../../../../dist/staging/web \
  --cwd "$PWD/deploy/cloudflare/staging/pages" \
  --project-name uptime-staging \
  --branch staging \
  --commit-dirty=true
```

## 5. Verify the deployment

Check each of these before calling the deployment complete:

1. Login, authenticated API access, and logout work through the Pages origin.
2. `/status/bsky` returns HTTP 200 and refreshes to a recent generation.
3. All 107 monitors and all 224 monitor-region pairs remain configured.
4. The status page and index share one generation. Monitor snapshots have
   independent generations and become stale after 120 seconds.
5. Every latency range has a current `computedAt` value.
6. The `coordinator` and `reports` jobs have no retained lease or `lastError`.
7. Notification services are disabled and no staging notification was sent.
8. Production Worker versions, routes, and URLs are unchanged.

Inspect the background jobs with:

```bash
pnpm --filter @uptime/api-worker exec wrangler d1 execute uptime-staging --remote \
  --config ../../deploy/cloudflare/staging/coordinator/wrangler.toml \
  --command "SELECT name, lease_until, last_completed_at, state_json FROM jobs WHERE name IN ('coordinator', 'reports');" \
  --json
```

The publisher commits one immutable generation for status pages and their
index. Monitor snapshots are generated independently from hourly aggregates and
the available detailed history. A request starts a workflow that refreshes the
monitor snapshot up to four more times, one minute apart. Publication also
starts or reuses workflows for enabled monitors that are down or recovering.

Historical note: an earlier staging import used a one-off latency-sample repair
script under `dist/staging/import-postgres/`. That import tooling is archived
and is not part of the active deployment or cache-recovery procedure.

## D1 read troubleshooting

List the most expensive queries from the last two hours:

```bash
pnpm exec wrangler d1 insights uptime-staging \
  --config deploy/cloudflare/staging/coordinator/wrangler.toml \
  --time-period 2h \
  --sort-by reads \
  --limit 10 \
  --json
```

Start with the query that has the highest total reads. Confirm the result with
`meta.rows_read` from a representative execution. The `queryWork` object in each
job's `state_json` records statement counts and native D1 rows read and written.

Keep the one-minute cron running while investigating. Query tuning and
observation do not require billing changes.

## Retained evidence

Detailed migration and deployment evidence lives outside this runbook:

- [staging import record](../../../docs/staging-import-2026-09-21.md);
- [code review](../../../docs/code-review-2026-09-21.md);
- `dist/staging/live-verification.json`; and
- `dist/staging/probe-evidence.json`.

Those files document historical checks. Always repeat the verification section
above after a new deployment.
