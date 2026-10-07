# Free hosted deployment

> [!IMPORTANT]
> **PRODUCTION VS. STAGING ARCHITECTURE**:
> - This document describes the Cloudflare Workers, Cloudflare D1 multi-tenant database pools, queues, and R2 storage architecture used in **production**.
> - **Staging** has migrated its core API and scheduler to Debian 12 VPS `217.217.227.164` backed by PostgreSQL 18. Staging D1 databases are retired.
> - For staging operations, see the canonical [VPS staging runbook](../../deploy/vps/staging/README.md) and [Cloudflare staging guide](../../deploy/cloudflare/staging/README.md).

This deployment uses one control D1 database, a precreated tenant D1 pool, one queue, one R2 bucket, an API Worker, a coordinator Worker, and a Pages gateway. The public capacity is between one and ten.

Deploy hosted Workers with `scripts/deploy-hosted-workers.sh`. For production, it reads the operator's saved capacity, creates missing D1 databases, applies migrations, registers trusted slots, updates both Workers' bindings, and bootstraps the operator workspace. Existing assignments and tenant data are preserved on repeat deployments. For staging, it deploys the VPC proxy Worker and fenced coordinator, skipping D1 setup.

```bash
# Production dry run
scripts/deploy-hosted-workers.sh --environment production --dry-run

# Deploy production hosted workers
scripts/deploy-hosted-workers.sh --environment production

# Explicitly change the saved public capacity and prepare that pool in production:
scripts/deploy-hosted-workers.sh --environment production --capacity 10
```

## Interest check before release

The hosted API and local configs default to `INTEREST_CHECK_ONLY=true`. The landing and signup pages collect verified AT Protocol handles through OAuth with only the `atproto` identity scope. The callback records DID, handle, and timestamps in `CONTROL_DB.interest_signups`. Joining does not allocate a tenant slot. The operator page displays the total and latest 500 signups; the full collection can also be queried from the control database. No AT Protocol posts, follows, messages, or repository writes are made.

Before deploying the updated API and coordinator, apply all control migrations, including `0002_slot_controls.sql`, `0003_interest_signups.sql`, and `0004_workspace_product_limits.sql`, plus tenant migration `0015_workspace_product_limits.sql`. In production, `scripts/deploy-hosted-workers.sh` applies these migrations to the configured databases before uploading either Worker. Existing operators and test members retain product access, while new interest-only visitors cannot create monitoring workspaces. To release monitoring signup, set `INTEREST_CHECK_ONLY=false` and replace the temporary public interest form with the product signup entry point. Keep the interest collection for the release follow-up.

## Production import rollout for uptime.noz.am

The production Pages project is `uptime`; its custom domain is `https://uptime.noz.am`. Keep `INTEREST_CHECK_ONLY=true` and the existing `OPERATOR_DIDS` value. The production `uptime` D1 database is the legacy monitor database and stays at its current migration level. It receives only the singleton `production_workspace_identity` marker, never hosted tenant migrations.

Before applying anything, verify the control D1 ID is `261093f4-98e2-48c8-b84d-932b7f27af7f`, the imported `uptime` D1 ID is `17c009df-5b56-44cc-9776-73e0f1775b0f`, and the existing active @noz.am owner workspace still has its owner membership and assigned empty `TENANT_DB_000`. The adoption helper checks that the old tenant identity matches and has no monitor, service, status-page, check, or history rows. It refuses a different owner, a populated old tenant, or a conflicting marker.

The marker schema is `production_workspace_identity(id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT NOT NULL, database_id TEXT NOT NULL)`. Its single row points to the existing control workspace and the imported `uptime` D1 ID. A pre-existing matching marker is accepted on repeat runs; a mismatch is never replaced.

Start with the read-only adoption check and local Worker config dry runs:

