# Free hosted deployment

This deployment uses one control D1 database, up to ten statically bound tenant D1 databases, one queue, one R2 bucket, an API Worker, a coordinator Worker, and a Pages gateway. It does not deploy or provision resources automatically.

## Provisioning

1. Create the control database, ten empty tenant databases, the `uptime-tenant-jobs` queue and dead-letter queue, the `uptime-reports` bucket, and a Pages project.
2. Replace every `REPLACE_WITH_*` value in `deploy/cloudflare/hosted/*.wrangler.toml` with the real IDs and origin.
3. Apply control migrations with `pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply CONTROL_DB --remote --config ../../deploy/cloudflare/hosted/api.wrangler.toml`, then apply tenant migrations to each `TENANT_DB_000` through `TENANT_DB_009` using the same config.
4. Set `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, `OAUTH_STORAGE_SECRET`, and `PROBE_SIGNING_SECRET` with `wrangler secret put --config deploy/cloudflare/hosted/{api,coordinator}.wrangler.toml`. Use separate production secrets.
5. Set `OPERATOR_DIDS` to the comma-separated operator DID allowlist. Hosted registration uses AT Protocol OAuth and capacity admission; it does not use `ADMIN_EMAIL` bootstrap credentials.

## Capacity and registration

After migrating each empty tenant database, register its trusted binding name and actual database ID in the control database:

```sql
INSERT INTO tenant_slots(binding_name,database_id,schema_version,status)
VALUES('TENANT_DB_000','THE_ACTUAL_DATABASE_ID',13,'available');
```

Register only databases that are empty, fully migrated, and bound identically to both Workers. First login automatically reserves an unused slot, writes its tenant identity, and marks the workspace active. Registration remains `waiting_for_capacity` when admission is closed, the forecast reaches $15, or all ten slots are assigned. Never manually mark a workspace active before the identity marker is written. A deleted slot remains quarantined; create a fresh database rather than automatically reusing it.

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
pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply TENANT_DB_000 --local --config ../../deploy/cloudflare/hosted/local.wrangler.toml --persist-to ../../.wrangler/hosted-local
pnpm --filter @uptime/api-worker exec wrangler d1 execute CONTROL_DB --local --config ../../deploy/cloudflare/hosted/local.wrangler.toml --persist-to ../../.wrangler/hosted-local --command "INSERT INTO tenant_slots(binding_name,database_id,schema_version,status) VALUES('TENANT_DB_000','00000000-0000-4000-8000-000000000001',13,'available') ON CONFLICT(binding_name) DO NOTHING"
pnpm --filter @uptime/api-worker exec wrangler dev --config ../../deploy/cloudflare/hosted/local.wrangler.toml --persist-to ../../.wrangler/hosted-local --ip 127.0.0.1 --port 8787
```

Start `pnpm --filter @uptime/web dev --host 127.0.0.1` in a second terminal. Open `http://127.0.0.1:5176/signup`. Vite forwards `/api`, `/oauth`, and `/reports` to the local Worker. Use the IP address consistently so the callback cookie stays on the same host.

Local OAuth uses the official virtual `http://localhost/` client ID with an encoded loopback callback and `atproto` scope. Production uses HTTPS metadata at the public origin. No tunnel or password proxy is required. See [the AT Protocol localhost specification](https://atproto.com/specs/oauth#localhost-client-development).

The local smoke test on 2026-10-02 completed provider login, identity-only consent, the callback, automatic tenant allocation, workspace settings, and operator access. The session also survived a Worker restart. The password was entered only on the authorization server and was not saved in repository files. This test does not replace the production-domain smoke checks above.

## Billing and rollback

The API/control and coordinator record measured D1 work in `workspace_usage_daily`. The rolling 31-day forecast includes the $5 baseline and manually configured external costs. Admission pauses at $15; dispatch and queued execution pause at $20. Cleanup continues when dispatch pauses. Configure Cloudflare account alerts at $10, $15, and $20, and review CPU, queue and R2 usage separately. Cloudflare alerts and application forecasts are not a provider hard cap.

To roll back, pause admission and queue consumption, then deploy the prior hosted Worker versions. Keep the control database and tenant identity checks in place; a single-admin build is not a safe fallback for customer traffic. Existing tenant databases and reports remain recoverable. Workspace deletion blocks access immediately, waits for fenced execution leases, and purges data and scoped reports through cron. Keep slots quarantined after deletion. D1 Time Travel can retain recoverable data after live deletion; disclose and test that backup window before public launch.
