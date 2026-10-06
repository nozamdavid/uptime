# Cloudflare deployment runbook

Run commands from the repository root. The current runtime uses Workers, D1,
R2, and Pages. PostgreSQL and Docker commands in historical migration reports
do not apply to this checkout.

## Configure resources

Use the [deployment guide](../../deploy/cloudflare/README.md) to select the
correct Wrangler files. The API, coordinator, and reporter must bind `DB` to
the same D1 database. The coordinator, reporter, and Pages gateway bind `REPORTS`
to the same private R2 bucket. Pages binds `API` and `REPORTER` to the production
Workers, and the reporter binds `MONITOR_REFRESH` to its production Workflow.
Staging has separate configurations and resources.

Production is `https://uptime-2l5.pages.dev`, backed by D1 `uptime`
(`17c009df-5b56-44cc-9776-73e0f1775b0f`), R2 `uptime-reports`, and Workflow
`uptime-monitor-refresh`. As verified on 2026-10-05, `uptime.noz.am` also routes
to production; staging is at `uptime-staging.pages.dev`. Live Pages bindings now
use the hosted gateway's `IMPORTED_API`, `IMPORTED_REPORTER`, and
`IMPORTED_REPORTS` bindings for this existing monitoring data.

The 2026-10-02 staging snapshot was copied with 107 monitors, 2,147,010 check
runs, and 3,796,804 observations. Historical rows, migrations, admin credentials,
and encrypted provider configurations were retained. Production received new
session/signing secrets; sessions, leases, check-run claims, report pointers,
and notification runtime were reset, and overdue pending deadlines were capped
at cutover. Both notification services remain disabled to avoid duplicate sends.
Private source exports and import checkpoints are in `dist/production/promotion/`.

Required secrets:

| Worker      | Secrets                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| API         | `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET` |
| Coordinator | `PROBE_SIGNING_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`                                 |
| Probes      | `PROBE_SIGNING_SECRET`                                                                 |

Generate the admin password hash with `pnpm hash:admin`. Use the same encryption
secret for the API and coordinator, and the same signing secret for the
coordinator and every regional probe. Keep secret files untracked.

Set `WEB_ORIGIN` to the exact frontend origin and `WORKERS_URL_DOMAIN` to the
probe account suffix. Align `REGIONS_LIST` across the API and coordinator.
Use HTTPS and secure cookies for production.