```bash
bash scripts/adopt-production-import.sh --dry-run
pnpm --filter @uptime/api-worker exec wrangler deploy --config ../../deploy/cloudflare/production/legacy-api.wrangler.toml --dry-run
pnpm --filter @uptime/api-worker exec wrangler deploy --config ../../deploy/cloudflare/hosted/api.wrangler.toml --dry-run
pnpm --filter @uptime/coordinator-worker exec wrangler deploy --config ../../deploy/cloudflare/hosted/coordinator.wrangler.toml --dry-run
pnpm --filter @uptime/coordinator-worker exec wrangler deploy --config ../../deploy/cloudflare/production/reporter.wrangler.toml --dry-run
```

After parent signoff, apply pending migrations only to `uptime-control` and the nine currently available empty tenant databases. `TENANT_DB_000` retains its old identity in quarantine, and `uptime` receives no migration:

```bash
pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply uptime-control --remote --config ../../deploy/cloudflare/hosted/api.wrangler.toml
for database in uptime-tenant-001 uptime-tenant-002 uptime-tenant-003 uptime-tenant-004 uptime-tenant-005 uptime-tenant-006 uptime-tenant-007 uptime-tenant-008 uptime-tenant-009; do
  pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply "$database" --remote --config ../../deploy/cloudflare/hosted/api.wrangler.toml
done
```

Deploy the compatible legacy API OAuth bridge, hosted API, and hosted coordinator before adoption, using the same configs that passed dry run. The hosted API recognizes and routes the imported workspace to the legacy service; the hosted coordinator excludes it from tenant dispatch and purge. Both must be live before `PRODUCTION_IMPORTED_DB` is assigned, so older consumers cannot treat the main database as a free tenant. Then apply adoption, deploy the reporter, and publish Pages. The reporter config retains the active `* * * * *` cron and `uptime-monitor-refresh` Workflow. Keep the existing `uptime-coordinator` deployed as the sole legacy check runner; it is not a deployment target and its report schedule remains disabled.

```bash
pnpm --filter @uptime/api-worker exec wrangler deploy --config ../../deploy/cloudflare/production/legacy-api.wrangler.toml
pnpm --filter @uptime/api-worker exec wrangler deploy --config ../../deploy/cloudflare/hosted/api.wrangler.toml
pnpm --filter @uptime/coordinator-worker exec wrangler deploy --config ../../deploy/cloudflare/hosted/coordinator.wrangler.toml
bash scripts/adopt-production-import.sh --apply
pnpm --filter @uptime/coordinator-worker exec wrangler deploy --config ../../deploy/cloudflare/production/reporter.wrangler.toml
VITE_API_BASE_URL=/api VITE_REPORTS_BASE_URL=/reports pnpm --filter @uptime/web build
cp deploy/cloudflare/hosted/_worker.js apps/web/dist/_worker.js
pnpm --filter @uptime/api-worker exec wrangler pages deploy ../../apps/web/dist --project-name uptime --branch main
```

For rollback, keep both identity markers, the main monitor/history rows, and the old tenant metadata. If returning to code that predates imported-workspace routing, acquire the workspace's shared 16-minute execution lease, move `PRODUCTION_IMPORTED_DB` to `status='deleting', workspace_id=NULL`, then restore the same workspace to the quarantined `TENANT_DB_000` row as `assigned`. Verify the control assignment before releasing the lease. Never drop the production marker, purge either database, or make the old tenant available automatically.

## Capacity and registration

After migrating each empty tenant database in production, register its trusted binding name and actual database ID in the control database:

```sql
INSERT INTO tenant_slots(binding_name,database_id,schema_version,status)
VALUES('TENANT_DB_000','THE_ACTUAL_DATABASE_ID',13,'available');
```

The deployment script performs this registration. Register only databases that are empty, fully migrated, and bound identically to both Workers. After the interest-only phase, first login automatically reserves an unused slot, writes its tenant identity, and marks the workspace active. Registration remains `waiting_for_capacity` when admission is closed, the forecast reaches $15, or allocation would consume the last available database. Never manually mark a workspace active before the identity marker is written. A deleted slot remains quarantined; create a fresh database rather than automatically reusing it.

The operator's Capacity pool shows available, assigned, held, and quarantined slots. Set the public workspace limit between 1 and 10. The next hosted deployment precreates databases for that limit. Lowering the limit stops additional allocations without removing existing workspaces or databases. Hold and Make available apply only to unused slots; held slots are excluded from automatic allocation. Assigned and quarantined slots cannot be reopened or reassigned through these controls.

