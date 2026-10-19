# Free hosted deployment

> [!IMPORTANT]
> **ARCHITECTURE**: Production and staging both run the Node 24 API and scheduler on a VPS backed by PostgreSQL 18. A reverse proxy on the VPS serves the built web UI. Cloudflare only hosts the regional probe Workers and the test target Worker.
> - For staging operations, see the canonical [VPS staging runbook](../../deploy/vps/staging/README.md).
> - For probe deployment, see the [Cloudflare probe guide](../../deploy/cloudflare/README.md) and [staging probe guide](../../deploy/cloudflare/staging/README.md).

This deployment uses one PostgreSQL database with a `control` schema and a precreated pool of tenant schemas, one R2 bucket for reports, an API service, a scheduler service, and the regional probe Workers. The public capacity is between one and ten. Schema details are in [packages/cloudflare/SCHEMA.md](../../packages/cloudflare/SCHEMA.md).

Build the services and the web UI from the repository root:

```bash
pnpm --filter @uptime/api-worker build:node
pnpm --filter @uptime/coordinator-worker build:node
pnpm --filter @uptime/web build
```

The bundles are `apps/api-worker/dist/node/server.mjs` and `apps/coordinator-worker/dist/node/scheduler.mjs`. The web UI is written to `apps/web/dist`. Build it with `VITE_API_BASE_URL=/api` and `VITE_REPORTS_BASE_URL=/reports` when the reverse proxy serves the UI and the API from one origin. The reverse proxy must set the security headers and cache rules listed in the [VPS staging runbook](../../deploy/vps/staging/README.md#web-ui-and-security-headers).

## Interest check before release

The hosted API and local configs default to `INTEREST_CHECK_ONLY=true`. The landing and signup pages collect verified AT Protocol handles through OAuth with only the `atproto` identity scope. The callback records DID, handle, and timestamps in the control schema's `interest_signups` table. Joining does not allocate a tenant slot. The operator page displays the total and latest 500 signups; the full collection can also be queried from the control schema. No AT Protocol posts, follows, messages, or repository writes are made.

Before deploying an API or scheduler bundle that requires schema changes, follow the migration plan in [`packages/cloudflare/src/postgres/migrations/plan.ts`](../../packages/cloudflare/src/postgres/migrations/plan.ts) and the procedure in the [VPS staging runbook](../../deploy/vps/staging/README.md). Existing operators and test members retain product access, while new interest-only visitors cannot create monitoring workspaces. To release monitoring signup, set `INTEREST_CHECK_ONLY=false` and replace the temporary public interest form with the product signup entry point. Keep the interest collection for the release follow-up.

## Capacity and registration

The tenant pool is a set of PostgreSQL schemas (staging uses `tenant_000` through `tenant_009`, `operator`, `test_001`, and `test_002`) co-located with `control`. Register only schemas that are empty and fully migrated in the control registry. After the interest-only phase, first login automatically reserves an unused slot, writes its tenant identity, and marks the workspace active. Registration remains `waiting_for_capacity` when admission is closed, the forecast reaches $15, or allocation would consume the last available slot. Never manually mark a workspace active before the identity marker is written. A deleted slot remains quarantined; create a fresh schema rather than automatically reusing it.

The operator's Capacity pool shows available, assigned, held, and quarantined slots. Set the public workspace limit between 1 and 10. Lowering the limit stops additional allocations without removing existing workspaces or schemas. Hold and Make available apply only to unused slots; held slots are excluded from automatic allocation. Assigned and quarantined slots cannot be reopened or reassigned through these controls.

Deployed environments reserve at least one enabled, unused slot (`MIN_AVAILABLE_SLOTS=1`). Both allocation and Hold enforce that floor atomically. As a result, a public pool of ten can automatically assign nine while its last slot remains available. The configured limit is an upper bound, not a promise that the reserve can be consumed. Provisioning does not automatically recycle quarantined slots.

Staging schemas are bootstrapped and verified via `scripts/postgres-staging-bootstrap.ts` (see [VPS staging runbook](../../deploy/vps/staging/README.md)).

Activate provisions a waiting workspace through the same identity checks as signup. This explicit operator action may admit an individual while automatic admission is closed or the forecast has reached $15, provided a ready slot and room under the workspace limit exist and the forecast remains below the configured ceiling, at most $20. Resume restores a workspace that the operator suspended. Both actions are audited, and neither changes the automatic admission switch.

## Reports and public access

The reverse proxy forwards `/api/*`, `/oauth/*`, and `/reports/*` to the API, which applies workspace and public-report authorization. The scheduler writes reports to R2 through the S3-compatible API and the API reads them. The reverse proxy has no R2 access.

## Smoke checks

1. Sign in with a real AT Protocol handle and confirm the OAuth callback returns to the configured public origin.
2. Confirm first login allocates exactly one slot when an available slot exists; test the waiting state after closing admission.
3. Verify one scheduler dispatch per minute per active workspace. Deploy the selected regional probes with the same `PROBE_SIGNING_SECRET` as the scheduler before running checks.
4. Create a monitor for any public HTTPS website on port 443; no hostname ownership proof is required. Confirm the workspace's configured region choices and per-monitor region cap, exactly 300-second intervals, 10-second timeout, DNS diagnostics disabled, outage threshold 2, and recovery threshold 1. Private and reserved IP literals and non-443 ports must be rejected. Hostname DNS destinations are not pinned or rechecked, so hostnames resolving to private or reserved addresses are not reliably blocked.
5. In the operator workspace view, change a hosted workspace's monitor quota and allowed regions. Verify the owner and teammates see the effective policy. Attempt a reduction that conflicts with an existing monitor, including a paused monitor, and confirm the API returns a helpful 409 while preserving every monitor and region selection.
6. Confirm `/health` on the API, `/oauth/client-metadata.json` through the reverse proxy, and a public report route carrying `?workspace=WORKSPACE_ID`.
7. Suspend the workspace and verify the scheduler skips its tenant work.

The three probe presets are `wrangler.eu-west.toml`, `wrangler.us-east.toml`, and `wrangler.asia.toml`; all generated production probe presets restrict fetch to public addresses and bound CPU time.

## Local OAuth development

Copy `.env.example` to an ignored `.env` containing freshly generated `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`, and `OAUTH_STORAGE_SECRET`, each at least 32 characters. Optionally set `OPERATOR_DIDS` there. Never store an AT account password in that file or application source.
