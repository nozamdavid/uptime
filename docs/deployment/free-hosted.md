# Free hosted deployment

This deployment uses one control D1 database, a precreated tenant D1 pool, one queue, one R2 bucket, an API Worker, a coordinator Worker, and a Pages gateway. The public capacity is between one and ten. Staging adds three dedicated test databases.

Deploy hosted Workers with `scripts/deploy-hosted-workers.sh`. Before uploading either Worker, it reads the operator's saved capacity, creates missing databases, applies migrations, registers trusted slots, updates both Workers' bindings, and bootstraps the operator workspace. Existing assignments and tenant data are preserved on repeat deployments. This branch defaults to staging and rejects production deployment.

```bash
scripts/deploy-hosted-workers.sh --dry-run
scripts/deploy-hosted-workers.sh
# Explicitly change the saved public capacity and prepare that pool:
scripts/deploy-hosted-workers.sh --capacity 10
```

## Interest check before release

The hosted API and local configs default to `INTEREST_CHECK_ONLY=true`. The landing and signup pages collect verified AT Protocol handles through OAuth with only the `atproto` identity scope. The callback records DID, handle, and timestamps in `CONTROL_DB.interest_signups`. Joining does not allocate a tenant slot. The operator page displays the total and latest 500 signups; the full collection can also be queried from the control database. No AT Protocol posts, follows, messages, or repository writes are made.

Apply all control migrations, including `0002_slot_controls.sql` and `0003_interest_signups.sql`, before deploying the updated API. Existing operators and test members retain product access, while new interest-only visitors cannot create monitoring workspaces. To release monitoring signup, set `INTEREST_CHECK_ONLY=false` and replace the temporary public interest form with the product signup entry point. Keep the interest collection for the release follow-up.

## Provisioning