Deployed environments reserve at least one enabled, unused database (`MIN_AVAILABLE_SLOTS=1`). Both allocation and Hold enforce that floor atomically. As a result, a public pool of ten can automatically assign nine while its last database remains available. The configured limit is an upper bound, not a promise that the reserve can be consumed. Provisioning does not automatically recycle quarantined databases.

In staging, the tenant pool is implemented as 13 full-hosted PostgreSQL schemas (`tenant_000` through `tenant_009`, `operator`, `test_001`, `test_002`) co-located with `control` on VPS `217.217.227.164`. Staging schemas are bootstrapped and verified via `scripts/postgres-staging-bootstrap.ts` (see [VPS staging runbook](../../deploy/vps/staging/README.md)). Staging D1 databases are retired.

Activate provisions a waiting workspace through the same identity checks as signup. This explicit operator action may admit an individual while automatic admission is closed or the forecast has reached $15, provided a ready slot and room under the workspace limit exist and the forecast remains below the configured ceiling, at most $20. Resume restores a workspace that the operator suspended. Both actions are audited, and neither changes the automatic admission switch.

## Reports and public access

Pages owns `/api/*`, `/oauth/*`, and `/reports/*` service routes. Each route is forwarded to the API Worker, which applies workspace and public-report authorization. Pages has no R2 binding and never reads the global report bucket directly.

## Smoke checks

1. Sign in with a real AT Protocol handle and confirm the OAuth callback returns to the configured Pages origin.
2. Confirm first login allocates exactly one database when an available slot exists; test the waiting state after closing admission.
3. Verify one durable queue dispatch per minute per active workspace. Deploy the selected regional probes with the same `PROBE_SIGNING_SECRET` as the coordinator before running checks.
4. Create a monitor for any public HTTPS website on port 443; no hostname ownership proof is required. Confirm the workspace's configured region choices and per-monitor region cap, exactly 300-second intervals, 10-second timeout, DNS diagnostics disabled, outage threshold 2, and recovery threshold 1. Private and reserved IP literals and non-443 ports must be rejected. Hostname DNS destinations are not pinned or rechecked, so hostnames resolving to private or reserved addresses are not reliably blocked.
5. In the operator workspace view, change a hosted workspace's monitor quota and allowed regions. Verify the owner and teammates see the effective policy. Attempt a reduction that conflicts with an existing monitor, including a paused monitor, and confirm the API returns a helpful 409 while preserving every monitor and region selection.
6. Confirm `/health` on the API Worker, `/oauth/client-metadata.json` through Pages, and a public report route carrying `?workspace=WORKSPACE_ID`.
7. Suspend the workspace and verify queued jobs are acknowledged without running tenant work.

Build and inspect bundles before any deploy:

```sh
pnpm --filter @uptime/web build
cp deploy/cloudflare/hosted/_worker.js apps/web/dist/_worker.js
pnpm --filter @uptime/api-worker exec wrangler deploy --config ../../deploy/cloudflare/hosted/api.wrangler.toml --dry-run
pnpm --filter @uptime/coordinator-worker exec wrangler deploy --config ../../deploy/cloudflare/hosted/coordinator.wrangler.toml --dry-run
```

Build with `VITE_API_BASE_URL=/api` and `VITE_REPORTS_BASE_URL=/reports` for the same-origin gateway. Publish Pages from `apps/web/dist` after copying its advanced-mode `_worker.js`. Deploy API and coordinator with their hosted configs, then Pages with `pages.wrangler.toml`. The three probe presets are `wrangler.eu-west.toml`, `wrangler.us-east.toml`, and `wrangler.asia.toml`; all generated production probe presets now restrict fetch to public addresses and bound CPU time.

## Local OAuth development

Use the committed `local.wrangler.toml` and an ignored `deploy/cloudflare/hosted/.dev.vars` containing freshly generated `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, and `OAUTH_STORAGE_SECRET`, each at least 32 characters. Optionally set `OPERATOR_DIDS` there. Never store an AT account password in that file or application source.