## Local API development

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm --filter @uptime/api-worker dev
```

Wrangler reads local secrets from `deploy/cloudflare/api/.dev.vars`. In a second
terminal run `pnpm --filter @uptime/web dev`; Vite proxies `/api` to port 8787.
Coordinator development additionally requires its own secrets and bindings;
avoid running local checks against unintended targets or production resources.

## Deploy and verify

```sh
pnpm typecheck
pnpm test
pnpm build
scripts/deploy-app-workers.sh --dry-run
scripts/deploy-workers.sh --dry-run
```

Deploy with `scripts/deploy-app-workers.sh --secrets-file /path/to/app-secrets.env`
and `scripts/deploy-workers.sh --secrets-file /path/to/probe-secrets.env` when
ready. The app script applies remote D1 migrations first. Omitted Worker secrets
remain in place. Deploy the reporter, test target, and Pages gateway using the
[production deployment guide](../../deploy/cloudflare/README.md). Follow the
[staging guide](../../deploy/cloudflare/staging/README.md) only for staging.

Set `VITE_API_BASE_URL=/api` and `VITE_REPORTS_BASE_URL` to the gateway's
`/reports` base URL when building the UI. The gateway resolves status-page
reports through the cohort pointer and forwards standalone monitor reports
to the reporter; a bare R2 bucket domain supports neither route.

After deployment, verify login, a regional check, stored observations,
notification delivery using an intended test destination, and the public
report's generation and freshness. Inspect `jobs.state_json` for work counts,
failures, and durations. Monitor Worker CPU/memory alongside D1 reads/writes.

## Admin credentials and recovery

`ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` bootstrap the first D1 admin; changing
the Worker secrets does not overwrite an existing row. To rotate an existing
admin, generate a new PBKDF2 hash, update the singleton row in D1 through your
authenticated database tooling, invalidate its sessions, and keep bootstrap
secrets aligned. Do not use the removed PostgreSQL reset script or place hashes
and passwords in shell history.

Rollback uses a compatible previous Worker/Pages deployment against the same
D1 schema. Keep D1 backups and check migration compatibility before rollback;
removing runtime source does not delete deployed resources or stored history.

## Verify probe credentials after deployment or rollback

Worker versions include secret bindings. A rollback can restore a signing key
that no longer matches the probes. A fresh report timestamp does not prove that
checks are being collected: inspect each monitor's latest observations and all
nine regional results. `probe_batch_failed` with HTTP 401 indicates rejected
probe authentication, not a target outage.

With the shared key supplied securely through `PROBE_SIGNING_SECRET`, run
`node scripts/verify-probe-auth.mts` after changing probe credentials. It sends
one signed check per region and requires all nine responses to match the request.
Synchronize the coordinator and every production probe together; keep staging
credentials separate. Preserve the active code version when repairing bindings.

On 2026-10-05, production signing credentials were synchronized after `us-east`,
`eu-west`, and `asia` rejected coordinator requests. All nine signed checks then
passed. The coordinator code was preserved from version
`3417ea33-c97f-49b0-90c3-89c0a76b087b` in repaired version
`7ee35344-7dce-4a69-86b1-7eac823bbb04`.

The operator-authorized SQL in
`scripts/backfill-production-monitoring-gap-2026-10.sql` filled 48 wholly missing
daily uptime summaries: 24 monitors on each of October 3 and 4. These rows are
marked `synthetic:operator-green-backfill:2026-10-05`, have 100% assumed uptime,
and contain no invented latency or measured sample counts. Existing summaries,
observations, and the current day's calculated results were preserved. Repeating
the SQL wrote zero rows.

Recovery verification found fresh observations for all 107 enabled monitors by
01:27 UTC, including monitors whose last observation had been October 2. Signed
smoke checks passed in all nine regions, and 20 probe/signing tests passed.
The 01:27:46 UTC public snapshot reported all 106 published monitors up and zero
unknown statuses. AppView and a previously stale US East PDS monitor both served
fresh standalone reports with status up.

## Expired monitor refresh startup recovery

On 2026-10-05 at 07:53 UTC, repeated requests for the production AppView report
returned a snapshot from 01:29 UTC. The gateway forwarded to the correct reporter.
Subsequent requests restarted the demand cycle, and its Workflow steps completed.

Regression tests reproduced a recovery defect: a cached `starting` row bypassed
lease expiry, retried startup, and returned the old snapshot. Both startup
shortcuts now require a live lease. An expired startup falls through to the
existing atomic claim and rebuild, with a new token fencing the abandoned cycle.
Unexpired refreshes still share their current snapshot.

Reporter version `30a21b56-2841-4ef3-9de2-b872da7589a5` deploys only these two
guards on the existing production bundle; bindings and other code are preserved.
The original freshness check passed after deployment with an 08:02:34 UTC
snapshot, 23 seconds old. The browser's stale warning cleared and automatic
refresh advanced. Thirty refresh/publication tests, nine gateway tests, and the
coordinator TypeScript check passed.

## Interrupted monitor requests before Workflow creation

The earlier expired-start fix did not address the initial build's request
lifetime. On 2026-10-05 at 09:27 UTC, repeated `api.bsky.app` report GETs returned
`generatedAt=2026-10-02T15:47:30.054Z`. Reporter logs confirmed these requests
reached the live handler and returned cached data with three reads and no writes.

A controlled reproduction at 09:32 UTC interrupted a GET for
`19c1d5d6-ede7-4564-9d69-4c25fe4dd393` after three seconds. D1 retained
`phase=building`, `ordinal=-1`, a lease ending at `09:35:03.287Z`, and the old
October 2 snapshot. A later state read confirmed the build had stopped, and
Cloudflare returned `instance.not_found` for its token
`facd8e90-2220-48ff-a667-1484ddd3b46a`. A second GET returned the old snapshot.
This reproduces the failure without assuming that every historical request
was interrupted for the same reason.

The GET previously claimed a lease, built the full snapshot inside the HTTP
request, and only then created the Workflow. A disconnected request could stop
between the claim and Workflow creation. Other requests respected the live
180-second claim and continued serving the old snapshot.

GET now claims `starting/-1` and creates a Workflow with `initialInWorkflow`.
The initial snapshot and four subsequent refreshes run in the Workflow. The
request registers startup with `ctx.waitUntil()` before its first database
operation, so disconnecting during claim/creation does not cancel startup.
This short startup stays separate from history generation, which can outlive
the [30-second HTTP background-work limit](https://developers.cloudflare.com/workers/runtime-apis/context/).
Existing snapshots can be served while the Workflow builds; a missing snapshot
returns `503` with `Retry-After: 1`. Legacy live `building` claims remain fenced
until their lease expires, after which a GET starts a replacement cycle.

Reporter version `fb104806-e5ea-4a02-98bd-14b6e1474fda` deployed this module-only
change at 09:41 UTC, preserving the rest of the active bundle and its bindings.
The production cancellation check aborted the only Brittlegill GET after
600 ms. Without any second GET, D1 recorded a new Workflow token and a committed
initial snapshot at `09:41:18.349Z`, within 2.8 seconds of the request starting.
Workflow `66939fef-641d-4d65-b67f-6846a5f640c5` recorded a successful `initial`
step. A UUID-only CDN monitor also refreshed after one GET. Opening Stinkhorn
in the browser started its initial build; the stale warning disappeared on
the existing 60-second automatic poll. The UI may display the previous snapshot
during that first polling interval. A monitor without an existing snapshot
displayed `Report unavailable` until that poll succeeded. The next section
documents the subsequent first-response fix.

The two new startup regressions failed before the fix and passed afterward.
All 29 monitor tests, seven publication-job tests, nine gateway tests, and the
coordinator TypeScript check passed. The runtime and tests were synchronized
to the hosted deployment worktree, preserving unrelated edits.

## Cold monitor first-response recovery

On October 5, the production browser reproduced `Report unavailable` on a cold
PLC Directory visit even though its initial Workflow step succeeded. The GET
returned the expected preparation 503 before a snapshot existed, and the deployed
UI treated that as a report failure until its next 60-second poll.

GET now waits up to 20 seconds for the durable initial snapshot, polling every
500 ms, while preserving the protected Workflow startup. Cold and expired
snapshots normally return their newly committed report in the first response.
The bounded timeout retains the existing cached fallback or retryable 503.
Concurrent claim losers reread the winning state before waiting; an actual
simultaneous-request smoke test exposed this additional race and its regression
test failed before the correction.

Production browser verification used previously cold Cortinarius, plc.wtf, and
Eurosky PDS pages: all returned HTTP 200 on the first report request in 2.8, 3.4,
and 4.2 seconds, respectively, with snapshots only 2–3 seconds old. AppView's
stale report was replaced on its first GET in 6.9 seconds. No preparation error
appeared in these browser runs. A Morel GET aborted after 603 ms still committed
its initial snapshot without a second GET. Cortinarius Workflow
`7e3d2c09-d829-4625-bafe-b9b778baa43c` completed its initial step and all four
subsequent refreshes successfully by 10:30:56 UTC.

The concurrent smoke test initially still saw two early 503s immediately after
deployment. Subsequent batches against five untouched monitors returned 15/15
HTTP 200 responses, each sharing its monitor's newly generated snapshot.

Final reporter version `53daa4bb-f09f-473b-a350-848bfe0193d2` also rereads the
cached body after startup changes the pointer and preserves the wait budget if
a state/body read temporarily returns nothing. Regression tests reproduce both
early-return paths; the exact cause of the two transient production 503s was not
captured. The module-only deployment preserves all other live code and bindings.
The final version passed a virgin Scalycap browser visit in 2.6 seconds with a
two-second-old snapshot. The 37 monitor tests, seven publication-job tests,
51 targeted frontend tests, coordinator typecheck, formatting, and diff checks
passed. The production Eurosky page's automatic poll advanced its observation
timestamp without navigation or manual refresh.
Nine simultaneous first requests across Hollowfoot, Panus, and Lepista also
returned HTTP 200 on the final version in 2.3–3.2 seconds, with a shared fresh
snapshot per monitor. Full coordinator suites passed: 192 root and 216 hosted.

Additional client preparation retries and stale-report recovery are implemented
and tested in both source checkouts, including live-backend browser checks. They
have not been published: the hosted worktree contains unrelated frontend work.
The production first-load correction is deployed in the reporter and works with
the existing frontend.