1. Create the control database, the tenant job queue and dead-letter queue, the reports bucket, and a Pages project. The deployment script creates the tenant databases.
2. Replace every `REPLACE_WITH_*` value in `deploy/cloudflare/hosted/*.wrangler.toml` with the real IDs and origin.
3. Set `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, and `OAUTH_STORAGE_SECRET` on the API Worker. Set the same `CREDENTIAL_ENCRYPTION_SECRET` on the coordinator, and matching `PROBE_SIGNING_SECRET` values on the coordinator and its probes. Use Wrangler secret storage and separate production secrets.
4. Run `scripts/deploy-hosted-workers.sh` for the selected environment. It applies control and tenant migrations, creates and registers the required empty databases, and deploys both Workers. Deploy the probes and Pages with their matching environment configs.
5. `@noz.am` (`did:plc:lmkzmvv6sdxntwtyxpg7fqqq`) is the default operator. A nonempty `OPERATOR_DIDS` allowlist overrides the default. Hosted registration uses AT Protocol OAuth and capacity admission; it does not use `ADMIN_EMAIL` bootstrap credentials.

## Capacity and registration

After migrating each empty tenant database, register its trusted binding name and actual database ID in the control database:

```sql
INSERT INTO tenant_slots(binding_name,database_id,schema_version,status)
VALUES('TENANT_DB_000','THE_ACTUAL_DATABASE_ID',13,'available');
```

The deployment script performs this registration. Register only databases that are empty, fully migrated, and bound identically to both Workers. After the interest-only phase, first login automatically reserves an unused slot, writes its tenant identity, and marks the workspace active. Registration remains `waiting_for_capacity` when admission is closed, the forecast reaches $15, or allocation would consume the last available database. Never manually mark a workspace active before the identity marker is written. A deleted slot remains quarantined; create a fresh database rather than automatically reusing it.

The operator's Capacity pool shows available, assigned, held, and quarantined slots. Set the public workspace limit between 1 and 10. The next hosted deployment precreates databases for that limit. Lowering the limit stops additional allocations without removing existing workspaces or databases. Hold and Make available apply only to unused slots; held slots are excluded from automatic allocation. Assigned and quarantined slots cannot be reopened or reassigned through these controls.

Deployed environments reserve at least one enabled, unused database (`MIN_AVAILABLE_SLOTS=1`). Both allocation and Hold enforce that floor atomically. As a result, a public pool of ten can automatically assign nine while its last database remains available. The configured limit is an upper bound, not a promise that the reserve can be consumed. Provisioning does not automatically recycle quarantined databases.

Staging with capacity ten has thirteen databases: `TENANT_DB_000` through `TENANT_DB_009`, `STAGING_OPERATOR_DB` assigned to @noz.am, and `STAGING_TEST_DB_001` / `STAGING_TEST_DB_002` initially held for later assignment. The three staging slots are outside the public workspace limit. Use Assign workspace on an unused slot to select a verified interest signup and grant that account its own workspace. Explicit assignment can use a held slot, preserves the last available database, and respects the $20 forecast ceiling. Once assigned, the account can use `/app` during the interest-only phase. Test accounts must join the interest list first. No authentication credentials are created or stored by assignment.

Staging also binds its existing imported database as `STAGING_IMPORTED_DB`, a fourteenth slot outside public capacity. Register it with `scripts/register-staging-import.sh --environment staging` and assign it explicitly to an interest signup without an existing workspace. The entire imported fleet and history become that account's workspace. This staging-only exception keeps its original checks, retention, encrypted destination configuration, and root report objects. The hosted queue never schedules or purges it, and workspace deletion is blocked. Suspension blocks workspace access while the legacy staging checks continue. Its legacy scheduler metrics are outside the hosted per-user forecast.

Activate provisions a waiting workspace through the same identity checks as signup. This explicit operator action may admit an individual while automatic admission is closed or the forecast has reached $15, provided a ready slot and room under the workspace limit exist and the forecast remains below the configured ceiling, at most $20. Resume restores a workspace that the operator suspended. Both actions are audited, and neither changes the automatic admission switch.

## Reports and public access

Pages owns `/api/*`, `/oauth/*`, and `/reports/*` service routes. Each route is forwarded to the API Worker, which applies workspace and public-report authorization. Pages has no R2 binding and never reads the global report bucket directly.

## Smoke checks

1. Sign in with a real AT Protocol handle and confirm the OAuth callback returns to the configured Pages origin.
2. Confirm first login allocates exactly one database when an available slot exists; test the waiting state after closing admission.
3. Verify one durable queue dispatch per minute per active workspace. Deploy the selected regional probes with the same `PROBE_SIGNING_SECRET` as the coordinator before running checks.
4. Verify an HTTPS origin by hosting the generated token at `/.well-known/uptime-verification.txt`. Create a monitor and confirm three regions, exactly 300-second intervals, 10-second timeout, DNS diagnostics disabled, outage threshold 2, and recovery threshold 1.
5. Confirm `/health` on the API Worker, `/oauth/client-metadata.json` through Pages, and a public report route carrying `?workspace=WORKSPACE_ID`.
6. Suspend the workspace and verify queued jobs are acknowledged without running tenant work.

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

Run these from the repository root:

```sh
pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply CONTROL_DB --local --config ../../deploy/cloudflare/hosted/local.wrangler.toml --persist-to ../../.wrangler/hosted-local
for slot_number in {0..9}; do
  slot_label=$(printf '%03d' "$slot_number")
  database_suffix=$(printf '%012d' "$((slot_number + 1))")
  pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply "TENANT_DB_${slot_label}" --local --config ../../deploy/cloudflare/hosted/local.wrangler.toml --persist-to ../../.wrangler/hosted-local
  pnpm --filter @uptime/api-worker exec wrangler d1 execute CONTROL_DB --local --config ../../deploy/cloudflare/hosted/local.wrangler.toml --persist-to ../../.wrangler/hosted-local --command "INSERT INTO tenant_slots(binding_name,database_id,schema_version,status) VALUES('TENANT_DB_${slot_label}','00000000-0000-4000-8000-${database_suffix}',13,'available') ON CONFLICT(binding_name) DO NOTHING"
done
pnpm --filter @uptime/api-worker exec wrangler dev --config ../../deploy/cloudflare/hosted/local.wrangler.toml --persist-to ../../.wrangler/hosted-local --ip 127.0.0.1 --port 8787
```

Start `pnpm --filter @uptime/web dev --host 127.0.0.1` in a second terminal. Open `http://127.0.0.1:5176/signup`. Vite forwards `/api`, `/oauth`, and `/reports` to the local Worker. Use the IP address consistently so the callback cookie stays on the same host.

Local development includes ten dedicated database slots, matching the initial cohort limit. New signups become active automatically when a slot and admission budget are available. If capacity is exhausted, the workspace shows waiting rather than suspended. After adding capacity, the operator can use Activate or the owner can reload to retry automatic provisioning. Suspended workspaces require the operator's Resume action.

Local OAuth uses the official virtual `http://localhost/` client ID with an encoded loopback callback and `atproto` scope. Production uses HTTPS metadata at the public origin. No tunnel or password proxy is required. See [the AT Protocol localhost specification](https://atproto.com/specs/oauth#localhost-client-development).

Local smoke tests on 2026-10-02 completed provider login, identity-only consent, callbacks, workspace provisioning, operator access, and session persistence after a Worker restart. The interest-check flow returned to its confirmation page and showed the verified handle in the operator's collection without allocating another tenant slot. Operator activation of a waiting test workspace and holding/reopening an unused slot also passed. The password was entered only on the authorization server and was not saved in repository files. These tests do not replace the production-domain smoke checks above.

## Billing and rollback

The API/control and coordinator record measured D1 work in `workspace_usage_daily`. The rolling 31-day forecast includes the $5 baseline and manually configured external costs. Admission pauses at $15; dispatch and queued execution pause at $20. Cleanup continues when dispatch pauses. Configure Cloudflare account alerts at $10, $15, and $20, and review CPU, queue and R2 usage separately. Cloudflare alerts and application forecasts are not a provider hard cap.

To roll back, pause admission and queue consumption, then deploy the prior hosted Worker versions. Keep the control database and tenant identity checks in place; a single-admin build is not a safe fallback for customer traffic. Existing tenant databases and reports remain recoverable. Workspace deletion blocks access immediately, waits for fenced execution leases, and purges data and scoped reports through cron. Keep slots quarantined after deletion. D1 Time Travel can retain recoverable data after live deletion; disclose and test that backup window before public launch.
